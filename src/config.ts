/**
 * Configuration constants for Moltbot Sandbox
 */

/** Port that the Moltbot gateway listens on inside the container */
export const MOLTBOT_PORT = 18789;

/** Maximum time to wait for Moltbot to start (3 minutes) */
export const STARTUP_TIMEOUT_MS = 180_000;

/** Mount path for R2 persistent storage inside the container */
export const R2_MOUNT_PATH = '/data/moltbot';

/** R2 bucket name for persistent storage - using super-moltbot-data for SuperMoltWorker */
export const R2_BUCKET_NAME = 'super-moltbot-data';
