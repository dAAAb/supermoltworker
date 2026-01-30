/**
 * SuperMoltWorker Evolution API
 *
 * REST API for managing evolution requests (moltbot self-modification).
 */

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import {
  createEvolutionRequest,
  applyEvolution,
  rejectEvolution,
  loadCurrentConfig,
  previewEvolution,
  getEvolutionMode,
} from '../gateway/evolution';
import { analyzeRisk, generateDiffString } from '../gateway/risk-analyzer';
import { getNotificationManager } from '../gateway/notification';
import { createSnapshot, restoreSnapshot } from '../gateway/snapshot';

const evolutionApi = new Hono<AppEnv>();

/**
 * GET /api/admin/evolution - Get evolution system status
 */
evolutionApi.get('/', async (c) => {
  const manager = getNotificationManager();
  const mode = getEvolutionMode(c.env);

  return c.json({
    success: true,
    mode,
    pendingEvolutions: manager.getAllPendingEvolutions(),
    pendingCount: manager.getAllPendingEvolutions().length,
  });
});

/**
 * POST /api/admin/evolution/analyze - Analyze proposed config changes
 */
evolutionApi.post('/analyze', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    const body = await c.req.json() as { proposedConfig: Record<string, unknown> };

    if (!body.proposedConfig) {
      return c.json({ success: false, error: 'proposedConfig is required' }, 400);
    }

    const currentConfig = await loadCurrentConfig(sandbox);
    if (!currentConfig) {
      return c.json({ success: false, error: 'Cannot load current configuration' }, 500);
    }

    const analysis = analyzeRisk(currentConfig, body.proposedConfig);
    const diff = generateDiffString(analysis.changes);

    return c.json({
      success: true,
      analysis,
      diff,
      requiresConfirmation: analysis.requiresConfirmation,
    });
  } catch (err) {
    return c.json({
      success: false,
      error: err instanceof Error ? err.message : 'Invalid request',
    }, 400);
  }
});

/**
 * POST /api/admin/evolution/preview - Preview what an evolution would change
 */
evolutionApi.post('/preview', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    const body = await c.req.json() as { proposedConfig: Record<string, unknown> };

    if (!body.proposedConfig) {
      return c.json({ success: false, error: 'proposedConfig is required' }, 400);
    }

    const currentConfig = await loadCurrentConfig(sandbox);
    if (!currentConfig) {
      return c.json({ success: false, error: 'Cannot load current configuration' }, 500);
    }

    const preview = previewEvolution(currentConfig, body.proposedConfig);

    return c.json({
      success: true,
      ...preview,
    });
  } catch (err) {
    return c.json({
      success: false,
      error: err instanceof Error ? err.message : 'Invalid request',
    }, 400);
  }
});

/**
 * POST /api/admin/evolution/request - Create a new evolution request
 *
 * This endpoint is called when moltbot (or another system) wants to
 * modify the configuration. It creates a request that may require
 * user approval depending on risk level and evolution mode.
 */
evolutionApi.post('/request', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    const body = await c.req.json() as {
      proposedConfig: Record<string, unknown>;
      reason?: string;
      source?: {
        channel: string;
        channelId?: string;
        userId?: string;
        userName?: string;
        messageId?: string;
      };
      autoApproveIfSafe?: boolean;
    };

    if (!body.proposedConfig) {
      return c.json({ success: false, error: 'proposedConfig is required' }, 400);
    }

    const result = await createEvolutionRequest(sandbox, c.env, body.proposedConfig, {
      source: body.source as any,
      reason: body.reason,
      autoApproveIfSafe: body.autoApproveIfSafe ?? true,
    });

    return c.json({
      success: true,
      requestId: result.request.id,
      status: result.request.status,
      autoApproved: result.autoApproved,
      analysis: result.request.analysis,
      snapshotId: result.request.snapshotId,
      requiresConfirmation: !result.autoApproved,
    });
  } catch (err) {
    return c.json({
      success: false,
      error: err instanceof Error ? err.message : 'Failed to create evolution request',
    }, 500);
  }
});

/**
 * POST /api/admin/evolution/:id/approve - Approve an evolution request
 */
evolutionApi.post('/:id/approve', async (c) => {
  const sandbox = c.get('sandbox');
  const requestId = c.req.param('id');

  const manager = getNotificationManager();
  const pendingEvolution = manager.getPendingEvolution(requestId);

  if (!pendingEvolution) {
    return c.json({ success: false, error: 'Evolution request not found' }, 404);
  }

  // Update status
  manager.updateEvolutionStatus(requestId, 'approved', { channel: 'admin_ui' });

  // Note: In a full implementation, we would retrieve the full request
  // including proposedConfig and apply it. For now, we just update the status.

  return c.json({
    success: true,
    message: '進化已批准',
    requestId,
    status: 'approved',
    hint: 'Full apply implementation pending - config changes stored with notification',
  });
});

/**
 * POST /api/admin/evolution/:id/reject - Reject an evolution request
 */
evolutionApi.post('/:id/reject', async (c) => {
  const requestId = c.req.param('id');

  const result = await rejectEvolution(requestId, { channel: 'admin_ui' });

  if (!result.success) {
    return c.json({ success: false, error: result.error }, 404);
  }

  return c.json({
    success: true,
    message: '進化已拒絕',
    requestId,
    status: 'rejected',
  });
});

/**
 * POST /api/admin/evolution/:id/test - Test evolution in sandbox
 *
 * Creates a temporary test of the evolution without permanently applying it.
 */
evolutionApi.post('/:id/test', async (c) => {
  const sandbox = c.get('sandbox');
  const requestId = c.req.param('id');

  const manager = getNotificationManager();
  const pendingEvolution = manager.getPendingEvolution(requestId);

  if (!pendingEvolution) {
    return c.json({ success: false, error: 'Evolution request not found' }, 404);
  }

  // Update status to testing
  manager.updateEvolutionStatus(requestId, 'testing', { channel: 'admin_ui' });

  // In a full implementation, we would:
  // 1. Create a snapshot
  // 2. Apply the changes
  // 3. Run health checks
  // 4. Rollback to snapshot
  // 5. Report results

  return c.json({
    success: true,
    message: '正在測試進化...',
    requestId,
    status: 'testing',
    hint: '完整測試功能將在後續版本實作',
  });
});

/**
 * POST /api/admin/evolution/:id/rollback - Rollback a failed evolution
 */
evolutionApi.post('/:id/rollback', async (c) => {
  const sandbox = c.get('sandbox');
  const requestId = c.req.param('id');

  // Get the snapshot ID associated with this evolution
  // In a full implementation, this would be stored with the request

  return c.json({
    success: false,
    error: 'Rollback requires snapshot ID - use /api/admin/snapshots/:id/restore instead',
    hint: 'Retrieve the snapshot ID from the evolution request notification',
  }, 400);
});

/**
 * GET /api/admin/evolution/history - Get evolution history
 */
evolutionApi.get('/history', async (c) => {
  const manager = getNotificationManager();

  // Get all evolution-related notifications
  const allNotifications = manager.getAllNotifications(true);
  const evolutionNotifications = allNotifications.filter(n =>
    n.type === 'evolution_request' ||
    n.type === 'evolution_approved' ||
    n.type === 'evolution_rejected'
  );

  return c.json({
    success: true,
    history: evolutionNotifications.map(n => ({
      id: n.id,
      type: n.type,
      timestamp: n.timestamp,
      title: n.title,
      message: n.message,
      source: n.source,
      data: n.data,
    })),
    count: evolutionNotifications.length,
  });
});

/**
 * GET /api/admin/evolution/pending - Get all pending evolution requests
 */
evolutionApi.get('/pending', async (c) => {
  const manager = getNotificationManager();
  const pending = manager.getAllPendingEvolutions();

  return c.json({
    success: true,
    pending,
    count: pending.length,
  });
});

export { evolutionApi };
