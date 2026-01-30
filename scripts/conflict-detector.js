#!/usr/bin/env node
/**
 * Conflict Detector Script
 *
 * This script runs inside the container at startup to detect configuration conflicts.
 * It checks for "past-life memory" issues that can cause moltbot to fail.
 *
 * Usage:
 *   node conflict-detector.js [--auto-fix] [--quiet]
 *
 * Options:
 *   --auto-fix    Automatically fix detected conflicts
 *   --quiet       Only output errors
 */

const fs = require('fs');
const path = require('path');

// Configuration
const CONFIG_DIR = '/root/.clawdbot';
const CONFIG_FILE = path.join(CONFIG_DIR, 'clawdbot.json');
const BACKUP_DIR = '/data/moltbot';

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  return {
    autoFix: args.includes('--auto-fix'),
    quiet: args.includes('--quiet'),
  };
}

// Load JSON file safely
function loadJson(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (err) {
    if (!parseArgs().quiet) {
      console.error(`[Conflict] Failed to load ${filePath}:`, err.message);
    }
  }
  return null;
}

// Save JSON file
function saveJson(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error(`[Conflict] Failed to save ${filePath}:`, err.message);
    return false;
  }
}

// Check for provider stacking
function checkProviderStack(config) {
  const conflicts = [];
  const providers = config?.models?.providers || {};
  const providerKeys = Object.keys(providers);

  if (providerKeys.length > 1) {
    // Check environment to determine which one should be used
    const baseUrl = process.env.AI_GATEWAY_BASE_URL || process.env.ANTHROPIC_BASE_URL || '';
    const wantsOpenAI = baseUrl.endsWith('/openai');

    if (providerKeys.includes('openai') && providerKeys.includes('anthropic')) {
      const unwanted = wantsOpenAI ? 'anthropic' : 'openai';
      conflicts.push({
        type: 'provider_stack',
        severity: 'warning',
        description: `Multiple providers configured: ${providerKeys.join(', ')}`,
        suggestion: `Remove ${unwanted} provider`,
        fix: () => {
          delete config.models.providers[unwanted];
          return `Removed ${unwanted} provider`;
        },
      });
    }
  }

  return conflicts;
}

// Check for channel residue
function checkChannelResidue(config) {
  const conflicts = [];
  const channels = config?.channels || {};

  // Telegram
  if (channels.telegram?.botToken && !process.env.TELEGRAM_BOT_TOKEN) {
    conflicts.push({
      type: 'channel_residue',
      severity: 'info',
      description: 'Telegram config exists without TELEGRAM_BOT_TOKEN env',
      suggestion: 'Consider removing old Telegram config',
      fix: () => {
        delete config.channels.telegram;
        return 'Removed orphaned Telegram config';
      },
    });
  }

  // Discord
  if (channels.discord?.token && !process.env.DISCORD_BOT_TOKEN) {
    conflicts.push({
      type: 'channel_residue',
      severity: 'info',
      description: 'Discord config exists without DISCORD_BOT_TOKEN env',
      suggestion: 'Consider removing old Discord config',
      fix: () => {
        delete config.channels.discord;
        return 'Removed orphaned Discord config';
      },
    });
  }

  // Slack
  if (channels.slack?.botToken && !process.env.SLACK_BOT_TOKEN) {
    conflicts.push({
      type: 'channel_residue',
      severity: 'info',
      description: 'Slack config exists without SLACK_BOT_TOKEN env',
      suggestion: 'Consider removing old Slack config',
      fix: () => {
        delete config.channels.slack;
        return 'Removed orphaned Slack config';
      },
    });
  }

  return conflicts;
}

// Check for auth mismatches
function checkAuthMismatch(config) {
  const conflicts = [];
  const configToken = config?.gateway?.auth?.token;
  const envToken = process.env.CLAWDBOT_GATEWAY_TOKEN || process.env.MOLTBOT_GATEWAY_TOKEN;

  if (configToken && envToken && configToken !== envToken) {
    conflicts.push({
      type: 'auth_mismatch',
      severity: 'warning',
      description: 'Gateway token in config differs from environment',
      suggestion: 'Config will be updated on next full startup',
      fix: () => {
        config.gateway.auth.token = envToken;
        return 'Updated gateway token to match environment';
      },
    });
  }

  return conflicts;
}

// Check for broken provider config
function checkBrokenProviders(config) {
  const conflicts = [];
  const providers = config?.models?.providers || {};

  for (const [name, provider] of Object.entries(providers)) {
    // Check for models without names (old bug)
    if (provider.models && Array.isArray(provider.models)) {
      const hasInvalidModels = provider.models.some(m => !m.name);
      if (hasInvalidModels) {
        conflicts.push({
          type: 'config_corruption',
          severity: 'error',
          description: `Provider ${name} has models without 'name' field`,
          suggestion: `Remove broken ${name} provider config`,
          fix: () => {
            delete config.models.providers[name];
            return `Removed broken ${name} provider`;
          },
        });
      }
    }
  }

  return conflicts;
}

// Main function
function main() {
  const options = parseArgs();

  if (!options.quiet) {
    console.log('[Conflict] Running conflict detection...');
  }

  // Load current config
  const config = loadJson(CONFIG_FILE);
  if (!config) {
    if (!options.quiet) {
      console.log('[Conflict] No config file found, skipping detection');
    }
    process.exit(0);
  }

  // Collect all conflicts
  const allConflicts = [
    ...checkProviderStack(config),
    ...checkChannelResidue(config),
    ...checkAuthMismatch(config),
    ...checkBrokenProviders(config),
  ];

  if (allConflicts.length === 0) {
    if (!options.quiet) {
      console.log('[Conflict] No conflicts detected');
    }
    process.exit(0);
  }

  // Report conflicts
  console.log(`[Conflict] Found ${allConflicts.length} conflict(s):`);
  for (const conflict of allConflicts) {
    const icon = conflict.severity === 'error' ? '🔴' :
                 conflict.severity === 'warning' ? '🟡' : '🔵';
    console.log(`  ${icon} ${conflict.type}: ${conflict.description}`);
  }

  // Auto-fix if requested
  if (options.autoFix) {
    console.log('[Conflict] Attempting auto-fix...');
    const fixed = [];
    const failed = [];

    for (const conflict of allConflicts) {
      if (conflict.fix) {
        try {
          const result = conflict.fix();
          fixed.push(result);
          console.log(`  ✅ ${result}`);
        } catch (err) {
          failed.push(`${conflict.type}: ${err.message}`);
          console.log(`  ❌ Failed to fix ${conflict.type}: ${err.message}`);
        }
      }
    }

    // Save updated config
    if (fixed.length > 0) {
      if (saveJson(CONFIG_FILE, config)) {
        console.log(`[Conflict] Saved updated config (${fixed.length} fix(es) applied)`);
      } else {
        console.error('[Conflict] Failed to save config');
        process.exit(1);
      }
    }

    if (failed.length > 0) {
      console.log(`[Conflict] ${failed.length} fix(es) failed`);
      process.exit(1);
    }
  } else {
    // Just report, suggest running with --auto-fix
    const fixable = allConflicts.filter(c => c.fix).length;
    if (fixable > 0) {
      console.log(`[Conflict] ${fixable} conflict(s) can be auto-fixed with --auto-fix`);
    }
  }
}

main();
