/**
 * Sync failure alert tracking
 *
 * Tracks consecutive sync failures and triggers alerts when threshold is exceeded.
 * State is persisted in R2 to survive container restarts.
 */

import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { R2_MOUNT_PATH } from '../config';
import { mountR2Storage } from './r2';
import { waitForProcess } from './utils';

/** Number of consecutive failures before triggering an alert */
const FAILURE_THRESHOLD = 3;

/** Path to the sync status file in R2 */
const SYNC_STATUS_FILE = `${R2_MOUNT_PATH}/.sync-status.json`;

export interface SyncStatus {
  consecutiveFailures: number;
  lastFailureTime?: string;
  lastFailureError?: string;
  lastSuccessTime?: string;
  alertSent: boolean;
  alertSentAt?: string;
}

const DEFAULT_STATUS: SyncStatus = {
  consecutiveFailures: 0,
  alertSent: false,
};

/**
 * Read the current sync status from R2
 */
async function readSyncStatus(sandbox: Sandbox): Promise<SyncStatus> {
  try {
    const proc = await sandbox.startProcess(`cat ${SYNC_STATUS_FILE} 2>/dev/null`);
    await waitForProcess(proc, 5000);
    const logs = await proc.getLogs();
    if (logs.stdout?.trim()) {
      return JSON.parse(logs.stdout.trim());
    }
  } catch {
    // File doesn't exist or parse error
  }
  return { ...DEFAULT_STATUS };
}

/**
 * Write sync status to R2
 */
async function writeSyncStatus(sandbox: Sandbox, status: SyncStatus): Promise<void> {
  const content = JSON.stringify(status, null, 2);
  const escapedContent = content.replace(/'/g, "'\\''");
  const proc = await sandbox.startProcess(`echo '${escapedContent}' > ${SYNC_STATUS_FILE}`);
  await waitForProcess(proc, 5000);
}

/**
 * Record a sync success - resets failure counter
 */
export async function recordSyncSuccess(
  sandbox: Sandbox,
  env: MoltbotEnv
): Promise<void> {
  // Mount R2 if needed
  const mounted = await mountR2Storage(sandbox, env);
  if (!mounted) return;

  const status = await readSyncStatus(sandbox);
  status.consecutiveFailures = 0;
  status.lastSuccessTime = new Date().toISOString();
  status.alertSent = false;
  status.alertSentAt = undefined;

  await writeSyncStatus(sandbox, status);
  console.log('[SyncAlert] Recorded sync success, failure counter reset');
}

/**
 * Record a sync failure and check if alert threshold is exceeded
 *
 * @returns true if alert threshold was just exceeded (alert should be sent)
 */
export async function recordSyncFailure(
  sandbox: Sandbox,
  env: MoltbotEnv,
  error: string
): Promise<{ shouldAlert: boolean; consecutiveFailures: number }> {
  // Mount R2 if needed
  const mounted = await mountR2Storage(sandbox, env);
  if (!mounted) {
    // Can't track without R2, always alert
    console.warn('[SyncAlert] Cannot track failures without R2 - alerting');
    return { shouldAlert: true, consecutiveFailures: 1 };
  }

  const status = await readSyncStatus(sandbox);
  status.consecutiveFailures++;
  status.lastFailureTime = new Date().toISOString();
  status.lastFailureError = error;

  const shouldAlert = status.consecutiveFailures >= FAILURE_THRESHOLD && !status.alertSent;
  if (shouldAlert) {
    status.alertSent = true;
    status.alertSentAt = new Date().toISOString();
  }

  await writeSyncStatus(sandbox, status);
  console.log(`[SyncAlert] Recorded sync failure #${status.consecutiveFailures}, shouldAlert=${shouldAlert}`);

  return { shouldAlert, consecutiveFailures: status.consecutiveFailures };
}

/**
 * Get the current sync status
 */
export async function getSyncAlertStatus(
  sandbox: Sandbox,
  env: MoltbotEnv
): Promise<SyncStatus> {
  const mounted = await mountR2Storage(sandbox, env);
  if (!mounted) {
    return { ...DEFAULT_STATUS };
  }
  return readSyncStatus(sandbox);
}

/**
 * Send a sync failure alert notification
 * This logs a critical error that can be picked up by monitoring systems
 */
export function sendSyncFailureAlert(
  consecutiveFailures: number,
  lastError: string
): void {
  // Log in a structured format that can be picked up by log aggregation
  console.error(JSON.stringify({
    level: 'critical',
    type: 'sync_failure_alert',
    message: `R2 同步連續失敗 ${consecutiveFailures} 次`,
    consecutiveFailures,
    lastError,
    timestamp: new Date().toISOString(),
    action: '請檢查 R2 連線狀態和憑證設定',
  }));

  // Also log human-readable version
  console.error(`[ALERT] ⚠️ R2 同步連續失敗 ${consecutiveFailures} 次！`);
  console.error(`[ALERT] 最後錯誤: ${lastError}`);
  console.error(`[ALERT] 請檢查 R2 連線狀態和憑證設定`);
}
