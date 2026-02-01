/**
 * SuperMoltWorker Conflict Detector
 *
 * Detects conflicts between R2 backup, Durable Objects state, and container memory.
 * Identifies "past-life memory" issues that can cause moltbot to fail during evolution.
 */

import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { R2_MOUNT_PATH } from '../config';
import { mountR2Storage } from './r2';
import { waitForProcess } from './utils';

/**
 * Types of conflicts that can be detected
 */
export type ConflictType =
  | 'provider_stack'      // Multiple AI providers configured (layered from different sessions)
  | 'auth_mismatch'       // Auth credentials don't match environment
  | 'timestamp_anomaly'   // Local data newer than R2 (shouldn't happen)
  | 'channel_residue'     // Old channel configs without valid tokens
  | 'orphaned_pairing'    // Paired devices without valid config
  | 'config_corruption'   // Config file is malformed
  | 'version_mismatch';   // Snapshot version doesn't match current

export type ConflictSeverity = 'info' | 'warning' | 'error';

/**
 * Individual conflict item
 */
export interface Conflict {
  type: ConflictType;
  severity: ConflictSeverity;
  description: string;
  suggestion: string;
  autoFixAvailable: boolean;
  details?: Record<string, unknown>;
}

/**
 * Complete conflict report
 */
export interface ConflictReport {
  hasConflicts: boolean;
  timestamp: string;
  conflicts: Conflict[];
  recommendations: string[];
  summary: {
    total: number;
    errors: number;
    warnings: number;
    infos: number;
    autoFixable: number;
  };
}

/**
 * Result of auto-fix operation
 */
export interface AutoFixResult {
  success: boolean;
  fixed: string[];
  failed: string[];
  error?: string;
}

const CONFIG_PATH = '/root/.clawdbot/clawdbot.json';
const SKILLS_PATH = '/root/clawd/skills';

/**
 * Run conflict detection
 */
export async function detectConflicts(
  sandbox: Sandbox,
  env: MoltbotEnv
): Promise<ConflictReport> {
  const conflicts: Conflict[] = [];
  const recommendations: string[] = [];

  // Try to mount R2 for comparison
  const r2Mounted = await mountR2Storage(sandbox, env);

  // Load current config
  let currentConfig: Record<string, unknown> | null = null;
  try {
    const proc = await sandbox.startProcess(`cat ${CONFIG_PATH} 2>/dev/null || echo "{}"`);
    await waitForProcess(proc, 5000);
    const logs = await proc.getLogs();
    if (logs.stdout && logs.stdout.trim() !== '{}') {
      currentConfig = JSON.parse(logs.stdout);
    }
  } catch {
    conflicts.push({
      type: 'config_corruption',
      severity: 'error',
      description: 'Configuration file is corrupted or unreadable',
      suggestion: 'Restore from a snapshot or reset configuration',
      autoFixAvailable: true,
    });
  }

  if (currentConfig) {
    // Check for provider stacking
    const providerConflict = checkProviderStack(currentConfig, env);
    if (providerConflict) {
      conflicts.push(providerConflict);
      recommendations.push('Consider resetting to a clean configuration with only one AI provider');
    }

    // Check for auth mismatches
    const authConflict = checkAuthMismatch(currentConfig, env);
    if (authConflict) {
      conflicts.push(authConflict);
    }

    // Check for channel residue
    const channelConflicts = checkChannelResidue(currentConfig, env);
    conflicts.push(...channelConflicts);

    // Check for orphaned gateway auth
    const gatewayConflict = checkGatewayAuth(currentConfig, env);
    if (gatewayConflict) {
      conflicts.push(gatewayConflict);
    }
  }

  // Check R2 vs local timestamp
  if (r2Mounted) {
    const timestampConflict = await checkTimestampAnomaly(sandbox);
    if (timestampConflict) {
      conflicts.push(timestampConflict);
      recommendations.push('Run a sync to R2 to update the backup');
    }
  }

  // Generate summary
  const summary = {
    total: conflicts.length,
    errors: conflicts.filter(c => c.severity === 'error').length,
    warnings: conflicts.filter(c => c.severity === 'warning').length,
    infos: conflicts.filter(c => c.severity === 'info').length,
    autoFixable: conflicts.filter(c => c.autoFixAvailable).length,
  };

  // Add general recommendations
  if (summary.errors > 0) {
    recommendations.unshift('Critical issues detected - consider restoring from a known-good snapshot');
  }

  if (summary.autoFixable > 0 && summary.errors === 0) {
    recommendations.push(`${summary.autoFixable} issue(s) can be automatically fixed`);
  }

  return {
    hasConflicts: conflicts.length > 0,
    timestamp: new Date().toISOString(),
    conflicts,
    recommendations,
    summary,
  };
}

/**
 * Check for provider stacking (multiple AI providers configured)
 */
function checkProviderStack(
  config: Record<string, unknown>,
  env: MoltbotEnv
): Conflict | null {
  const models = config.models as Record<string, unknown> | undefined;
  const providers = models?.providers as Record<string, unknown> | undefined;

  if (!providers) return null;

  const configuredProviders = Object.keys(providers);
  if (configuredProviders.length <= 1) return null;

  // Check which provider the environment wants
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const envAny = env as any;
  const baseUrl = envAny.AI_GATEWAY_BASE_URL || envAny.ANTHROPIC_BASE_URL || '';
  const wantsOpenAI = baseUrl.endsWith('/openai');
  const wantsAnthropic = !wantsOpenAI && (baseUrl.endsWith('/anthropic') || envAny.ANTHROPIC_API_KEY);

  const hasOpenAI = 'openai' in providers;
  const hasAnthropic = 'anthropic' in providers;

  // Conflict: has both providers but env suggests one
  if (hasOpenAI && hasAnthropic) {
    const unwantedProvider = wantsOpenAI ? 'anthropic' : 'openai';
    return {
      type: 'provider_stack',
      severity: 'warning',
      description: `Multiple AI providers configured: ${configuredProviders.join(', ')}. Environment suggests using ${wantsOpenAI ? 'OpenAI' : 'Anthropic'}.`,
      suggestion: `Remove the ${unwantedProvider} provider configuration to avoid conflicts`,
      autoFixAvailable: true,
      details: {
        configuredProviders,
        environmentProvider: wantsOpenAI ? 'openai' : 'anthropic',
      },
    };
  }

  return null;
}

/**
 * Check for authentication mismatches
 */
function checkAuthMismatch(
  config: Record<string, unknown>,
  env: MoltbotEnv
): Conflict | null {
  const gateway = config.gateway as Record<string, unknown> | undefined;
  const auth = gateway?.auth as Record<string, unknown> | undefined;
  const configToken = auth?.token as string | undefined;

  if (!configToken && !env.MOLTBOT_GATEWAY_TOKEN) {
    return null; // Both empty, no conflict
  }

  if (configToken && env.MOLTBOT_GATEWAY_TOKEN && configToken !== env.MOLTBOT_GATEWAY_TOKEN) {
    return {
      type: 'auth_mismatch',
      severity: 'error',
      description: 'Gateway token in config does not match environment variable',
      suggestion: 'The configuration will be updated on next startup to use the environment token',
      autoFixAvailable: true,
      details: {
        configHasToken: !!configToken,
        envHasToken: !!env.MOLTBOT_GATEWAY_TOKEN,
      },
    };
  }

  return null;
}

/**
 * Check for channel configuration residue
 *
 * IMPORTANT: A channel config with a valid token is NOT residue, even if no env var exists.
 * This is because users can set tokens via chat interface (stored in clawdbot.json).
 *
 * True "residue" is when:
 * - Channel config exists but has NO token (empty or missing)
 * - OR channel is disabled but config still exists
 *
 * If a valid token exists in clawdbot.json but not in env vars, that's just
 * "unsynced to environment variables" - not a conflict. This should be shown
 * in the Settings Sync page, not as a conflict.
 */
function checkChannelResidue(
  config: Record<string, unknown>,
  env: MoltbotEnv
): Conflict[] {
  const conflicts: Conflict[] = [];
  const channels = config.channels as Record<string, unknown> | undefined;

  if (!channels) return conflicts;

  // Check Telegram
  const telegram = channels.telegram as Record<string, unknown> | undefined;
  if (telegram) {
    const hasValidToken = !!telegram.botToken && String(telegram.botToken).length > 10;
    const hasEnvToken = !!env.TELEGRAM_BOT_TOKEN;

    // Only flag as residue if config exists but NO valid token anywhere
    if (!hasValidToken && !hasEnvToken) {
      conflicts.push({
        type: 'channel_residue',
        severity: 'warning',
        description: 'Telegram channel configured but no valid bot token found',
        suggestion: 'Set up Telegram bot token via chat or remove the channel config',
        autoFixAvailable: true,
        details: { channel: 'telegram', hasConfig: true, hasToken: false },
      });
    }
    // If tokens differ between config and env, that's a potential issue
    else if (hasValidToken && hasEnvToken && telegram.botToken !== env.TELEGRAM_BOT_TOKEN) {
      conflicts.push({
        type: 'channel_residue',
        severity: 'warning',
        description: 'Telegram token in config differs from environment variable',
        suggestion: 'The environment variable will take precedence on restart',
        autoFixAvailable: false, // Don't auto-fix, user needs to decide which to keep
        details: { channel: 'telegram', hasConfig: true, hasEnvToken: true, tokenMismatch: true },
      });
    }
    // If valid token in config but not in env → NOT a conflict, just unsynced
    // This will be shown in Settings Sync page instead
  }

  // Check Discord
  const discord = channels.discord as Record<string, unknown> | undefined;
  if (discord) {
    const hasValidToken = !!discord.token && String(discord.token).length > 10;
    const hasEnvToken = !!env.DISCORD_BOT_TOKEN;

    if (!hasValidToken && !hasEnvToken) {
      conflicts.push({
        type: 'channel_residue',
        severity: 'warning',
        description: 'Discord channel configured but no valid bot token found',
        suggestion: 'Set up Discord bot token via chat or remove the channel config',
        autoFixAvailable: true,
        details: { channel: 'discord', hasConfig: true, hasToken: false },
      });
    }
  }

  // Check Slack
  const slack = channels.slack as Record<string, unknown> | undefined;
  if (slack) {
    const hasValidToken = !!slack.botToken && String(slack.botToken).length > 10;
    const hasEnvToken = !!env.SLACK_BOT_TOKEN;

    if (!hasValidToken && !hasEnvToken) {
      conflicts.push({
        type: 'channel_residue',
        severity: 'warning',
        description: 'Slack channel configured but no valid bot token found',
        suggestion: 'Set up Slack bot token via chat or remove the channel config',
        autoFixAvailable: true,
        details: { channel: 'slack', hasConfig: true, hasToken: false },
      });
    }
  }

  return conflicts;
}

/**
 * Check gateway auth configuration
 */
function checkGatewayAuth(
  config: Record<string, unknown>,
  env: MoltbotEnv
): Conflict | null {
  const gateway = config.gateway as Record<string, unknown> | undefined;

  // Check for insecure auth in non-dev mode
  const controlUi = gateway?.controlUi as Record<string, unknown> | undefined;
  if (controlUi?.allowInsecureAuth && env.DEV_MODE !== 'true') {
    return {
      type: 'auth_mismatch',
      severity: 'warning',
      description: 'allowInsecureAuth is enabled but DEV_MODE is not set',
      suggestion: 'Either enable DEV_MODE or remove allowInsecureAuth for production',
      autoFixAvailable: true,
    };
  }

  return null;
}

/**
 * Check for timestamp anomalies between local and R2
 */
async function checkTimestampAnomaly(sandbox: Sandbox): Promise<Conflict | null> {
  try {
    const localSyncPath = '/root/.clawdbot/.last-sync';
    const r2SyncPath = `${R2_MOUNT_PATH}/.last-sync`;

    // Get both timestamps
    const proc = await sandbox.startProcess(
      `echo "LOCAL:$(cat ${localSyncPath} 2>/dev/null || echo '')" && echo "R2:$(cat ${r2SyncPath} 2>/dev/null || echo '')"`
    );
    await waitForProcess(proc, 5000);
    const logs = await proc.getLogs();

    const lines = logs.stdout?.split('\n') || [];
    let localTime = '';
    let r2Time = '';

    for (const line of lines) {
      if (line.startsWith('LOCAL:')) localTime = line.substring(6).trim();
      if (line.startsWith('R2:')) r2Time = line.substring(3).trim();
    }

    if (!localTime || !r2Time) return null;

    const localDate = new Date(localTime);
    const r2Date = new Date(r2Time);

    // If local is significantly newer than R2, that's an anomaly
    // (R2 should always be >= local after a sync)
    const diffMs = localDate.getTime() - r2Date.getTime();
    if (diffMs > 60000) { // More than 1 minute newer
      return {
        type: 'timestamp_anomaly',
        severity: 'info',
        description: `Local data is ${Math.round(diffMs / 1000)}s newer than R2 backup`,
        suggestion: 'Run a backup sync to update R2',
        autoFixAvailable: false,
        details: {
          localTime,
          r2Time,
          diffSeconds: Math.round(diffMs / 1000),
        },
      };
    }
  } catch {
    // Ignore errors in timestamp check
  }

  return null;
}

/**
 * Attempt to auto-fix detected conflicts
 */
export async function autoFixConflicts(
  sandbox: Sandbox,
  env: MoltbotEnv,
  report: ConflictReport
): Promise<AutoFixResult> {
  const fixed: string[] = [];
  const failed: string[] = [];

  const fixableConflicts = report.conflicts.filter(c => c.autoFixAvailable);

  for (const conflict of fixableConflicts) {
    try {
      switch (conflict.type) {
        case 'provider_stack': {
          // Remove unwanted provider from config
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const envAny2 = env as any;
          const baseUrl = envAny2.AI_GATEWAY_BASE_URL || envAny2.ANTHROPIC_BASE_URL || '';
          const wantsOpenAI = baseUrl.endsWith('/openai');
          const providerToRemove = wantsOpenAI ? 'anthropic' : 'openai';

          const proc = await sandbox.startProcess(`
            node -e "
              const fs = require('fs');
              const config = JSON.parse(fs.readFileSync('${CONFIG_PATH}', 'utf8'));
              if (config.models?.providers?.${providerToRemove}) {
                delete config.models.providers.${providerToRemove};
                fs.writeFileSync('${CONFIG_PATH}', JSON.stringify(config, null, 2));
                console.log('Removed ${providerToRemove} provider');
              }
            "
          `);
          await waitForProcess(proc, 5000);
          fixed.push(`Removed ${providerToRemove} provider configuration`);
          break;
        }

        case 'channel_residue': {
          const channel = conflict.details?.channel as string;
          if (channel) {
            const proc = await sandbox.startProcess(`
              node -e "
                const fs = require('fs');
                const config = JSON.parse(fs.readFileSync('${CONFIG_PATH}', 'utf8'));
                if (config.channels?.${channel}) {
                  delete config.channels.${channel};
                  fs.writeFileSync('${CONFIG_PATH}', JSON.stringify(config, null, 2));
                  console.log('Removed ${channel} channel config');
                }
              "
            `);
            await waitForProcess(proc, 5000);
            fixed.push(`Removed orphaned ${channel} channel configuration`);
          }
          break;
        }

        case 'config_corruption': {
          // Reset to minimal config
          const minimalConfig = {
            agents: { defaults: { workspace: '/root/clawd' } },
            gateway: { port: 18789, mode: 'local' },
            channels: {},
          };
          const proc = await sandbox.startProcess(
            `echo '${JSON.stringify(minimalConfig, null, 2)}' > ${CONFIG_PATH}`
          );
          await waitForProcess(proc, 5000);
          fixed.push('Reset configuration to minimal defaults');
          break;
        }

        default:
          // Skip non-implemented fixes
          break;
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      failed.push(`${conflict.type}: ${errorMessage}`);
    }
  }

  return {
    success: failed.length === 0,
    fixed,
    failed,
    error: failed.length > 0 ? `Failed to fix ${failed.length} conflict(s)` : undefined,
  };
}
