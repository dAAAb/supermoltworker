/**
 * SuperMoltWorker Health Check System
 *
 * Monitors the health of moltbot configuration and runtime state.
 * Provides self-healing capabilities for common issues.
 */

import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { R2_MOUNT_PATH, MOLTBOT_PORT } from '../config';
import { mountR2Storage } from './r2';
import { findExistingMoltbotProcess } from './process';
import { waitForProcess } from './utils';

/**
 * Health status levels
 */
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

/**
 * Individual health check result
 */
export interface HealthCheckItem {
  name: string;
  status: HealthStatus;
  message: string;
  details?: Record<string, unknown>;
  canRepair?: boolean;
}

/**
 * Health issue requiring attention
 */
export interface HealthIssue {
  check: string;
  severity: 'warning' | 'error';
  description: string;
  suggestion: string;
  autoRepairAvailable: boolean;
}

/**
 * Complete health report
 */
export interface HealthReport {
  overall: HealthStatus;
  timestamp: string;
  checks: {
    configValid: HealthCheckItem;
    providerConfigured: HealthCheckItem;
    r2Connected: HealthCheckItem;
    gatewayResponding: HealthCheckItem;
    skillsAccessible: HealthCheckItem;
  };
  issues: HealthIssue[];
  autoRepairAvailable: boolean;
}

/**
 * Repair result
 */
export interface RepairResult {
  success: boolean;
  repaired: string[];
  failed: string[];
  error?: string;
}

/**
 * Critical alert for missing configuration
 * Used to show prominent warnings in the UI
 */
export interface CriticalAlert {
  type: 'missing_api_key' | 'missing_gateway_token' | 'r2_not_configured';
  severity: 'error' | 'warning';
  title: string;
  message: string;
  action: string;
  actionCommand?: string;
}

const CONFIG_PATH = '/root/.clawdbot/clawdbot.json';
const SKILLS_PATH = '/root/clawd/skills';

/**
 * Check for critical alerts that should be prominently displayed to users.
 * These are issues that will prevent the assistant from functioning properly.
 *
 * @param env - Worker environment bindings
 * @returns Array of critical alerts
 */
export function getCriticalAlerts(env: MoltbotEnv): CriticalAlert[] {
  const alerts: CriticalAlert[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const envAny = env as any;

  // Check for missing AI provider API key
  const hasAnthropicKey = !!envAny.ANTHROPIC_API_KEY;
  const hasAIGatewayKey = !!envAny.AI_GATEWAY_API_KEY;
  const hasOpenAIKey = !!envAny.OPENAI_API_KEY;

  if (!hasAnthropicKey && !hasAIGatewayKey && !hasOpenAIKey) {
    alerts.push({
      type: 'missing_api_key',
      severity: 'error',
      title: 'AI Provider Not Configured',
      message:
        'No AI provider API key is set. The assistant cannot respond to messages without an API key. ' +
        'Please set ANTHROPIC_API_KEY, AI_GATEWAY_API_KEY, or OPENAI_API_KEY in Cloudflare Secrets.',
      action: 'Set API Key',
      actionCommand: 'npx wrangler secret put ANTHROPIC_API_KEY',
    });
  }

  // Check for missing gateway token
  if (!envAny.MOLTBOT_GATEWAY_TOKEN) {
    alerts.push({
      type: 'missing_gateway_token',
      severity: 'warning',
      title: 'Gateway Token Not Set',
      message:
        'The gateway authentication token is not configured. This is required for secure access to the Control UI.',
      action: 'Set Gateway Token',
      actionCommand: 'npx wrangler secret put MOLTBOT_GATEWAY_TOKEN',
    });
  }

  // Check for missing R2 configuration
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    alerts.push({
      type: 'r2_not_configured',
      severity: 'warning',
      title: 'Persistent Storage Not Configured',
      message:
        'R2 storage is not configured. Your conversations and settings will be lost when the container restarts. ' +
        'Configure R2 for persistent storage.',
      action: 'Configure R2',
    });
  }

  return alerts;
}

/**
 * Run a quick health check (fast, minimal checks)
 */
export async function quickHealthCheck(
  sandbox: Sandbox,
  env: MoltbotEnv
): Promise<{ status: HealthStatus; message: string }> {
  // Check if gateway is responding
  const process = await findExistingMoltbotProcess(sandbox);
  if (!process || process.status !== 'running') {
    return { status: 'unhealthy', message: 'Gateway not running' };
  }

  // Check config exists
  try {
    const proc = await sandbox.startProcess(`test -f ${CONFIG_PATH} && echo "ok"`);
    await waitForProcess(proc, 3000);
    const logs = await proc.getLogs();
    if (!logs.stdout?.includes('ok')) {
      return { status: 'degraded', message: 'Configuration file missing' };
    }
  } catch {
    return { status: 'degraded', message: 'Cannot access configuration' };
  }

  return { status: 'healthy', message: 'All systems operational' };
}

/**
 * Run a full health check
 */
export async function fullHealthCheck(
  sandbox: Sandbox,
  env: MoltbotEnv
): Promise<HealthReport> {
  const issues: HealthIssue[] = [];

  // Check 1: Config validity
  const configCheck = await checkConfigValid(sandbox);
  if (configCheck.status !== 'healthy') {
    issues.push({
      check: 'configValid',
      severity: configCheck.status === 'unhealthy' ? 'error' : 'warning',
      description: configCheck.message,
      suggestion: 'Reset configuration or restore from snapshot',
      autoRepairAvailable: true,
    });
  }

  // Check 2: Provider configured
  const providerCheck = await checkProviderConfigured(sandbox, env);
  if (providerCheck.status !== 'healthy') {
    issues.push({
      check: 'providerConfigured',
      severity: 'error',
      description: providerCheck.message,
      suggestion: 'Set ANTHROPIC_API_KEY or AI_GATEWAY_API_KEY environment variable',
      autoRepairAvailable: false,
    });
  }

  // Check 3: R2 connection
  const r2Check = await checkR2Connected(sandbox, env);
  if (r2Check.status !== 'healthy') {
    issues.push({
      check: 'r2Connected',
      severity: r2Check.status === 'unhealthy' ? 'error' : 'warning',
      description: r2Check.message,
      suggestion: 'Configure R2 credentials for persistent storage',
      autoRepairAvailable: false,
    });
  }

  // Check 4: Gateway responding
  const gatewayCheck = await checkGatewayResponding(sandbox);
  if (gatewayCheck.status !== 'healthy') {
    issues.push({
      check: 'gatewayResponding',
      severity: 'error',
      description: gatewayCheck.message,
      suggestion: 'Restart the gateway',
      autoRepairAvailable: true,
    });
  }

  // Check 5: Skills accessible
  const skillsCheck = await checkSkillsAccessible(sandbox);
  if (skillsCheck.status !== 'healthy') {
    issues.push({
      check: 'skillsAccessible',
      severity: 'warning',
      description: skillsCheck.message,
      suggestion: 'Create skills directory or restore from backup',
      autoRepairAvailable: true,
    });
  }

  // Determine overall status
  let overall: HealthStatus = 'healthy';
  if (issues.some(i => i.severity === 'error')) {
    overall = 'unhealthy';
  } else if (issues.length > 0) {
    overall = 'degraded';
  }

  return {
    overall,
    timestamp: new Date().toISOString(),
    checks: {
      configValid: configCheck,
      providerConfigured: providerCheck,
      r2Connected: r2Check,
      gatewayResponding: gatewayCheck,
      skillsAccessible: skillsCheck,
    },
    issues,
    autoRepairAvailable: issues.some(i => i.autoRepairAvailable),
  };
}

/**
 * Check if config file is valid JSON
 */
async function checkConfigValid(sandbox: Sandbox): Promise<HealthCheckItem> {
  try {
    const proc = await sandbox.startProcess(`cat ${CONFIG_PATH} 2>/dev/null`);
    await waitForProcess(proc, 5000);
    const logs = await proc.getLogs();

    if (!logs.stdout) {
      return {
        name: 'configValid',
        status: 'unhealthy',
        message: 'Configuration file not found',
        canRepair: true,
      };
    }

    try {
      const config = JSON.parse(logs.stdout);

      // Check required fields
      if (!config.gateway) {
        return {
          name: 'configValid',
          status: 'degraded',
          message: 'Configuration missing gateway section',
          canRepair: true,
        };
      }

      return {
        name: 'configValid',
        status: 'healthy',
        message: 'Configuration is valid',
        details: {
          hasAgents: !!config.agents,
          hasGateway: !!config.gateway,
          hasChannels: !!config.channels,
          hasModels: !!config.models,
        },
      };
    } catch {
      return {
        name: 'configValid',
        status: 'unhealthy',
        message: 'Configuration file contains invalid JSON',
        canRepair: true,
      };
    }
  } catch (err) {
    return {
      name: 'configValid',
      status: 'unhealthy',
      message: `Cannot read configuration: ${err instanceof Error ? err.message : String(err)}`,
      canRepair: true,
    };
  }
}

/**
 * Check if AI provider is configured
 */
async function checkProviderConfigured(
  sandbox: Sandbox,
  env: MoltbotEnv
): Promise<HealthCheckItem> {
  // Check environment variables
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const envAny = env as any;
  const hasAnthropicKey = !!envAny.ANTHROPIC_API_KEY;
  const hasAIGatewayKey = !!envAny.AI_GATEWAY_API_KEY;
  const hasOpenAIKey = !!envAny.OPENAI_API_KEY;

  if (!hasAnthropicKey && !hasAIGatewayKey && !hasOpenAIKey) {
    return {
      name: 'providerConfigured',
      status: 'unhealthy',
      message: 'No AI provider API key configured',
      details: {
        hasAnthropicKey,
        hasAIGatewayKey,
        hasOpenAIKey,
      },
    };
  }

  // Check if config has provider settings
  try {
    const proc = await sandbox.startProcess(`cat ${CONFIG_PATH} 2>/dev/null`);
    await waitForProcess(proc, 5000);
    const logs = await proc.getLogs();

    if (logs.stdout) {
      const config = JSON.parse(logs.stdout);
      const providers = config.models?.providers || {};
      const providerCount = Object.keys(providers).length;

      if (providerCount === 0 && !hasAnthropicKey) {
        return {
          name: 'providerConfigured',
          status: 'degraded',
          message: 'No custom providers configured and using default Anthropic catalog',
        };
      }

      return {
        name: 'providerConfigured',
        status: 'healthy',
        message: `AI provider configured (${providerCount} custom provider(s))`,
        details: {
          customProviders: Object.keys(providers),
          envProviders: {
            anthropic: hasAnthropicKey,
            aiGateway: hasAIGatewayKey,
            openai: hasOpenAIKey,
          },
        },
      };
    }
  } catch {
    // Ignore parse errors, check passed based on env vars
  }

  return {
    name: 'providerConfigured',
    status: 'healthy',
    message: 'AI provider API key available',
  };
}

/**
 * Check if R2 storage is connected
 */
async function checkR2Connected(
  sandbox: Sandbox,
  env: MoltbotEnv
): Promise<HealthCheckItem> {
  const hasCredentials = !!(
    env.R2_ACCESS_KEY_ID &&
    env.R2_SECRET_ACCESS_KEY &&
    env.CF_ACCOUNT_ID
  );

  if (!hasCredentials) {
    return {
      name: 'r2Connected',
      status: 'degraded',
      message: 'R2 credentials not configured - data will not persist',
      details: {
        hasAccessKeyId: !!env.R2_ACCESS_KEY_ID,
        hasSecretKey: !!env.R2_SECRET_ACCESS_KEY,
        hasAccountId: !!env.CF_ACCOUNT_ID,
      },
    };
  }

  // Try to mount and check
  const mounted = await mountR2Storage(sandbox, env);
  if (!mounted) {
    return {
      name: 'r2Connected',
      status: 'unhealthy',
      message: 'R2 credentials configured but mount failed',
    };
  }

  // Check if we can read from R2
  try {
    const proc = await sandbox.startProcess(`ls -la ${R2_MOUNT_PATH} 2>/dev/null | head -5`);
    await waitForProcess(proc, 5000);
    const logs = await proc.getLogs();

    if (logs.stdout) {
      return {
        name: 'r2Connected',
        status: 'healthy',
        message: 'R2 storage connected and accessible',
      };
    }
  } catch {
    // Mount succeeded but can't list
  }

  return {
    name: 'r2Connected',
    status: 'degraded',
    message: 'R2 mounted but may not be fully accessible',
  };
}

/**
 * Check if gateway is responding
 */
async function checkGatewayResponding(sandbox: Sandbox): Promise<HealthCheckItem> {
  const process = await findExistingMoltbotProcess(sandbox);

  if (!process) {
    return {
      name: 'gatewayResponding',
      status: 'unhealthy',
      message: 'Gateway process not found',
      canRepair: true,
    };
  }

  if (process.status !== 'running') {
    return {
      name: 'gatewayResponding',
      status: 'unhealthy',
      message: `Gateway process is ${process.status}`,
      canRepair: true,
    };
  }

  // Try to reach the gateway
  try {
    const proc = await sandbox.startProcess(
      `curl -s -o /dev/null -w "%{http_code}" http://localhost:${MOLTBOT_PORT}/health 2>/dev/null || echo "000"`
    );
    await waitForProcess(proc, 5000);
    const logs = await proc.getLogs();
    const statusCode = logs.stdout?.trim() || '000';

    if (statusCode === '200' || statusCode === '204') {
      return {
        name: 'gatewayResponding',
        status: 'healthy',
        message: 'Gateway is responding',
        details: { statusCode },
      };
    }

    if (statusCode === '000') {
      return {
        name: 'gatewayResponding',
        status: 'degraded',
        message: 'Gateway process running but not responding to HTTP',
        details: { statusCode },
        canRepair: true,
      };
    }

    return {
      name: 'gatewayResponding',
      status: 'degraded',
      message: `Gateway responding with status ${statusCode}`,
      details: { statusCode },
    };
  } catch {
    return {
      name: 'gatewayResponding',
      status: 'degraded',
      message: 'Cannot determine gateway status',
      canRepair: true,
    };
  }
}

/**
 * Check if skills directory is accessible
 */
async function checkSkillsAccessible(sandbox: Sandbox): Promise<HealthCheckItem> {
  try {
    const proc = await sandbox.startProcess(
      `test -d ${SKILLS_PATH} && ls ${SKILLS_PATH} 2>/dev/null | wc -l`
    );
    await waitForProcess(proc, 5000);
    const logs = await proc.getLogs();

    if (proc.exitCode !== 0) {
      return {
        name: 'skillsAccessible',
        status: 'degraded',
        message: 'Skills directory does not exist',
        canRepair: true,
      };
    }

    const count = parseInt(logs.stdout?.trim() || '0', 10);
    return {
      name: 'skillsAccessible',
      status: 'healthy',
      message: `Skills directory accessible (${count} skill(s))`,
      details: { skillCount: count },
    };
  } catch {
    return {
      name: 'skillsAccessible',
      status: 'degraded',
      message: 'Cannot access skills directory',
      canRepair: true,
    };
  }
}

/**
 * Attempt to repair detected health issues
 */
export async function repairHealthIssues(
  sandbox: Sandbox,
  env: MoltbotEnv,
  report: HealthReport
): Promise<RepairResult> {
  const repaired: string[] = [];
  const failed: string[] = [];

  for (const issue of report.issues) {
    if (!issue.autoRepairAvailable) continue;

    try {
      switch (issue.check) {
        case 'configValid': {
          // Reset to minimal config
          const minimalConfig = {
            agents: { defaults: { workspace: '/root/clawd' } },
            gateway: { port: 18789, mode: 'local' },
            channels: {},
          };
          const proc = await sandbox.startProcess(
            `mkdir -p /root/.clawdbot && echo '${JSON.stringify(minimalConfig, null, 2)}' > ${CONFIG_PATH}`
          );
          await waitForProcess(proc, 5000);
          repaired.push('Reset configuration to minimal defaults');
          break;
        }

        case 'gatewayResponding': {
          // This requires restarting the gateway - just note it
          failed.push('Gateway restart requires admin action');
          break;
        }

        case 'skillsAccessible': {
          const proc = await sandbox.startProcess(`mkdir -p ${SKILLS_PATH}`);
          await waitForProcess(proc, 5000);
          repaired.push('Created skills directory');
          break;
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      failed.push(`${issue.check}: ${errorMessage}`);
    }
  }

  return {
    success: failed.length === 0,
    repaired,
    failed,
    error: failed.length > 0 ? `Failed to repair ${failed.length} issue(s)` : undefined,
  };
}
