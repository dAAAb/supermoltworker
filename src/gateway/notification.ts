/**
 * SuperMoltWorker Notification System
 *
 * Real-time notification system for evolution requests, conflicts, and health warnings.
 * Notifications can originate from any channel (Telegram, LINE, Discord, Admin UI)
 * and are broadcast to all connected WebSocket clients.
 */

/**
 * Notification types
 */
export type NotificationType =
  | 'evolution_request'    // moltbot wants to modify config
  | 'evolution_approved'   // user approved evolution
  | 'evolution_rejected'   // user rejected evolution
  | 'conflict_detected'    // startup conflict found
  | 'health_warning'       // health check failed
  | 'snapshot_created'     // auto/manual snapshot created
  | 'snapshot_restored'    // snapshot was restored
  | 'sync_completed';      // R2 sync completed

export type NotificationSeverity = 'info' | 'warning' | 'critical';

export type NotificationActionType =
  | 'approve'   // approve evolution request
  | 'reject'    // reject evolution request
  | 'test'      // test evolution in sandbox
  | 'view'      // view details
  | 'dismiss';  // dismiss notification

/**
 * Action that can be taken on a notification
 */
export interface NotificationAction {
  label: string;
  action: NotificationActionType;
  endpoint?: string;  // API endpoint to call
  data?: Record<string, unknown>;  // Data to send
}

/**
 * Source channel information
 */
export interface NotificationSource {
  channel: 'telegram' | 'discord' | 'slack' | 'line' | 'admin_ui' | 'system';
  channelId?: string;      // Chat/channel ID for reply
  userId?: string;         // User who triggered the action
  userName?: string;       // Display name
  messageId?: string;      // Original message ID for reply
}

/**
 * Evolution request details
 */
export interface EvolutionDetails {
  requestId: string;
  targetPath: string;      // e.g., "models.providers.anthropic"
  riskLevel: 'safe' | 'medium' | 'high';
  changes: {
    path: string;
    oldValue: unknown;
    newValue: unknown;
  }[];
  snapshotId?: string;     // Pre-evolution snapshot ID
  reason?: string;         // Why moltbot wants to make this change
}

/**
 * Notification payload
 */
export interface Notification {
  id: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  message: string;
  timestamp: string;
  source?: NotificationSource;
  actions?: NotificationAction[];
  data?: {
    evolution?: EvolutionDetails;
    snapshotId?: string;
    conflictReport?: unknown;
    healthReport?: unknown;
  };
  read: boolean;
  dismissed: boolean;
}

/**
 * Pending evolution request (waiting for user approval)
 */
export interface PendingEvolution {
  id: string;
  notification: Notification;
  createdAt: string;
  expiresAt?: string;      // Auto-reject after this time
  status: 'pending' | 'approved' | 'rejected' | 'testing' | 'expired';
}

/**
 * Connected WebSocket client
 */
interface WSClient {
  socket: WebSocket;
  connectedAt: string;
  lastPing: string;
}

/**
 * Notification Manager
 *
 * Manages notifications and broadcasts to connected WebSocket clients.
 * Stored in container memory (volatile) since notifications are transient.
 */
class NotificationManager {
  private notifications: Map<string, Notification> = new Map();
  private pendingEvolutions: Map<string, PendingEvolution> = new Map();
  private clients: Set<WSClient> = new Set();
  private maxNotifications = 100;
  private evolutionTimeout = 5 * 60 * 1000; // 5 minutes

  /**
   * Generate unique notification ID
   */
  private generateId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `notif-${timestamp}-${random}`;
  }

  /**
   * Add a new notification and broadcast to clients
   */
  addNotification(
    type: NotificationType,
    title: string,
    message: string,
    options: {
      severity?: NotificationSeverity;
      source?: NotificationSource;
      actions?: NotificationAction[];
      data?: Notification['data'];
    } = {}
  ): Notification {
    const id = this.generateId();
    const notification: Notification = {
      id,
      type,
      severity: options.severity || 'info',
      title,
      message,
      timestamp: new Date().toISOString(),
      source: options.source,
      actions: options.actions,
      data: options.data,
      read: false,
      dismissed: false,
    };

    this.notifications.set(id, notification);
    this.enforceMaxNotifications();
    this.broadcast({ type: 'notification', payload: notification });

    return notification;
  }

  /**
   * Create an evolution request notification
   */
  createEvolutionRequest(
    details: EvolutionDetails,
    source?: NotificationSource
  ): PendingEvolution {
    const notification = this.addNotification(
      'evolution_request',
      '小龍蝦想要進化！',
      `正在嘗試修改 ${details.targetPath}`,
      {
        severity: details.riskLevel === 'high' ? 'critical' :
                  details.riskLevel === 'medium' ? 'warning' : 'info',
        source,
        actions: [
          { label: '允許', action: 'approve', endpoint: `/api/admin/evolution/${details.requestId}/approve` },
          { label: '拒絕', action: 'reject', endpoint: `/api/admin/evolution/${details.requestId}/reject` },
          { label: '先測試', action: 'test', endpoint: `/api/admin/evolution/${details.requestId}/test` },
        ],
        data: { evolution: details },
      }
    );

    const pendingEvolution: PendingEvolution = {
      id: details.requestId,
      notification,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.evolutionTimeout).toISOString(),
      status: 'pending',
    };

    this.pendingEvolutions.set(details.requestId, pendingEvolution);
    return pendingEvolution;
  }

  /**
   * Update evolution request status
   */
  updateEvolutionStatus(
    requestId: string,
    status: PendingEvolution['status'],
    source?: NotificationSource
  ): PendingEvolution | null {
    const evolution = this.pendingEvolutions.get(requestId);
    if (!evolution) return null;

    evolution.status = status;

    // Add result notification
    if (status === 'approved') {
      this.addNotification(
        'evolution_approved',
        '進化已批准',
        `已批准修改 ${evolution.notification.data?.evolution?.targetPath}`,
        { severity: 'info', source }
      );
    } else if (status === 'rejected') {
      this.addNotification(
        'evolution_rejected',
        '進化已拒絕',
        `已拒絕修改 ${evolution.notification.data?.evolution?.targetPath}`,
        { severity: 'info', source }
      );
    }

    this.broadcast({
      type: 'evolution_update',
      payload: { requestId, status }
    });

    return evolution;
  }

  /**
   * Get pending evolution by ID
   */
  getPendingEvolution(requestId: string): PendingEvolution | null {
    return this.pendingEvolutions.get(requestId) || null;
  }

  /**
   * Get all pending evolutions
   */
  getAllPendingEvolutions(): PendingEvolution[] {
    // Clean up expired evolutions
    const now = Date.now();
    for (const [id, evolution] of this.pendingEvolutions) {
      if (evolution.expiresAt && new Date(evolution.expiresAt).getTime() < now) {
        evolution.status = 'expired';
        this.pendingEvolutions.delete(id);
      }
    }

    return Array.from(this.pendingEvolutions.values())
      .filter(e => e.status === 'pending')
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  /**
   * Get all notifications (most recent first)
   */
  getAllNotifications(includeDissmissed = false): Notification[] {
    return Array.from(this.notifications.values())
      .filter(n => includeDissmissed || !n.dismissed)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  /**
   * Get notification by ID
   */
  getNotification(id: string): Notification | null {
    return this.notifications.get(id) || null;
  }

  /**
   * Mark notification as read
   */
  markAsRead(id: string): boolean {
    const notification = this.notifications.get(id);
    if (!notification) return false;
    notification.read = true;
    return true;
  }

  /**
   * Dismiss notification
   */
  dismiss(id: string): boolean {
    const notification = this.notifications.get(id);
    if (!notification) return false;
    notification.dismissed = true;
    return true;
  }

  /**
   * Clear all notifications
   */
  clearAll(): void {
    this.notifications.clear();
    this.broadcast({ type: 'notifications_cleared' });
  }

  /**
   * Enforce max notifications limit
   */
  private enforceMaxNotifications(): void {
    if (this.notifications.size <= this.maxNotifications) return;

    const sorted = Array.from(this.notifications.entries())
      .sort((a, b) => new Date(b[1].timestamp).getTime() - new Date(a[1].timestamp).getTime());

    // Remove oldest notifications
    const toRemove = sorted.slice(this.maxNotifications);
    for (const [id] of toRemove) {
      this.notifications.delete(id);
    }
  }

  /**
   * Register a WebSocket client
   */
  addClient(socket: WebSocket): WSClient {
    const client: WSClient = {
      socket,
      connectedAt: new Date().toISOString(),
      lastPing: new Date().toISOString(),
    };
    this.clients.add(client);

    // Send current state on connect
    socket.send(JSON.stringify({
      type: 'init',
      payload: {
        notifications: this.getAllNotifications(),
        pendingEvolutions: this.getAllPendingEvolutions(),
      },
    }));

    return client;
  }

  /**
   * Remove a WebSocket client
   */
  removeClient(client: WSClient): void {
    this.clients.delete(client);
  }

  /**
   * Broadcast message to all connected clients
   */
  broadcast(message: { type: string; payload?: unknown }): void {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      try {
        if (client.socket.readyState === WebSocket.OPEN) {
          client.socket.send(data);
        }
      } catch (err) {
        console.error('[Notification] Failed to send to client:', err);
        this.clients.delete(client);
      }
    }
  }

  /**
   * Get connected client count
   */
  getClientCount(): number {
    return this.clients.size;
  }
}

// Singleton instance
let notificationManager: NotificationManager | null = null;

/**
 * Get the notification manager instance
 */
export function getNotificationManager(): NotificationManager {
  if (!notificationManager) {
    notificationManager = new NotificationManager();
  }
  return notificationManager;
}

/**
 * Reset notification manager (for testing)
 */
export function resetNotificationManager(): void {
  notificationManager = null;
}

/**
 * Helper: Create a snapshot notification
 */
export function notifySnapshotCreated(
  snapshotId: string,
  trigger: string,
  description?: string
): Notification {
  const manager = getNotificationManager();
  return manager.addNotification(
    'snapshot_created',
    '快照已創建',
    description || `自動快照 ${snapshotId}`,
    {
      severity: 'info',
      data: { snapshotId },
    }
  );
}

/**
 * Helper: Create a conflict notification
 */
export function notifyConflictDetected(
  conflictReport: unknown
): Notification {
  const manager = getNotificationManager();
  return manager.addNotification(
    'conflict_detected',
    '檢測到前世記憶衝突',
    '啟動時發現配置衝突，請查看詳情',
    {
      severity: 'warning',
      data: { conflictReport },
      actions: [
        { label: '查看詳情', action: 'view', endpoint: '/api/admin/conflicts' },
        { label: '自動修復', action: 'approve', endpoint: '/api/admin/conflicts/auto-fix' },
      ],
    }
  );
}

/**
 * Helper: Create a health warning notification
 */
export function notifyHealthWarning(
  healthReport: unknown
): Notification {
  const manager = getNotificationManager();
  return manager.addNotification(
    'health_warning',
    '健康檢查警告',
    '系統健康狀態異常',
    {
      severity: 'warning',
      data: { healthReport },
      actions: [
        { label: '查看詳情', action: 'view', endpoint: '/api/admin/health' },
        { label: '自動修復', action: 'approve', endpoint: '/api/admin/health/repair' },
      ],
    }
  );
}
