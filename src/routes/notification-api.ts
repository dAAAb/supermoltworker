/**
 * SuperMoltWorker Notification API
 *
 * REST API for managing notifications and evolution requests.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { getNotificationManager } from '../gateway/notification';

const notificationApi = new Hono<AppEnv>();

/**
 * GET /api/admin/notifications - List all notifications
 */
notificationApi.get('/', async (c) => {
  const manager = getNotificationManager();
  const includeDismissed = c.req.query('includeDismissed') === 'true';
  const notifications = manager.getAllNotifications(includeDismissed);

  return c.json({
    success: true,
    notifications,
    count: notifications.length,
    unreadCount: notifications.filter(n => !n.read).length,
  });
});

/**
 * GET /api/admin/notifications/:id - Get single notification
 */
notificationApi.get('/:id', async (c) => {
  const id = c.req.param('id');
  const manager = getNotificationManager();
  const notification = manager.getNotification(id);

  if (!notification) {
    return c.json({ success: false, error: 'Notification not found' }, 404);
  }

  return c.json({ success: true, notification });
});

/**
 * POST /api/admin/notifications/:id/read - Mark notification as read
 */
notificationApi.post('/:id/read', async (c) => {
  const id = c.req.param('id');
  const manager = getNotificationManager();
  const success = manager.markAsRead(id);

  if (!success) {
    return c.json({ success: false, error: 'Notification not found' }, 404);
  }

  return c.json({ success: true });
});

/**
 * POST /api/admin/notifications/:id/dismiss - Dismiss notification
 */
notificationApi.post('/:id/dismiss', async (c) => {
  const id = c.req.param('id');
  const manager = getNotificationManager();
  const success = manager.dismiss(id);

  if (!success) {
    return c.json({ success: false, error: 'Notification not found' }, 404);
  }

  return c.json({ success: true });
});

/**
 * DELETE /api/admin/notifications - Clear all notifications
 */
notificationApi.delete('/', async (c) => {
  const manager = getNotificationManager();
  manager.clearAll();

  return c.json({ success: true });
});

/**
 * GET /api/admin/notifications/evolutions - List pending evolution requests
 */
notificationApi.get('/evolutions', async (c) => {
  const manager = getNotificationManager();
  const evolutions = manager.getAllPendingEvolutions();

  return c.json({
    success: true,
    evolutions,
    count: evolutions.length,
  });
});

/**
 * GET /api/admin/notifications/evolutions/:id - Get evolution request details
 */
notificationApi.get('/evolutions/:id', async (c) => {
  const id = c.req.param('id');
  const manager = getNotificationManager();
  const evolution = manager.getPendingEvolution(id);

  if (!evolution) {
    return c.json({ success: false, error: 'Evolution request not found' }, 404);
  }

  return c.json({ success: true, evolution });
});

/**
 * POST /api/admin/evolution/:id/approve - Approve evolution request
 *
 * This endpoint will be fully implemented in Phase 4.
 * For now, it just updates the notification status.
 */
notificationApi.post('/evolution/:id/approve', async (c) => {
  const id = c.req.param('id');
  const manager = getNotificationManager();

  const evolution = manager.updateEvolutionStatus(id, 'approved', {
    channel: 'admin_ui',
  });

  if (!evolution) {
    return c.json({ success: false, error: 'Evolution request not found' }, 404);
  }

  // TODO Phase 4: Actually apply the evolution changes
  console.log('[Evolution] Approved:', id);

  return c.json({
    success: true,
    message: '進化已批准',
    evolution,
  });
});

/**
 * POST /api/admin/evolution/:id/reject - Reject evolution request
 */
notificationApi.post('/evolution/:id/reject', async (c) => {
  const id = c.req.param('id');
  const manager = getNotificationManager();

  const evolution = manager.updateEvolutionStatus(id, 'rejected', {
    channel: 'admin_ui',
  });

  if (!evolution) {
    return c.json({ success: false, error: 'Evolution request not found' }, 404);
  }

  // TODO Phase 4: Notify moltbot that the evolution was rejected
  console.log('[Evolution] Rejected:', id);

  return c.json({
    success: true,
    message: '進化已拒絕',
    evolution,
  });
});

/**
 * POST /api/admin/evolution/:id/test - Test evolution in sandbox
 *
 * This endpoint will be implemented in Phase 4.
 */
notificationApi.post('/evolution/:id/test', async (c) => {
  const id = c.req.param('id');
  const manager = getNotificationManager();

  const evolution = manager.updateEvolutionStatus(id, 'testing', {
    channel: 'admin_ui',
  });

  if (!evolution) {
    return c.json({ success: false, error: 'Evolution request not found' }, 404);
  }

  // TODO Phase 4: Run evolution in isolated test environment
  console.log('[Evolution] Testing:', id);

  return c.json({
    success: true,
    message: '正在測試進化...',
    evolution,
    hint: '測試功能將在 Phase 4 完整實作',
  });
});

/**
 * GET /api/admin/notifications/status - Get notification system status
 */
notificationApi.get('/status', async (c) => {
  const manager = getNotificationManager();

  return c.json({
    success: true,
    connectedClients: manager.getClientCount(),
    pendingEvolutions: manager.getAllPendingEvolutions().length,
    totalNotifications: manager.getAllNotifications(true).length,
    unreadNotifications: manager.getAllNotifications().filter(n => !n.read).length,
  });
});

export { notificationApi };
