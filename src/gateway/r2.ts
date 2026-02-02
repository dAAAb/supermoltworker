import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { R2_MOUNT_PATH, R2_BUCKET_NAME } from '../config';

/** Maximum number of R2 mount retry attempts */
const R2_MOUNT_MAX_RETRIES = 3;

/** Base delay for exponential backoff (ms) */
const R2_MOUNT_BASE_DELAY_MS = 1000;

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if R2 is already mounted by looking at the mount table
 */
async function isR2Mounted(sandbox: Sandbox): Promise<boolean> {
  try {
    const proc = await sandbox.startProcess(`mount | grep "s3fs on ${R2_MOUNT_PATH}"`);
    // Wait for the command to complete
    let attempts = 0;
    while (proc.status === 'running' && attempts < 10) {
      await new Promise(r => setTimeout(r, 200));
      attempts++;
    }
    const logs = await proc.getLogs();
    // If stdout has content, the mount exists
    const mounted = !!(logs.stdout && logs.stdout.includes('s3fs'));
    console.log('isR2Mounted check:', mounted, 'stdout:', logs.stdout?.slice(0, 100));
    return mounted;
  } catch (err) {
    console.log('isR2Mounted error:', err);
    return false;
  }
}

/**
 * Mount R2 bucket for persistent storage with exponential backoff retry
 *
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns true if mounted successfully, false otherwise
 */
export async function mountR2Storage(sandbox: Sandbox, env: MoltbotEnv): Promise<boolean> {
  // Skip if R2 credentials are not configured
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    console.log('R2 storage not configured (missing R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, or CF_ACCOUNT_ID)');
    return false;
  }

  // Check if already mounted first - this avoids errors and is faster
  if (await isR2Mounted(sandbox)) {
    console.log('R2 bucket already mounted at', R2_MOUNT_PATH);
    return true;
  }

  // Attempt to mount with exponential backoff retry
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= R2_MOUNT_MAX_RETRIES; attempt++) {
    try {
      console.log(`[R2] Mounting bucket at ${R2_MOUNT_PATH} (attempt ${attempt}/${R2_MOUNT_MAX_RETRIES})`);
      await sandbox.mountBucket(R2_BUCKET_NAME, R2_MOUNT_PATH, {
        endpoint: `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        // Pass credentials explicitly since we use R2_* naming instead of AWS_*
        credentials: {
          accessKeyId: env.R2_ACCESS_KEY_ID,
          secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        },
      });
      console.log('[R2] Bucket mounted successfully - moltbot data will persist across sessions');
      return true;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.log(`[R2] Mount attempt ${attempt} failed:`, lastError.message);

      // Check if it's actually mounted despite the error
      if (await isR2Mounted(sandbox)) {
        console.log('[R2] Bucket is mounted despite error');
        return true;
      }

      // If not the last attempt, wait with exponential backoff before retrying
      if (attempt < R2_MOUNT_MAX_RETRIES) {
        const delayMs = R2_MOUNT_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(`[R2] Retrying in ${delayMs}ms...`);
        await sleep(delayMs);
      }
    }
  }

  // All retries exhausted
  console.error(`[R2] Failed to mount bucket after ${R2_MOUNT_MAX_RETRIES} attempts:`, lastError?.message);
  console.warn('[R2] Continuing without persistent storage - data will be lost on container restart');
  return false;
}
