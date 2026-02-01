import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { R2_MOUNT_PATH } from '../config';
import { mountR2Storage } from './r2';
import { waitForProcess } from './utils';
import { calculateCompletenessScore, createSnapshot, type CompletenessScore } from './snapshot';

/**
 * Sync decision result
 */
export interface SyncDecision {
  action: 'allow' | 'warn' | 'block';
  reason: string;
  requiresConfirmation: boolean;
  localScore: CompletenessScore;
  remoteScore: CompletenessScore;
  diff: SyncDiff;
}

/**
 * Detailed diff between local and remote
 */
export interface SyncDiff {
  willLose: string[];      // Items that will be lost if sync proceeds
  willKeep: string[];      // Items that will be kept
  willAdd: string[];       // Items that will be added
  localConfig: Record<string, unknown> | null;
  remoteConfig: Record<string, unknown> | null;
}

/**
 * Conflict alert for tracking
 */
export interface ConflictAlert {
  id: string;
  type: 'empty_overwrites_full' | 'config_regression' | 'channel_lost' | 'device_lost' | 'conversation_lost' | 'api_key_lost';
  severity: 'warning' | 'critical';
  timestamp: string;
  description: string;
  localScore: number;
  remoteScore: number;
  suggestedAction: string;
  resolved: boolean;
  resolvedAt?: string;
  resolvedBy?: 'user' | 'auto';
}

/**
 * Sync validation configuration
 */
export interface SyncValidatorConfig {
  enabled: boolean;
  minScoreToSync: number;          // Minimum local score required to sync (default: 40)
  warningScoreDiff: number;        // Score difference that triggers warning (default: 10)
  blockingScoreDiff: number;       // Score difference that triggers block (default: 20)
  autoSnapshotOnDanger: boolean;   // Auto-create snapshot before dangerous sync
  autoBlockEmptySync: boolean;     // Auto-block when local is empty
}

const DEFAULT_CONFIG: SyncValidatorConfig = {
  enabled: true,
  minScoreToSync: 40,
  warningScoreDiff: 10,
  blockingScoreDiff: 20,
  autoSnapshotOnDanger: true,
  autoBlockEmptySync: true,
};

const ALERTS_FILE = `${R2_MOUNT_PATH}/conflict-alerts.json`;

/**
 * Get sync validator configuration from environment
 */
export function getSyncValidatorConfig(env: MoltbotEnv): SyncValidatorConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const envAny = env as any;

  return {
    enabled: envAny.SYNC_PROTECTION_ENABLED !== 'false',
    minScoreToSync: parseInt(envAny.SYNC_MIN_SCORE || '40', 10),
    warningScoreDiff: parseInt(envAny.SYNC_WARNING_DIFF || '10', 10),
    blockingScoreDiff: parseInt(envAny.SYNC_BLOCKING_DIFF || '20', 10),
    autoSnapshotOnDanger: envAny.SYNC_AUTO_SNAPSHOT !== 'false',
    autoBlockEmptySync: envAny.SYNC_BLOCK_EMPTY !== 'false',
  };
}

/**
 * Read local configuration and stats
 */
async function getLocalState(sandbox: Sandbox): Promise<{
  config: Record<string, unknown> | null;
  conversationsCount: number;
  devicesCount: number;
}> {
  // Read config
  let config: Record<string, unknown> | null = null;
  try {
    const configProc = await sandbox.startProcess('cat /root/.clawdbot/clawdbot.json 2>/dev/null');
    await waitForProcess(configProc, 5000);
    const configLogs = await configProc.getLogs();
    if (configLogs.stdout?.trim()) {
      config = JSON.parse(configLogs.stdout.trim());
    }
  } catch {
    // Ignore parse errors
  }

  // Count conversations
  let conversationsCount = 0;
  try {
    const convProc = await sandbox.startProcess('ls /root/.clawdbot/conversations/ 2>/dev/null | wc -l');
    await waitForProcess(convProc, 5000);
    const convLogs = await convProc.getLogs();
    conversationsCount = parseInt(convLogs.stdout?.trim() || '0', 10);
  } catch {
    // Ignore errors
  }

  // Count devices
  let devicesCount = 0;
  try {
    const devicesProc = await sandbox.startProcess('ls /root/.clawdbot/devices/ 2>/dev/null | wc -l');
    await waitForProcess(devicesProc, 5000);
    const devicesLogs = await devicesProc.getLogs();
    devicesCount = parseInt(devicesLogs.stdout?.trim() || '0', 10);
  } catch {
    // Ignore errors
  }

  return { config, conversationsCount, devicesCount };
}

/**
 * Read remote (R2) configuration and stats
 */
async function getRemoteState(sandbox: Sandbox): Promise<{
  config: Record<string, unknown> | null;
  conversationsCount: number;
  devicesCount: number;
}> {
  // Read config from R2
  let config: Record<string, unknown> | null = null;
  try {
    const configProc = await sandbox.startProcess(`cat ${R2_MOUNT_PATH}/clawdbot/clawdbot.json 2>/dev/null`);
    await waitForProcess(configProc, 5000);
    const configLogs = await configProc.getLogs();
    if (configLogs.stdout?.trim()) {
      config = JSON.parse(configLogs.stdout.trim());
    }
  } catch {
    // Ignore parse errors
  }

  // Count conversations in R2
  let conversationsCount = 0;
  try {
    const convProc = await sandbox.startProcess(`ls ${R2_MOUNT_PATH}/clawdbot/conversations/ 2>/dev/null | wc -l`);
    await waitForProcess(convProc, 5000);
    const convLogs = await convProc.getLogs();
    conversationsCount = parseInt(convLogs.stdout?.trim() || '0', 10);
  } catch {
    // Ignore errors
  }

  // Count devices in R2
  let devicesCount = 0;
  try {
    const devicesProc = await sandbox.startProcess(`ls ${R2_MOUNT_PATH}/clawdbot/devices/ 2>/dev/null | wc -l`);
    await waitForProcess(devicesProc, 5000);
    const devicesLogs = await devicesProc.getLogs();
    devicesCount = parseInt(devicesLogs.stdout?.trim() || '0', 10);
  } catch {
    // Ignore errors
  }

  return { config, conversationsCount, devicesCount };
}

/**
 * Calculate what will be lost/kept/added in sync
 */
function calculateDiff(
  localConfig: Record<string, unknown> | null,
  remoteConfig: Record<string, unknown> | null,
  localScore: CompletenessScore,
  remoteScore: CompletenessScore
): SyncDiff {
  const willLose: string[] = [];
  const willKeep: string[] = [];
  const willAdd: string[] = [];

  // Check channels
  const localChannels = (localConfig?.channels as Record<string, unknown>) || {};
  const remoteChannels = (remoteConfig?.channels as Record<string, unknown>) || {};

  for (const channel of Object.keys(remoteChannels)) {
    if (!localChannels[channel]) {
      willLose.push(`Channel: ${channel}`);
    } else {
      willKeep.push(`Channel: ${channel}`);
    }
  }
  for (const channel of Object.keys(localChannels)) {
    if (!remoteChannels[channel]) {
      willAdd.push(`Channel: ${channel}`);
    }
  }

  // Check API keys
  if (remoteScore.breakdown.hasApiKeys > 0 && localScore.breakdown.hasApiKeys === 0) {
    willLose.push('API Keys');
  } else if (remoteScore.breakdown.hasApiKeys > 0 && localScore.breakdown.hasApiKeys > 0) {
    willKeep.push('API Keys');
  } else if (localScore.breakdown.hasApiKeys > 0) {
    willAdd.push('API Keys');
  }

  // Check conversations
  if (remoteScore.breakdown.hasConversations > 0 && localScore.breakdown.hasConversations === 0) {
    willLose.push('對話記錄');
  } else if (remoteScore.breakdown.hasConversations > 0) {
    willKeep.push('對話記錄');
  }

  // Check devices
  if (remoteScore.breakdown.hasDevices > 0 && localScore.breakdown.hasDevices === 0) {
    willLose.push('設備配對資料');
  } else if (remoteScore.breakdown.hasDevices > 0) {
    willKeep.push('設備配對資料');
  }

  return {
    willLose,
    willKeep,
    willAdd,
    localConfig,
    remoteConfig,
  };
}

/**
 * Validate sync and return decision
 */
export async function validateSync(
  sandbox: Sandbox,
  env: MoltbotEnv
): Promise<SyncDecision> {
  const config = getSyncValidatorConfig(env);

  // Mount R2 if not already mounted
  const mounted = await mountR2Storage(sandbox, env);
  if (!mounted) {
    // If R2 not available, allow sync (nothing to compare)
    return {
      action: 'allow',
      reason: 'R2 未掛載，無法比較',
      requiresConfirmation: false,
      localScore: { score: 0, breakdown: { hasConfig: 0, hasChannels: 0, hasApiKeys: 0, hasDevices: 0, hasConversations: 0 }, warnings: [] },
      remoteScore: { score: 0, breakdown: { hasConfig: 0, hasChannels: 0, hasApiKeys: 0, hasDevices: 0, hasConversations: 0 }, warnings: [] },
      diff: { willLose: [], willKeep: [], willAdd: [], localConfig: null, remoteConfig: null },
    };
  }

  // Get local and remote states
  const localState = await getLocalState(sandbox);
  const remoteState = await getRemoteState(sandbox);

  // Calculate scores
  const localScore = calculateCompletenessScore(localState.config, {
    conversationsCount: localState.conversationsCount,
    devicesCount: localState.devicesCount,
  });
  const remoteScore = calculateCompletenessScore(remoteState.config, {
    conversationsCount: remoteState.conversationsCount,
    devicesCount: remoteState.devicesCount,
  });

  // Calculate diff
  const diff = calculateDiff(localState.config, remoteState.config, localScore, remoteScore);

  const scoreDiff = localScore.score - remoteScore.score;

  // Decision logic

  // Case 1: Local has no channels but remote has → BLOCK
  if (localScore.breakdown.hasChannels === 0 && remoteScore.breakdown.hasChannels > 0) {
    return {
      action: 'block',
      reason: `本地沒有 channel 設定，但雲端有。這可能會清除重要設定！`,
      requiresConfirmation: true,
      localScore,
      remoteScore,
      diff,
    };
  }

  // Case 2: Local score much lower than remote → BLOCK
  if (scoreDiff < -config.blockingScoreDiff) {
    return {
      action: 'block',
      reason: `本地配置完整度 (${localScore.score}) 遠低於雲端 (${remoteScore.score})，差異達 ${-scoreDiff} 分`,
      requiresConfirmation: true,
      localScore,
      remoteScore,
      diff,
    };
  }

  // Case 3: Local score lower than remote → WARN
  if (scoreDiff < -config.warningScoreDiff) {
    return {
      action: 'warn',
      reason: `本地配置完整度 (${localScore.score}) 低於雲端 (${remoteScore.score})`,
      requiresConfirmation: true,
      localScore,
      remoteScore,
      diff,
    };
  }

  // Case 4: Local score below minimum → WARN
  if (localScore.score < config.minScoreToSync && remoteScore.score > localScore.score) {
    return {
      action: 'warn',
      reason: `本地配置完整度 (${localScore.score}) 低於最低要求 (${config.minScoreToSync})`,
      requiresConfirmation: true,
      localScore,
      remoteScore,
      diff,
    };
  }

  // Case 5: Will lose important data → WARN
  if (diff.willLose.length > 0) {
    return {
      action: 'warn',
      reason: `同步將會丟失: ${diff.willLose.join(', ')}`,
      requiresConfirmation: true,
      localScore,
      remoteScore,
      diff,
    };
  }

  // Normal case: ALLOW
  return {
    action: 'allow',
    reason: '配置完整度正常',
    requiresConfirmation: false,
    localScore,
    remoteScore,
    diff,
  };
}

/**
 * Handle dangerous sync - auto protection
 */
export async function handleDangerousSync(
  sandbox: Sandbox,
  env: MoltbotEnv,
  decision: SyncDecision
): Promise<{ blocked: boolean; snapshotId?: string; alertId?: string }> {
  const config = getSyncValidatorConfig(env);

  // Create auto-protection snapshot
  let snapshotId: string | undefined;
  if (config.autoSnapshotOnDanger) {
    console.log('[SyncValidator] Creating auto-protection snapshot...');
    const result = await createSnapshot(sandbox, env, {
      trigger: 'auto-protection',
      description: `Auto snapshot before dangerous sync (score: ${decision.localScore.score} → ${decision.remoteScore.score})`,
    });
    if (result.success && result.snapshot) {
      snapshotId = result.snapshot.id;
      console.log(`[SyncValidator] Created snapshot: ${snapshotId}`);
    }
  }

  // Record conflict alert
  const alertId = await recordConflictAlert(sandbox, {
    type: decision.action === 'block' ? 'empty_overwrites_full' : 'config_regression',
    severity: decision.action === 'block' ? 'critical' : 'warning',
    description: decision.reason,
    localScore: decision.localScore.score,
    remoteScore: decision.remoteScore.score,
    suggestedAction: decision.action === 'block'
      ? '請從雲端恢復配置，或確認這是預期的重置操作'
      : '請檢查配置差異，確認是否繼續同步',
  });

  // Block sync if configured
  const blocked = config.autoBlockEmptySync && decision.action === 'block';
  if (blocked) {
    console.log('[SyncValidator] SYNC BLOCKED - Dangerous sync prevented');
  }

  return { blocked, snapshotId, alertId };
}

/**
 * Record a conflict alert
 */
async function recordConflictAlert(
  sandbox: Sandbox,
  alert: Omit<ConflictAlert, 'id' | 'timestamp' | 'resolved'>
): Promise<string> {
  const alertId = `alert-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`;

  const fullAlert: ConflictAlert = {
    ...alert,
    id: alertId,
    timestamp: new Date().toISOString(),
    resolved: false,
  };

  try {
    // Load existing alerts
    let alerts: ConflictAlert[] = [];
    try {
      const readProc = await sandbox.startProcess(`cat ${ALERTS_FILE} 2>/dev/null`);
      await waitForProcess(readProc, 5000);
      const logs = await readProc.getLogs();
      if (logs.stdout?.trim()) {
        alerts = JSON.parse(logs.stdout.trim());
      }
    } catch {
      // Start fresh
    }

    // Add new alert (keep last 50)
    alerts.unshift(fullAlert);
    if (alerts.length > 50) {
      alerts = alerts.slice(0, 50);
    }

    // Save alerts
    const content = JSON.stringify(alerts, null, 2).replace(/'/g, "'\\''");
    const writeProc = await sandbox.startProcess(`echo '${content}' > ${ALERTS_FILE}`);
    await waitForProcess(writeProc, 5000);

    console.log(`[SyncValidator] Recorded alert: ${alertId}`);
  } catch (err) {
    console.error('[SyncValidator] Failed to record alert:', err);
  }

  return alertId;
}

/**
 * Get all conflict alerts
 */
export async function getConflictAlerts(
  sandbox: Sandbox,
  env: MoltbotEnv,
  includeResolved = false
): Promise<ConflictAlert[]> {
  // Mount R2 if not already mounted
  const mounted = await mountR2Storage(sandbox, env);
  if (!mounted) {
    return [];
  }

  try {
    const readProc = await sandbox.startProcess(`cat ${ALERTS_FILE} 2>/dev/null`);
    await waitForProcess(readProc, 5000);
    const logs = await readProc.getLogs();
    if (logs.stdout?.trim()) {
      const alerts: ConflictAlert[] = JSON.parse(logs.stdout.trim());
      return includeResolved ? alerts : alerts.filter(a => !a.resolved);
    }
  } catch {
    // No alerts
  }

  return [];
}

/**
 * Resolve a conflict alert
 */
export async function resolveConflictAlert(
  sandbox: Sandbox,
  env: MoltbotEnv,
  alertId: string,
  resolvedBy: 'user' | 'auto' = 'user'
): Promise<boolean> {
  // Mount R2 if not already mounted
  const mounted = await mountR2Storage(sandbox, env);
  if (!mounted) {
    return false;
  }

  try {
    // Load alerts
    const readProc = await sandbox.startProcess(`cat ${ALERTS_FILE} 2>/dev/null`);
    await waitForProcess(readProc, 5000);
    const logs = await readProc.getLogs();
    if (!logs.stdout?.trim()) {
      return false;
    }

    const alerts: ConflictAlert[] = JSON.parse(logs.stdout.trim());
    const alertIndex = alerts.findIndex(a => a.id === alertId);
    if (alertIndex === -1) {
      return false;
    }

    // Update alert
    alerts[alertIndex].resolved = true;
    alerts[alertIndex].resolvedAt = new Date().toISOString();
    alerts[alertIndex].resolvedBy = resolvedBy;

    // Save alerts
    const content = JSON.stringify(alerts, null, 2).replace(/'/g, "'\\''");
    const writeProc = await sandbox.startProcess(`echo '${content}' > ${ALERTS_FILE}`);
    await waitForProcess(writeProc, 5000);

    console.log(`[SyncValidator] Resolved alert: ${alertId}`);
    return true;
  } catch (err) {
    console.error('[SyncValidator] Failed to resolve alert:', err);
    return false;
  }
}

/**
 * Get current sync status summary
 */
export async function getSyncStatus(
  sandbox: Sandbox,
  env: MoltbotEnv
): Promise<{
  localScore: CompletenessScore;
  remoteScore: CompletenessScore;
  syncSafe: boolean;
  pendingAlerts: number;
  lastSyncTime?: string;
}> {
  // Mount R2 if not already mounted
  await mountR2Storage(sandbox, env);

  // Get scores
  const localState = await getLocalState(sandbox);
  const remoteState = await getRemoteState(sandbox);

  const localScore = calculateCompletenessScore(localState.config, {
    conversationsCount: localState.conversationsCount,
    devicesCount: localState.devicesCount,
  });
  const remoteScore = calculateCompletenessScore(remoteState.config, {
    conversationsCount: remoteState.conversationsCount,
    devicesCount: remoteState.devicesCount,
  });

  // Get pending alerts count
  const alerts = await getConflictAlerts(sandbox, env, false);

  // Get last sync time
  let lastSyncTime: string | undefined;
  try {
    const syncProc = await sandbox.startProcess(`cat ${R2_MOUNT_PATH}/.last-sync 2>/dev/null`);
    await waitForProcess(syncProc, 5000);
    const syncLogs = await syncProc.getLogs();
    lastSyncTime = syncLogs.stdout?.trim();
  } catch {
    // No last sync
  }

  // Determine if sync is safe
  const scoreDiff = localScore.score - remoteScore.score;
  const config = getSyncValidatorConfig(env);
  const syncSafe = scoreDiff >= -config.warningScoreDiff &&
                   localScore.breakdown.hasChannels > 0 ||
                   remoteScore.breakdown.hasChannels === 0;

  return {
    localScore,
    remoteScore,
    syncSafe,
    pendingAlerts: alerts.length,
    lastSyncTime,
  };
}
