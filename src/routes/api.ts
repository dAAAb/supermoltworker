import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createAccessMiddleware } from '../auth';
import { ensureMoltbotGateway, findExistingMoltbotProcess, mountR2Storage, syncToR2, waitForProcess } from '../gateway';
import { syncToR2WithProtection } from '../gateway/sync';
import { createSnapshot } from '../gateway/snapshot';
import {
  validateSync,
  getSyncStatus,
  getConflictAlerts,
  resolveConflictAlert,
} from '../gateway/sync-validator';
import { snapshotApi } from './snapshot-api';
import { notificationApi } from './notification-api';
import { healthApi } from './health-api';
import { evolutionApi } from './evolution-api';
import { settingsSyncApi } from './settings-sync-api';
import { R2_MOUNT_PATH } from '../config';

// CLI commands can take 10-15 seconds to complete due to WebSocket connection overhead
const CLI_TIMEOUT_MS = 20000;

/**
 * API routes
 * - /api/admin/* - Protected admin API routes (Cloudflare Access required)
 * 
 * Note: /api/status is now handled by publicRoutes (no auth required)
 */
const api = new Hono<AppEnv>();

/**
 * Admin API routes - all protected by Cloudflare Access
 */
const adminApi = new Hono<AppEnv>();

// Middleware: Verify Cloudflare Access JWT for all admin routes
adminApi.use('*', createAccessMiddleware({ type: 'json' }));

// GET /api/admin/devices - List pending and paired devices
adminApi.get('/devices', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // Run moltbot CLI to list devices (CLI is still named clawdbot until upstream renames)
    // Must specify --url to connect to the gateway running in the same container
    const proc = await sandbox.startProcess('clawdbot devices list --json --url ws://localhost:18789');
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';

    // Try to parse JSON output
    try {
      // Find JSON in output (may have other log lines)
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        return c.json(data);
      }

      // If no JSON found, return raw output for debugging
      return c.json({
        pending: [],
        paired: [],
        raw: stdout,
        stderr,
      });
    } catch {
      return c.json({
        pending: [],
        paired: [],
        raw: stdout,
        stderr,
        parseError: 'Failed to parse CLI output',
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/devices/:requestId/approve - Approve a pending device
adminApi.post('/devices/:requestId/approve', async (c) => {
  const sandbox = c.get('sandbox');
  const requestId = c.req.param('requestId');

  if (!requestId) {
    return c.json({ error: 'requestId is required' }, 400);
  }

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // Run moltbot CLI to approve the device (CLI is still named clawdbot)
    const proc = await sandbox.startProcess(`clawdbot devices approve ${requestId} --url ws://localhost:18789`);
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';

    // Check for success indicators (case-insensitive, CLI outputs "Approved ...")
    const success = stdout.toLowerCase().includes('approved') || proc.exitCode === 0;

    return c.json({
      success,
      requestId,
      message: success ? 'Device approved' : 'Approval may have failed',
      stdout,
      stderr,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/devices/approve-all - Approve all pending devices
adminApi.post('/devices/approve-all', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // First, get the list of pending devices (CLI is still named clawdbot)
    const listProc = await sandbox.startProcess('clawdbot devices list --json --url ws://localhost:18789');
    await waitForProcess(listProc, CLI_TIMEOUT_MS);

    const listLogs = await listProc.getLogs();
    const stdout = listLogs.stdout || '';

    // Parse pending devices
    let pending: Array<{ requestId: string }> = [];
    try {
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        pending = data.pending || [];
      }
    } catch {
      return c.json({ error: 'Failed to parse device list', raw: stdout }, 500);
    }

    if (pending.length === 0) {
      return c.json({ approved: [], message: 'No pending devices to approve' });
    }

    // Approve each pending device
    const results: Array<{ requestId: string; success: boolean; error?: string }> = [];

    for (const device of pending) {
      try {
        const approveProc = await sandbox.startProcess(`clawdbot devices approve ${device.requestId} --url ws://localhost:18789`);
        await waitForProcess(approveProc, CLI_TIMEOUT_MS);

        const approveLogs = await approveProc.getLogs();
        const success = approveLogs.stdout?.toLowerCase().includes('approved') || approveProc.exitCode === 0;

        results.push({ requestId: device.requestId, success });
      } catch (err) {
        results.push({
          requestId: device.requestId,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    const approvedCount = results.filter(r => r.success).length;
    return c.json({
      approved: results.filter(r => r.success).map(r => r.requestId),
      failed: results.filter(r => !r.success),
      message: `Approved ${approvedCount} of ${pending.length} device(s)`,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/storage - Get R2 storage status and last sync time
adminApi.get('/storage', async (c) => {
  const sandbox = c.get('sandbox');
  const hasCredentials = !!(
    c.env.R2_ACCESS_KEY_ID && 
    c.env.R2_SECRET_ACCESS_KEY && 
    c.env.CF_ACCOUNT_ID
  );

  // Check which credentials are missing
  const missing: string[] = [];
  if (!c.env.R2_ACCESS_KEY_ID) missing.push('R2_ACCESS_KEY_ID');
  if (!c.env.R2_SECRET_ACCESS_KEY) missing.push('R2_SECRET_ACCESS_KEY');
  if (!c.env.CF_ACCOUNT_ID) missing.push('CF_ACCOUNT_ID');

  let lastSync: string | null = null;

  // If R2 is configured, check for last sync timestamp
  if (hasCredentials) {
    try {
      // Mount R2 if not already mounted
      await mountR2Storage(sandbox, c.env);
      
      // Check for sync marker file
      const proc = await sandbox.startProcess(`cat ${R2_MOUNT_PATH}/.last-sync 2>/dev/null || echo ""`);
      await waitForProcess(proc, 5000);
      const logs = await proc.getLogs();
      const timestamp = logs.stdout?.trim();
      if (timestamp && timestamp !== '') {
        lastSync = timestamp;
      }
    } catch {
      // Ignore errors checking sync status
    }
  }

  return c.json({
    configured: hasCredentials,
    missing: missing.length > 0 ? missing : undefined,
    lastSync,
    message: hasCredentials 
      ? 'R2 storage is configured. Your data will persist across container restarts.'
      : 'R2 storage is not configured. Paired devices and conversations will be lost when the container restarts.',
  });
});

// POST /api/admin/storage/sync - Trigger a manual sync to R2
// SuperMoltWorker: Enhanced with sync protection
adminApi.post('/storage/sync', async (c) => {
  const sandbox = c.get('sandbox');

  // Parse options from request body
  const body = await c.req.json().catch(() => ({})) as {
    force?: boolean;           // Force sync even if blocked
    skipValidation?: boolean;  // Skip validation (for testing)
  };

  const result = await syncToR2WithProtection(sandbox, c.env, {
    force: body.force,
    skipValidation: body.skipValidation,
  });

  if (result.success) {
    return c.json({
      success: true,
      message: 'Sync completed successfully',
      lastSync: result.lastSync,
      validation: result.validation,
      snapshotId: result.snapshotId,
    });
  } else {
    // Different status codes based on reason
    let status: 400 | 409 | 500 = 500;
    if (result.error?.includes('not configured')) {
      status = 400;
    } else if (result.blocked) {
      status = 409; // Conflict - sync was blocked by protection
    }

    return c.json({
      success: false,
      error: result.error,
      details: result.details,
      blocked: result.blocked,
      validation: result.validation,
      snapshotId: result.snapshotId,
      alertId: result.alertId,
    }, status);
  }
});

// GET /api/admin/sync/status - Get current sync status and protection info
// SuperMoltWorker: Sync protection status endpoint
adminApi.get('/sync/status', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    const status = await getSyncStatus(sandbox, c.env);
    return c.json({
      success: true,
      ...status,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: errorMessage }, 500);
  }
});

// POST /api/admin/sync/validate - Validate a sync before executing
// SuperMoltWorker: Pre-sync validation endpoint
adminApi.post('/sync/validate', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    const decision = await validateSync(sandbox, c.env);
    return c.json({
      success: true,
      decision,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: errorMessage }, 500);
  }
});

// GET /api/admin/conflicts - Get conflict alerts
// SuperMoltWorker: Conflict alerts endpoint
adminApi.get('/conflicts', async (c) => {
  const sandbox = c.get('sandbox');
  const includeResolved = c.req.query('includeResolved') === 'true';

  try {
    const alerts = await getConflictAlerts(sandbox, c.env, includeResolved);
    return c.json({
      success: true,
      alerts,
      count: alerts.length,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: errorMessage }, 500);
  }
});

// POST /api/admin/conflicts/:id/resolve - Resolve a conflict alert
// SuperMoltWorker: Resolve conflict endpoint
adminApi.post('/conflicts/:id/resolve', async (c) => {
  const sandbox = c.get('sandbox');
  const alertId = c.req.param('id');

  if (!alertId) {
    return c.json({ success: false, error: 'Alert ID is required' }, 400);
  }

  try {
    const resolved = await resolveConflictAlert(sandbox, c.env, alertId, 'user');
    if (resolved) {
      return c.json({
        success: true,
        message: 'Alert resolved',
        alertId,
      });
    } else {
      return c.json({
        success: false,
        error: 'Alert not found or could not be resolved',
      }, 404);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: errorMessage }, 500);
  }
});

// POST /api/admin/gateway/restart - Kill the current gateway and start a new one
// SuperMoltWorker: Safe restart mechanism - creates snapshot and syncs to R2 before restart
adminApi.post('/gateway/restart', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Parse options from request body
    const options = await c.req.json().catch(() => ({})) as {
      skipSnapshot?: boolean;   // Skip creating snapshot (default: false)
      skipSync?: boolean;       // Skip R2 sync (default: false)
      description?: string;     // Custom snapshot description
    };

    let snapshotId: string | undefined;
    let syncResult: { success: boolean; lastSync?: string } | undefined;

    // =========================================
    // SUPERMOLTWORKER: SAFE RESTART MECHANISM
    // =========================================

    // Step 1: Create pre-restart snapshot (救命符)
    if (!options.skipSnapshot) {
      console.log('[restart] Creating pre-restart snapshot...');
      try {
        const snapshotResult = await createSnapshot(sandbox, c.env, {
          trigger: 'pre-restart' as const,
          description: options.description || 'Auto snapshot before gateway restart',
        });
        if (snapshotResult.success && snapshotResult.snapshot) {
          snapshotId = snapshotResult.snapshot.id;
          console.log(`[restart] Snapshot created: ${snapshotId}`);
        } else {
          console.warn('[restart] Snapshot creation failed:', snapshotResult.error);
        }
      } catch (snapshotErr) {
        console.warn('[restart] Snapshot creation error (non-fatal):', snapshotErr);
      }
    }

    // Step 2: Sync to R2 (確保配置不丟失)
    if (!options.skipSync) {
      console.log('[restart] Syncing to R2 before restart...');
      try {
        syncResult = await syncToR2(sandbox, c.env);
        if (syncResult.success) {
          console.log(`[restart] R2 sync completed at ${syncResult.lastSync}`);
        } else {
          console.warn('[restart] R2 sync failed (non-fatal)');
        }
      } catch (syncErr) {
        console.warn('[restart] R2 sync error (non-fatal):', syncErr);
      }
    }

    // Step 3: Find and kill the existing gateway process
    const existingProcess = await findExistingMoltbotProcess(sandbox);

    if (existingProcess) {
      console.log('[restart] Killing existing gateway process:', existingProcess.id);
      try {
        await existingProcess.kill();
      } catch (killErr) {
        console.error('[restart] Error killing process:', killErr);
      }
      // Wait a moment for the process to die
      await new Promise(r => setTimeout(r, 2000));
    }

    // Step 4: Start a new gateway in the background
    const bootPromise = ensureMoltbotGateway(sandbox, c.env).catch((err) => {
      console.error('[restart] Gateway restart failed:', err);
    });
    c.executionCtx.waitUntil(bootPromise);

    // Return response with snapshot info for recovery
    return c.json({
      success: true,
      message: existingProcess
        ? 'Gateway process killed, new instance starting...'
        : 'No existing process found, starting new instance...',
      previousProcessId: existingProcess?.id,
      // SuperMoltWorker: Include recovery info
      safeRestart: {
        snapshotId,
        snapshotCreated: !!snapshotId,
        syncedToR2: syncResult?.success ?? false,
        lastSync: syncResult?.lastSync,
        recoveryHint: snapshotId
          ? `If something goes wrong, restore snapshot ${snapshotId} from Admin UI → Memory`
          : 'No snapshot was created. Consider creating one manually if needed.',
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// Mount snapshot API routes under /admin/snapshots
adminApi.route('/snapshots', snapshotApi);

// Mount notification API routes under /admin/notifications
// SuperMoltWorker: Real-time notifications and evolution management
adminApi.route('/notifications', notificationApi);

// Mount health API routes under /admin/health
// SuperMoltWorker: Health checks and conflict detection
adminApi.route('/health', healthApi);

// Mount evolution API routes under /admin/evolution
// SuperMoltWorker: Evolution protection and management
adminApi.route('/evolution', evolutionApi);

// Mount settings sync API routes under /admin/settings
// SuperMoltWorker: Environment variable sync management
adminApi.route('/settings', settingsSyncApi);

// POST /api/admin/reset - Complete reset of moltbot state
// SuperMoltWorker: Reset wizard backend
adminApi.post('/reset', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    const body = await c.req.json() as {
      preserveConversations?: boolean;
      preservePairedDevices?: boolean;
      preserveCustomSkills?: boolean;
    };

    const CONFIG_PATH = '/root/.clawdbot/clawdbot.json';
    const SKILLS_PATH = '/root/.clawdbot/skills';

    // Build reset commands based on preserve options
    const commands: string[] = [];

    // Reset config to default (preserve model settings from env)
    commands.push(`cat > ${CONFIG_PATH} << 'DEFAULTCONFIG'
{
  "workspace": "/root/workspace",
  "agent": {
    "defaults": {
      "model": ""
    }
  },
  "channels": {}
}
DEFAULTCONFIG`);

    // Clear conversations if not preserving
    if (!body.preserveConversations) {
      commands.push('rm -rf /root/.clawdbot/conversations/* 2>/dev/null || true');
    }

    // Clear paired devices if not preserving
    if (!body.preservePairedDevices) {
      // Device data is stored in the gateway state, need to reset via CLI
      commands.push('rm -rf /root/.clawdbot/devices/* 2>/dev/null || true');
      commands.push('rm -f /root/.clawdbot/*.db 2>/dev/null || true');
    }

    // Clear skills if not preserving
    if (!body.preserveCustomSkills) {
      commands.push(`rm -rf ${SKILLS_PATH}/* 2>/dev/null || true`);
    }

    // Execute reset commands
    const fullCommand = commands.join(' && ');
    const proc = await sandbox.startProcess(fullCommand);
    await waitForProcess(proc, 30000);

    const logs = await proc.getLogs();

    if (proc.exitCode !== 0) {
      return c.json({
        success: false,
        error: 'Reset commands failed',
        details: logs.stderr,
      }, 500);
    }

    return c.json({
      success: true,
      message: 'Reset completed successfully',
      preserved: {
        conversations: body.preserveConversations ?? false,
        pairedDevices: body.preservePairedDevices ?? false,
        customSkills: body.preserveCustomSkills ?? false,
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// Mount admin API routes under /admin
api.route('/admin', adminApi);

export { api };
