import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { R2_MOUNT_PATH } from '../config';
import { mountR2Storage } from './r2';
import { waitForProcess } from './utils';
import {
  validateSync,
  handleDangerousSync,
  getSyncValidatorConfig,
  type SyncDecision,
} from './sync-validator';

/**
 * Fields that should NEVER be synced to R2.
 * These are "Env Only by design" - they should only exist in Cloudflare Secrets.
 *
 * Reasons:
 * - Security: API keys shouldn't be stored in R2 where they could be exposed
 * - Resilience: If R2 is corrupted, env vars remain intact
 * - Control: Prevents AI from accidentally leaking or modifying sensitive keys
 */
export const ENV_ONLY_FIELDS = [
  'models.providers.anthropic.apiKey',
  'models.providers.openai.apiKey',
  // Note: Channel tokens (telegram.botToken, etc.) are intentionally NOT here
  // because the AI assistant needs to "see" which channels it's connected to
];

export interface SyncResult {
  success: boolean;
  lastSync?: string;
  error?: string;
  details?: string;
  // New fields for sync protection
  validation?: SyncDecision;
  blocked?: boolean;
  snapshotId?: string;
  alertId?: string;
  sanitized?: string[]; // Fields that were removed before sync
}

/**
 * Remove a nested field from an object using dot notation path.
 * Returns true if the field was removed, false if it didn't exist.
 */
function removeNestedField(obj: Record<string, unknown>, path: string): boolean {
  const parts = path.split('.');
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (current[part] === undefined || current[part] === null || typeof current[part] !== 'object') {
      return false;
    }
    current = current[part] as Record<string, unknown>;
  }

  const lastPart = parts[parts.length - 1];
  if (lastPart in current) {
    delete current[lastPart];
    return true;
  }
  return false;
}

/**
 * Sanitize clawdbot.json before syncing to R2.
 * Removes sensitive fields that should be "Env Only by design".
 *
 * @param sandbox - The sandbox instance
 * @returns List of fields that were sanitized
 */
async function sanitizeConfigBeforeSync(sandbox: Sandbox): Promise<string[]> {
  const configPath = '/root/.clawdbot/clawdbot.json';
  const sanitized: string[] = [];

  try {
    // Read current config
    const readProc = await sandbox.startProcess(`cat ${configPath}`);
    await waitForProcess(readProc, 5000);
    const readLogs = await readProc.getLogs();

    if (!readLogs.stdout?.trim()) {
      console.log('[Sync] No config file to sanitize');
      return [];
    }

    const config = JSON.parse(readLogs.stdout.trim());

    // Remove env-only fields
    for (const field of ENV_ONLY_FIELDS) {
      if (removeNestedField(config, field)) {
        sanitized.push(field);
        console.log(`[Sync] Sanitized field: ${field}`);
      }
    }

    if (sanitized.length > 0) {
      // Write sanitized config back
      const sanitizedJson = JSON.stringify(config, null, 2);
      // Use a temp file to avoid shell escaping issues
      const tempFile = '/tmp/sanitized-config.json';
      const writeProc = await sandbox.startProcess(
        `cat > ${tempFile} << 'SANITIZE_EOF'\n${sanitizedJson}\nSANITIZE_EOF`
      );
      await waitForProcess(writeProc, 5000);

      // Replace original with sanitized version
      const mvProc = await sandbox.startProcess(`mv ${tempFile} ${configPath}`);
      await waitForProcess(mvProc, 5000);

      console.log(`[Sync] Sanitized ${sanitized.length} fields before sync`);
    }
  } catch (err) {
    console.error('[Sync] Failed to sanitize config:', err);
    // Continue with sync even if sanitization fails
  }

  return sanitized;
}

/**
 * Sync moltbot config from container to R2 for persistence.
 * 
 * This function:
 * 1. Mounts R2 if not already mounted
 * 2. Verifies source has critical files (prevents overwriting good backup with empty data)
 * 3. Runs rsync to copy config to R2
 * 4. Writes a timestamp file for tracking
 * 
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns SyncResult with success status and optional error details
 */
export async function syncToR2(sandbox: Sandbox, env: MoltbotEnv): Promise<SyncResult> {
  // Check if R2 is configured
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    return { success: false, error: 'R2 storage is not configured' };
  }

  // Mount R2 if not already mounted
  const mounted = await mountR2Storage(sandbox, env);
  if (!mounted) {
    return { success: false, error: 'Failed to mount R2 storage' };
  }

  // Sanity check: verify source has critical files before syncing
  // This prevents accidentally overwriting a good backup with empty/corrupted data
  try {
    const checkProc = await sandbox.startProcess('test -f /root/.clawdbot/clawdbot.json && echo "ok"');
    await waitForProcess(checkProc, 5000);
    const checkLogs = await checkProc.getLogs();
    if (!checkLogs.stdout?.includes('ok')) {
      return {
        success: false,
        error: 'Sync aborted: source missing clawdbot.json',
        details: 'The local config directory is missing critical files. This could indicate corruption or an incomplete setup.',
      };
    }
  } catch (err) {
    return {
      success: false,
      error: 'Failed to verify source files',
      details: err instanceof Error ? err.message : 'Unknown error',
    };
  }

  // Sanitize config before sync - remove "Env Only by design" fields
  // This prevents sensitive API keys from being stored in R2
  const sanitized = await sanitizeConfigBeforeSync(sandbox);

  // Run rsync to backup config to R2
  // Note: Use --no-times because s3fs doesn't support setting timestamps
  const syncCmd = `rsync -r --no-times --delete --exclude='*.lock' --exclude='*.log' --exclude='*.tmp' /root/.clawdbot/ ${R2_MOUNT_PATH}/clawdbot/ && rsync -r --no-times --delete /root/clawd/skills/ ${R2_MOUNT_PATH}/skills/ && date -Iseconds > ${R2_MOUNT_PATH}/.last-sync`;
  
  try {
    const proc = await sandbox.startProcess(syncCmd);
    await waitForProcess(proc, 30000); // 30 second timeout for sync

    // Check for success by reading the timestamp file
    // (process status may not update reliably in sandbox API)
    // Note: backup structure is ${R2_MOUNT_PATH}/clawdbot/ and ${R2_MOUNT_PATH}/skills/
    const timestampProc = await sandbox.startProcess(`cat ${R2_MOUNT_PATH}/.last-sync`);
    await waitForProcess(timestampProc, 5000);
    const timestampLogs = await timestampProc.getLogs();
    const lastSync = timestampLogs.stdout?.trim();
    
    if (lastSync && lastSync.match(/^\d{4}-\d{2}-\d{2}/)) {
      return { success: true, lastSync, sanitized };
    } else {
      const logs = await proc.getLogs();
      return {
        success: false,
        error: 'Sync failed',
        details: logs.stderr || logs.stdout || 'No timestamp file created',
      };
    }
  } catch (err) {
    return {
      success: false,
      error: 'Sync error',
      details: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/**
 * Sync moltbot config to R2 with full protection mechanism.
 *
 * This function:
 * 1. Validates local vs remote completeness scores
 * 2. Blocks or warns on dangerous syncs
 * 3. Auto-creates snapshots before dangerous operations
 * 4. Records conflict alerts for admin UI
 *
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @param options - Sync options
 * @returns SyncResult with validation and protection details
 */
export async function syncToR2WithProtection(
  sandbox: Sandbox,
  env: MoltbotEnv,
  options: {
    force?: boolean;         // Force sync even if blocked
    skipValidation?: boolean; // Skip validation (for testing)
  } = {}
): Promise<SyncResult> {
  const config = getSyncValidatorConfig(env);

  // If protection disabled or skip validation, just run normal sync
  if (!config.enabled || options.skipValidation) {
    return syncToR2(sandbox, env);
  }

  // Validate the sync
  console.log('[Sync] Validating sync...');
  const validation = await validateSync(sandbox, env);

  console.log(`[Sync] Validation result: ${validation.action} (local: ${validation.localScore.score}, remote: ${validation.remoteScore.score})`);

  // Handle based on validation result
  if (validation.action === 'allow') {
    // Safe to sync
    const result = await syncToR2(sandbox, env);
    return { ...result, validation };
  }

  if (validation.action === 'warn' || validation.action === 'block') {
    // Dangerous sync detected
    console.log(`[Sync] Dangerous sync detected: ${validation.reason}`);

    // Handle the dangerous sync (create snapshot, record alert)
    const protection = await handleDangerousSync(sandbox, env, validation);

    // If blocked and not forced, return error
    if (protection.blocked && !options.force) {
      return {
        success: false,
        error: 'Sync blocked by protection',
        details: validation.reason,
        validation,
        blocked: true,
        snapshotId: protection.snapshotId,
        alertId: protection.alertId,
      };
    }

    // If forced or just warned, proceed with sync
    if (options.force || validation.action === 'warn') {
      console.log(`[Sync] Proceeding with sync (${options.force ? 'forced' : 'warned'})`);
      const result = await syncToR2(sandbox, env);
      return {
        ...result,
        validation,
        blocked: false,
        snapshotId: protection.snapshotId,
        alertId: protection.alertId,
      };
    }
  }

  // Default: block
  return {
    success: false,
    error: 'Sync blocked by protection',
    details: validation.reason,
    validation,
    blocked: true,
  };
}
