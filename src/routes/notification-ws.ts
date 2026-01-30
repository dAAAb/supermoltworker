/**
 * SuperMoltWorker Notification WebSocket Route
 *
 * Provides real-time notification delivery to connected clients.
 * Clients connect via WebSocket to receive instant updates about:
 * - Evolution requests (moltbot wanting to modify config)
 * - Conflict detections
 * - Health warnings
 * - Snapshot events
 */

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { getNotificationManager } from '../gateway/notification';

const notificationWs = new Hono<AppEnv>();

/**
 * GET /ws/notifications - WebSocket endpoint for real-time notifications
 *
 * Connect with: ws://host/ws/notifications
 *
 * Messages sent to client:
 * - { type: 'init', payload: { notifications, pendingEvolutions } }
 * - { type: 'notification', payload: Notification }
 * - { type: 'evolution_update', payload: { requestId, status } }
 * - { type: 'notifications_cleared' }
 * - { type: 'pong' }
 *
 * Messages from client:
 * - { type: 'ping' }
 * - { type: 'mark_read', id: string }
 * - { type: 'dismiss', id: string }
 * - { type: 'clear_all' }
 */
notificationWs.get('/', async (c) => {
  // Check for WebSocket upgrade
  const upgradeHeader = c.req.header('Upgrade');
  if (upgradeHeader?.toLowerCase() !== 'websocket') {
    return c.json({
      error: 'WebSocket upgrade required',
      hint: 'Connect via WebSocket: ws://host/ws/notifications',
      messages: {
        serverToClient: [
          'init - Initial state with all notifications',
          'notification - New notification',
          'evolution_update - Evolution request status changed',
          'notifications_cleared - All notifications cleared',
          'pong - Response to ping',
        ],
        clientToServer: [
          'ping - Keep-alive ping',
          'mark_read - Mark notification as read',
          'dismiss - Dismiss notification',
          'clear_all - Clear all notifications',
        ],
      },
    });
  }

  // Create WebSocket pair
  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);

  // Accept the WebSocket
  server.accept();

  // Get notification manager
  const manager = getNotificationManager();

  // Register client
  const wsClient = manager.addClient(server);
  console.log('[WS] Client connected. Total clients:', manager.getClientCount());

  // Handle messages from client
  server.addEventListener('message', (event) => {
    try {
      const data = typeof event.data === 'string'
        ? JSON.parse(event.data)
        : event.data;

      switch (data.type) {
        case 'ping':
          server.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;

        case 'mark_read':
          if (data.id) {
            const success = manager.markAsRead(data.id);
            server.send(JSON.stringify({
              type: 'mark_read_result',
              id: data.id,
              success,
            }));
          }
          break;

        case 'dismiss':
          if (data.id) {
            const success = manager.dismiss(data.id);
            server.send(JSON.stringify({
              type: 'dismiss_result',
              id: data.id,
              success,
            }));
          }
          break;

        case 'clear_all':
          manager.clearAll();
          break;

        default:
          console.log('[WS] Unknown message type:', data.type);
      }
    } catch (err) {
      console.error('[WS] Failed to parse message:', err);
    }
  });

  // Handle close
  server.addEventListener('close', () => {
    manager.removeClient(wsClient);
    console.log('[WS] Client disconnected. Total clients:', manager.getClientCount());
  });

  // Handle error
  server.addEventListener('error', (err) => {
    console.error('[WS] WebSocket error:', err);
    manager.removeClient(wsClient);
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
});

/**
 * GET /ws/status - Get WebSocket connection status (non-WS endpoint)
 */
notificationWs.get('/status', (c) => {
  const manager = getNotificationManager();
  return c.json({
    connectedClients: manager.getClientCount(),
    pendingEvolutions: manager.getAllPendingEvolutions().length,
    unreadNotifications: manager.getAllNotifications().filter(n => !n.read).length,
  });
});

export { notificationWs };
