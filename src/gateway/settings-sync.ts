import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { R2_MOUNT_PATH } from '../config';
import { mountR2Storage } from './r2';
import { waitForProcess } from './utils';

/**
 * Setting definition for sync tracking
 */
export interface SettingDefinition {
  name: string;              // Environment variable name
  displayName: string;       // Human readable name
  category: 'secrets' | 'channels' | 'agents' | 'gateway' | 'other';
  priority: 'critical' | 'important' | 'optional';
  configPath: string;        // Path in clawdbot.json (dot notation)
  isSensitive: boolean;      // Whether to mask the value in UI
}

/**
 * Setting item with current status
 */
export interface SettingItem extends SettingDefinition {
  configValue: string | null;     // Value in clawdbot.json (masked if sensitive)
  configValueRaw: string | null;  // Raw value (for commands)
  envExists: boolean;             // Whether env var exists
  status: 'synced' | 'unsynced' | 'env_only' | 'not_set';
}

/**
 * Pending env sync item
 */
export interface PendingEnvSync {
  name: string;
  value: string;
  configPath: string;
  setAt: string;
  setBy: 'chat' | 'admin' | 'api' | 'unknown';
  priority: 'critical' | 'important' | 'optional';
  reminded: boolean;
  lastRemindedAt?: string;
}

/**
 * Pending env sync file structure
 */
export interface PendingEnvSyncFile {
  pending: PendingEnvSync[];
  lastUpdated: string;
}

/**
 * Sync status response
 */
export interface SettingsSyncStatus {
  summary: {
    synced: number;
    unsynced: number;
    envOnly: number;
    notSet: number;
  };
  categories: {
    secrets: SettingItem[];
    channels: SettingItem[];
    agents: SettingItem[];
    gateway: SettingItem[];
    other: SettingItem[];
  };
  pendingSync: PendingEnvSync[];
}

/**
 * All tracked settings definitions
 */
export const SETTING_DEFINITIONS: SettingDefinition[] = [
  // Secrets
  {
    name: 'TELEGRAM_BOT_TOKEN',
    displayName: 'Telegram Bot Token',
    category: 'secrets',
    priority: 'critical',
    configPath: 'channels.telegram.botToken',
    isSensitive: true,
  },
  {
    name: 'ANTHROPIC_API_KEY',
    displayName: 'Anthropic API Key',
    category: 'secrets',
    priority: 'critical',
    configPath: 'models.providers.anthropic.apiKey',
    isSensitive: true,
  },
  {
    name: 'OPENAI_API_KEY',
    displayName: 'OpenAI API Key',
    category: 'secrets',
    priority: 'critical',
    configPath: 'models.providers.openai.apiKey',
    isSensitive: true,
  },
  {
    name: 'BRAVE_SEARCH_API_KEY',
    displayName: 'Brave Search API Key',
    category: 'secrets',
    priority: 'critical',
    configPath: 'tools.web.search.apiKey',
    isSensitive: true,
  },
  {
    name: 'GATEWAY_AUTH_TOKEN',
    displayName: 'Gateway Auth Token',
    category: 'secrets',
    priority: 'critical',
    configPath: 'gateway.auth.token',
    isSensitive: true,
  },

  // Channels
  {
    name: 'TELEGRAM_DM_POLICY',
    displayName: 'Telegram DM Policy',
    category: 'channels',
    priority: 'important',
    configPath: 'channels.telegram.dmPolicy',
    isSensitive: false,
  },
  {
    name: 'TELEGRAM_GROUP_POLICY',
    displayName: 'Telegram Group Policy',
    category: 'channels',
    priority: 'important',
    configPath: 'channels.telegram.groupPolicy',
    isSensitive: false,
  },
  {
    name: 'TELEGRAM_STREAM_MODE',
    displayName: 'Telegram Stream Mode',
    category: 'channels',
    priority: 'optional',
    configPath: 'channels.telegram.streamMode',
    isSensitive: false,
  },

  // Agents
  {
    name: 'DEFAULT_MODEL',
    displayName: 'Default Model',
    category: 'agents',
    priority: 'important',
    configPath: 'agents.defaults.model.primary',
    isSensitive: false,
  },
  {
    name: 'WORKSPACE_PATH',
    displayName: 'Workspace Path',
    category: 'agents',
    priority: 'optional',
    configPath: 'agents.defaults.workspace',
    isSensitive: false,
  },
  {
    name: 'MAX_CONCURRENT',
    displayName: 'Max Concurrent Agents',
    category: 'agents',
    priority: 'optional',
    configPath: 'agents.defaults.maxConcurrent',
    isSensitive: false,
  },

  // Gateway
  {
    name: 'GATEWAY_PORT',
    displayName: 'Gateway Port',
    category: 'gateway',
    priority: 'optional',
    configPath: 'gateway.port',
    isSensitive: false,
  },
  {
    name: 'GATEWAY_MODE',
    displayName: 'Gateway Mode',
    category: 'gateway',
    priority: 'optional',
    configPath: 'gateway.mode',
    isSensitive: false,
  },

  // Other
  {
    name: 'ACK_REACTION_SCOPE',
    displayName: 'ACK Reaction Scope',
    category: 'other',
    priority: 'optional',
    configPath: 'messages.ackReactionScope',
    isSensitive: false,
  },
];

const PENDING_SYNC_FILE = `${R2_MOUNT_PATH}/pending-env-sync.json`;

/**
 * Get value from nested object using dot notation path
 */
function getValueByPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return null;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Mask sensitive value for display
 */
function maskValue(value: string, isSensitive: boolean): string {
  if (!isSensitive || !value || value.length < 8) {
    return value;
  }
  const start = value.substring(0, 4);
  const end = value.substring(value.length - 3);
  return `${start}...${end}`;
}

/**
 * Load clawdbot.json config
 */
async function loadConfig(sandbox: Sandbox): Promise<Record<string, unknown> | null> {
  try {
    const proc = await sandbox.startProcess('cat /root/.clawdbot/clawdbot.json 2>/dev/null');
    await waitForProcess(proc, 5000);
    const logs = await proc.getLogs();
    if (logs.stdout?.trim()) {
      return JSON.parse(logs.stdout.trim());
    }
  } catch {
    // Ignore errors
  }
  return null;
}

/**
 * Load pending env sync file from R2
 */
export async function loadPendingEnvSync(sandbox: Sandbox): Promise<PendingEnvSyncFile> {
  const defaultFile: PendingEnvSyncFile = {
    pending: [],
    lastUpdated: new Date().toISOString(),
  };

  try {
    const proc = await sandbox.startProcess(`cat ${PENDING_SYNC_FILE} 2>/dev/null`);
    await waitForProcess(proc, 5000);
    const logs = await proc.getLogs();
    if (logs.stdout?.trim()) {
      return JSON.parse(logs.stdout.trim());
    }
  } catch {
    // Return default
  }

  return defaultFile;
}

/**
 * Save pending env sync file to R2
 */
export async function savePendingEnvSync(
  sandbox: Sandbox,
  data: PendingEnvSyncFile
): Promise<boolean> {
  try {
    data.lastUpdated = new Date().toISOString();
    const content = JSON.stringify(data, null, 2).replace(/'/g, "'\\''");
    const proc = await sandbox.startProcess(`echo '${content}' > ${PENDING_SYNC_FILE}`);
    await waitForProcess(proc, 5000);
    return true;
  } catch (err) {
    console.error('[SettingsSync] Failed to save pending sync file:', err);
    return false;
  }
}

/**
 * Add a setting to pending env sync
 */
export async function addPendingEnvSync(
  sandbox: Sandbox,
  env: MoltbotEnv,
  setting: {
    name: string;
    value: string;
    configPath: string;
    setBy: 'chat' | 'admin' | 'api' | 'unknown';
  }
): Promise<boolean> {
  // Mount R2 if needed
  await mountR2Storage(sandbox, env);

  const data = await loadPendingEnvSync(sandbox);
  const definition = SETTING_DEFINITIONS.find(d => d.name === setting.name);

  // Remove existing entry for this setting
  data.pending = data.pending.filter(p => p.name !== setting.name);

  // Add new entry
  data.pending.push({
    name: setting.name,
    value: setting.value,
    configPath: setting.configPath,
    setAt: new Date().toISOString(),
    setBy: setting.setBy,
    priority: definition?.priority || 'optional',
    reminded: false,
  });

  return savePendingEnvSync(sandbox, data);
}

/**
 * Remove a setting from pending env sync (after it's been synced)
 */
export async function removePendingEnvSync(
  sandbox: Sandbox,
  env: MoltbotEnv,
  settingName: string
): Promise<boolean> {
  await mountR2Storage(sandbox, env);

  const data = await loadPendingEnvSync(sandbox);
  data.pending = data.pending.filter(p => p.name !== settingName);

  return savePendingEnvSync(sandbox, data);
}

/**
 * Mark a pending sync item as reminded
 */
export async function markAsReminded(
  sandbox: Sandbox,
  env: MoltbotEnv,
  settingNames: string[]
): Promise<boolean> {
  await mountR2Storage(sandbox, env);

  const data = await loadPendingEnvSync(sandbox);
  const now = new Date().toISOString();

  for (const pending of data.pending) {
    if (settingNames.includes(pending.name)) {
      pending.reminded = true;
      pending.lastRemindedAt = now;
    }
  }

  return savePendingEnvSync(sandbox, data);
}

/**
 * Get settings sync status
 */
export async function getSettingsSyncStatus(
  sandbox: Sandbox,
  env: MoltbotEnv
): Promise<SettingsSyncStatus> {
  // Mount R2 if needed
  await mountR2Storage(sandbox, env);

  // Load config
  const config = await loadConfig(sandbox);

  // Load pending sync
  const pendingData = await loadPendingEnvSync(sandbox);

  // Build status for each setting
  const items: SettingItem[] = [];

  for (const def of SETTING_DEFINITIONS) {
    const configValueRaw = config ? String(getValueByPath(config, def.configPath) || '') : null;
    const configValue = configValueRaw ? maskValue(configValueRaw, def.isSensitive) : null;

    // Check if env var exists
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const envValue = (env as any)[def.name];
    const envExists = envValue !== undefined && envValue !== null && envValue !== '';

    // Determine status
    let status: 'synced' | 'unsynced' | 'env_only' | 'not_set';
    if (configValueRaw && envExists) {
      status = 'synced';
    } else if (configValueRaw && !envExists) {
      status = 'unsynced';
    } else if (!configValueRaw && envExists) {
      status = 'env_only';
    } else {
      status = 'not_set';
    }

    items.push({
      ...def,
      configValue: configValueRaw || null,
      configValueRaw: configValueRaw || null,
      envExists,
      status,
    });
  }

  // Calculate summary
  const summary = {
    synced: items.filter(i => i.status === 'synced').length,
    unsynced: items.filter(i => i.status === 'unsynced').length,
    envOnly: items.filter(i => i.status === 'env_only').length,
    notSet: items.filter(i => i.status === 'not_set').length,
  };

  // Group by category
  const categories = {
    secrets: items.filter(i => i.category === 'secrets'),
    channels: items.filter(i => i.category === 'channels'),
    agents: items.filter(i => i.category === 'agents'),
    gateway: items.filter(i => i.category === 'gateway'),
    other: items.filter(i => i.category === 'other'),
  };

  return {
    summary,
    categories,
    pendingSync: pendingData.pending,
  };
}

/**
 * Generate wrangler secret put commands
 */
export async function generateExportCommands(
  sandbox: Sandbox,
  env: MoltbotEnv,
  options: {
    category?: 'all' | 'secrets' | 'channels' | 'agents' | 'gateway' | 'other';
    onlyUnsynced?: boolean;
  } = {}
): Promise<{ commands: string[]; items: Array<{ name: string; value: string; comment: string }> }> {
  const { category = 'all', onlyUnsynced = true } = options;

  const status = await getSettingsSyncStatus(sandbox, env);

  // Collect all items based on filters
  let items: SettingItem[] = [];

  if (category === 'all') {
    items = [
      ...status.categories.secrets,
      ...status.categories.channels,
      ...status.categories.agents,
      ...status.categories.gateway,
      ...status.categories.other,
    ];
  } else {
    items = status.categories[category] || [];
  }

  // Filter to unsynced only if requested
  if (onlyUnsynced) {
    items = items.filter(i => i.status === 'unsynced');
  }

  // Filter out items without values
  items = items.filter(i => i.configValueRaw);

  // Generate commands
  const commands: string[] = [];
  const exportItems: Array<{ name: string; value: string; comment: string }> = [];

  // Group by category for comments
  const categoryOrder = ['secrets', 'channels', 'agents', 'gateway', 'other'];
  const categoryLabels: Record<string, string> = {
    secrets: '🔴 機密設定 (建議優先設定)',
    channels: '🟡 Channel 設定',
    agents: '🟢 Agent/Model 設定',
    gateway: '🔵 Gateway 設定',
    other: '⚪ 其他設定',
  };

  for (const cat of categoryOrder) {
    const catItems = items.filter(i => i.category === cat);
    if (catItems.length === 0) continue;

    commands.push(`# ${categoryLabels[cat]}`);

    for (const item of catItems) {
      commands.push(`npx wrangler secret put ${item.name}`);
      commands.push(`# 輸入: ${item.configValueRaw}`);
      commands.push('');

      exportItems.push({
        name: item.name,
        value: item.configValueRaw!,
        comment: item.displayName,
      });
    }
  }

  return { commands, items: exportItems };
}

/**
 * Get pending items that need reminder (older than specified hours)
 */
export async function getPendingItemsForReminder(
  sandbox: Sandbox,
  env: MoltbotEnv,
  options: {
    minHoursOld?: number;
    onlyUnreminded?: boolean;
    minHoursSinceLastReminder?: number;
  } = {}
): Promise<PendingEnvSync[]> {
  const {
    minHoursOld = 24,
    onlyUnreminded = false,
    minHoursSinceLastReminder = 24,
  } = options;

  await mountR2Storage(sandbox, env);
  const data = await loadPendingEnvSync(sandbox);

  const now = Date.now();

  return data.pending.filter(item => {
    const setAt = new Date(item.setAt).getTime();
    const hoursOld = (now - setAt) / (1000 * 60 * 60);

    if (hoursOld < minHoursOld) {
      return false;
    }

    if (onlyUnreminded && item.reminded) {
      return false;
    }

    if (item.lastRemindedAt) {
      const lastReminded = new Date(item.lastRemindedAt).getTime();
      const hoursSinceReminder = (now - lastReminded) / (1000 * 60 * 60);
      if (hoursSinceReminder < minHoursSinceLastReminder) {
        return false;
      }
    }

    return true;
  });
}
