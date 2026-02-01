import { Hono } from 'hono';
import type { AppEnv } from '../types';
import {
  createSnapshot,
  listSnapshots,
  getSnapshot,
  restoreSnapshot,
  deleteSnapshot,
  compareSnapshot,
  loadSnapshotIndex,
} from '../gateway/snapshot';

/**
 * Snapshot API routes
 * All routes are protected by Cloudflare Access (middleware applied in parent router)
 */
const snapshotApi = new Hono<AppEnv>();

/**
 * GET /api/admin/snapshots - List all snapshots
 */
snapshotApi.get('/', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    const result = await listSnapshots(sandbox, c.env);

    if (!result.success) {
      return c.json({ error: result.error }, 500);
    }

    return c.json({
      success: true,
      snapshots: result.snapshots,
      count: result.snapshots?.length || 0,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

/**
 * POST /api/admin/snapshots - Create a new snapshot
 * Body: { description?: string, trigger?: 'manual' | 'auto' | 'pre-evolution' | 'pre-sync' | 'pre-restart' }
 */
snapshotApi.post('/', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    const body = await c.req.json().catch(() => ({}));
    const { description, trigger } = body as {
      description?: string;
      trigger?: 'manual' | 'auto' | 'pre-evolution' | 'pre-sync' | 'pre-restart';
    };

    const result = await createSnapshot(sandbox, c.env, {
      description,
      trigger: trigger || 'manual',
    });

    if (!result.success) {
      return c.json({ error: result.error, details: result.details }, 500);
    }

    return c.json({
      success: true,
      snapshot: result.snapshot,
      message: `Snapshot ${result.snapshot?.id} created successfully`,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

/**
 * GET /api/admin/snapshots/index - Get snapshot index (lightweight)
 */
snapshotApi.get('/index', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    const index = await loadSnapshotIndex(sandbox);
    return c.json({
      success: true,
      ...index,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

/**
 * GET /api/admin/snapshots/:id - Get snapshot details
 */
snapshotApi.get('/:id', async (c) => {
  const sandbox = c.get('sandbox');
  const snapshotId = c.req.param('id');

  if (!snapshotId) {
    return c.json({ error: 'Snapshot ID is required' }, 400);
  }

  try {
    const result = await getSnapshot(sandbox, c.env, snapshotId);

    if (!result.success) {
      const status = result.error === 'Snapshot not found' ? 404 : 500;
      return c.json({ error: result.error }, status);
    }

    return c.json({
      success: true,
      snapshot: result.snapshot,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

/**
 * POST /api/admin/snapshots/:id/restore - Restore a snapshot
 */
snapshotApi.post('/:id/restore', async (c) => {
  const sandbox = c.get('sandbox');
  const snapshotId = c.req.param('id');

  if (!snapshotId) {
    return c.json({ error: 'Snapshot ID is required' }, 400);
  }

  try {
    const result = await restoreSnapshot(sandbox, c.env, snapshotId);

    if (!result.success) {
      const status = result.error === 'Snapshot not found' ? 404 : 500;
      return c.json({ error: result.error, details: result.details }, status);
    }

    return c.json({
      success: true,
      snapshot: result.snapshot,
      message: `Snapshot ${snapshotId} restored successfully. You may need to restart the gateway for changes to take effect.`,
      requiresRestart: true,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

/**
 * DELETE /api/admin/snapshots/:id - Delete a snapshot
 */
snapshotApi.delete('/:id', async (c) => {
  const sandbox = c.get('sandbox');
  const snapshotId = c.req.param('id');

  if (!snapshotId) {
    return c.json({ error: 'Snapshot ID is required' }, 400);
  }

  try {
    const result = await deleteSnapshot(sandbox, c.env, snapshotId);

    if (!result.success) {
      const status = result.error === 'Snapshot not found' ? 404 : 500;
      return c.json({ error: result.error }, status);
    }

    return c.json({
      success: true,
      message: `Snapshot ${snapshotId} deleted successfully`,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

/**
 * GET /api/admin/snapshots/:id/compare - Compare snapshot with current state
 * Query params: compareToId (optional) - compare with another snapshot instead of current state
 */
snapshotApi.get('/:id/compare', async (c) => {
  const sandbox = c.get('sandbox');
  const snapshotId = c.req.param('id');
  const compareToId = c.req.query('compareToId');

  if (!snapshotId) {
    return c.json({ error: 'Snapshot ID is required' }, 400);
  }

  try {
    const result = await compareSnapshot(
      sandbox,
      c.env,
      snapshotId,
      compareToId || undefined
    );

    if (!result.success) {
      return c.json({ error: result.error }, 500);
    }

    return c.json({
      success: true,
      snapshotId,
      compareToId: compareToId || 'current',
      diff: result.diff,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

export { snapshotApi };
