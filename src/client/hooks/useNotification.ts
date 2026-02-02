/**
 * SuperMoltWorker Notification Hook
 *
 * React hook for connecting to the WebSocket notification system.
 * Provides real-time updates for evolution requests, conflicts, and other events.
 */

import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Notification types (must match backend)
 */
export type NotificationType =
  | 'evolution_request'
  | 'evolution_approved'
  | 'evolution_rejected'
  | 'conflict_detected'
  | 'health_warning'
  | 'snapshot_created'
  | 'snapshot_restored'
  | 'sync_completed';

export type NotificationSeverity = 'info' | 'warning' | 'critical';

export interface NotificationAction {
  label: string;
  action: 'approve' | 'reject' | 'test' | 'view' | 'dismiss';
  endpoint?: string;
  data?: Record<string, unknown>;
}

export interface NotificationSource {
  channel: 'telegram' | 'discord' | 'slack' | 'line' | 'admin_ui' | 'system';
  channelId?: string;
  userId?: string;
  userName?: string;
  messageId?: string;
}

export interface EvolutionDetails {
  requestId: string;
  targetPath: string;
  riskLevel: 'safe' | 'medium' | 'high';
  changes: {
    path: string;
    oldValue: unknown;
    newValue: unknown;
  }[];
  snapshotId?: string;
  reason?: string;
}

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

export interface PendingEvolution {
  id: string;
  notification: Notification;
  createdAt: string;
  expiresAt?: string;
  status: 'pending' | 'approved' | 'rejected' | 'testing' | 'expired';
}

interface WSMessage {
  type: string;
  payload?: unknown;
}

interface UseNotificationResult {
  notifications: Notification[];
  pendingEvolutions: PendingEvolution[];
  unreadCount: number;
  connected: boolean;
  connecting: boolean;
  error: string | null;
  markAsRead: (id: string) => void;
  dismiss: (id: string) => void;
  clearAll: () => void;
  reconnect: () => void;
}

/**
 * Hook for real-time notifications via WebSocket
 */
export function useNotification(): UseNotificationResult {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [pendingEvolutions, setPendingEvolutions] = useState<PendingEvolution[]>([]);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttempts = useRef(0);
  const maxReconnectAttempts = 5;
  const baseReconnectDelay = 1000;
  const maxReconnectDelay = 30000; // Cap at 30 seconds

  const connect = useCallback(() => {
    // Don't connect if already connected or connecting
    if (wsRef.current?.readyState === WebSocket.OPEN || connecting) {
      return;
    }

    setConnecting(true);
    setError(null);

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/notifications`;

    console.log('[WS] Connecting to:', wsUrl);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[WS] Connected');
      setConnected(true);
      setConnecting(false);
      setError(null);
      reconnectAttempts.current = 0;

      // Start ping interval
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 30000);

      ws.onclose = () => {
        clearInterval(pingInterval);
      };
    };

    ws.onmessage = (event) => {
      try {
        const message: WSMessage = JSON.parse(event.data);
        console.log('[WS] Received:', message.type);

        switch (message.type) {
          case 'init': {
            const data = message.payload as {
              notifications: Notification[];
              pendingEvolutions: PendingEvolution[];
            };
            setNotifications(data.notifications || []);
            setPendingEvolutions(data.pendingEvolutions || []);
            break;
          }

          case 'notification': {
            const notification = message.payload as Notification;
            setNotifications(prev => [notification, ...prev]);
            break;
          }

          case 'evolution_update': {
            const update = message.payload as { requestId: string; status: string };
            setPendingEvolutions(prev =>
              prev.map(e =>
                e.id === update.requestId
                  ? { ...e, status: update.status as PendingEvolution['status'] }
                  : e
              )
            );
            break;
          }

          case 'notifications_cleared':
            setNotifications([]);
            break;

          case 'pong':
            // Heartbeat response, ignore
            break;

          default:
            console.log('[WS] Unknown message type:', message.type);
        }
      } catch (err) {
        console.error('[WS] Failed to parse message:', err);
      }
    };

    ws.onerror = (event) => {
      console.error('[WS] Error:', event);
      setError('WebSocket connection error');
    };

    ws.onclose = (event) => {
      console.log('[WS] Closed:', event.code, event.reason);
      setConnected(false);
      setConnecting(false);
      wsRef.current = null;

      // Attempt reconnection with exponential backoff
      if (reconnectAttempts.current < maxReconnectAttempts) {
        reconnectAttempts.current++;
        const delay = Math.min(
          baseReconnectDelay * Math.pow(2, reconnectAttempts.current - 1),
          maxReconnectDelay
        );
        console.log(`[WS] Reconnecting in ${delay}ms (attempt ${reconnectAttempts.current})`);

        reconnectTimeoutRef.current = setTimeout(() => {
          connect();
        }, delay);
      } else {
        const errorMsg = `無法連接到通知服務（已嘗試 ${maxReconnectAttempts} 次）`;
        console.error('[WS]', errorMsg);
        setError(errorMsg);
      }
    };
  }, [connecting]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setConnected(false);
    setConnecting(false);
  }, []);

  const reconnect = useCallback(() => {
    reconnectAttempts.current = 0;
    disconnect();
    connect();
  }, [connect, disconnect]);

  const sendMessage = useCallback((message: WSMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  const markAsRead = useCallback((id: string) => {
    sendMessage({ type: 'mark_read', payload: { id } });
    setNotifications(prev =>
      prev.map(n => (n.id === id ? { ...n, read: true } : n))
    );
  }, [sendMessage]);

  const dismiss = useCallback((id: string) => {
    sendMessage({ type: 'dismiss', payload: { id } });
    setNotifications(prev =>
      prev.map(n => (n.id === id ? { ...n, dismissed: true } : n))
    );
  }, [sendMessage]);

  const clearAll = useCallback(() => {
    sendMessage({ type: 'clear_all' });
    setNotifications([]);
  }, [sendMessage]);

  // Connect on mount
  useEffect(() => {
    connect();
    return () => {
      disconnect();
    };
  }, [connect, disconnect]);

  // Calculate unread count
  const unreadCount = notifications.filter(n => !n.read && !n.dismissed).length;

  return {
    notifications: notifications.filter(n => !n.dismissed),
    pendingEvolutions: pendingEvolutions.filter(e => e.status === 'pending'),
    unreadCount,
    connected,
    connecting,
    error,
    markAsRead,
    dismiss,
    clearAll,
    reconnect,
  };
}
