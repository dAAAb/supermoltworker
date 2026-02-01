/**
 * SuperMoltWorker Notification Toast Component
 *
 * Displays real-time notifications as toast messages.
 * Supports different severity levels and action buttons.
 */

import { useState, useEffect } from 'react';
import type { Notification, NotificationAction } from '../hooks/useNotification';
import './NotificationToast.css';

interface NotificationToastProps {
  notification: Notification;
  onDismiss: (id: string) => void;
  onAction?: (action: NotificationAction) => void;
  autoDismiss?: boolean;
  autoDismissDelay?: number;
}

/**
 * Single notification toast
 */
export function NotificationToast({
  notification,
  onDismiss,
  onAction,
  autoDismiss = true,
  autoDismissDelay = 10000,
}: NotificationToastProps) {
  const [isExiting, setIsExiting] = useState(false);

  useEffect(() => {
    // Don't auto-dismiss critical notifications or evolution requests
    if (!autoDismiss || notification.severity === 'critical' || notification.type === 'evolution_request') {
      return;
    }

    const timer = setTimeout(() => {
      handleDismiss();
    }, autoDismissDelay);

    return () => clearTimeout(timer);
  }, [autoDismiss, autoDismissDelay, notification.severity, notification.type]);

  const handleDismiss = () => {
    setIsExiting(true);
    setTimeout(() => {
      onDismiss(notification.id);
    }, 300);
  };

  const handleAction = (action: NotificationAction) => {
    if (onAction) {
      onAction(action);
    }
    if (action.action === 'dismiss') {
      handleDismiss();
    }
  };

  const getSeverityIcon = () => {
    switch (notification.severity) {
      case 'critical':
        return '🚨';
      case 'warning':
        return '⚠️';
      default:
        return 'ℹ️';
    }
  };

  const getTypeIcon = () => {
    switch (notification.type) {
      case 'evolution_request':
        return '🦞';
      case 'evolution_approved':
        return '✅';
      case 'evolution_rejected':
        return '❌';
      case 'conflict_detected':
        return '💥';
      case 'health_warning':
        return '🏥';
      case 'snapshot_created':
        return '📸';
      case 'snapshot_restored':
        return '🔄';
      case 'sync_completed':
        return '☁️';
      default:
        return getSeverityIcon();
    }
  };

  const getSourceLabel = () => {
    if (!notification.source) return null;

    const channelNames: Record<string, string> = {
      telegram: 'Telegram',
      discord: 'Discord',
      slack: 'Slack',
      line: 'LINE',
      admin_ui: 'Admin UI',
      system: 'System',
    };

    return channelNames[notification.source.channel] || notification.source.channel;
  };

  const formatTime = () => {
    const date = new Date(notification.timestamp);
    return date.toLocaleTimeString();
  };

  return (
    <div
      className={`notification-toast severity-${notification.severity} ${isExiting ? 'exiting' : ''}`}
      role="alert"
    >
      <div className="toast-icon">{getTypeIcon()}</div>

      <div className="toast-content">
        <div className="toast-header">
          <span className="toast-title">{notification.title}</span>
          {notification.source && (
            <span className="toast-source">via {getSourceLabel()}</span>
          )}
          <span className="toast-time">{formatTime()}</span>
        </div>

        <p className="toast-message">{notification.message}</p>

        {/* Show evolution details if present */}
        {notification.data?.evolution && (
          <div className="toast-evolution-details">
            <div className="evolution-path">
              <span className="label">Target:</span>
              <code>{notification.data.evolution.targetPath}</code>
            </div>
            <div className={`evolution-risk risk-${notification.data.evolution.riskLevel}`}>
              <span className="label">Risk Level:</span>
              <span className="value">
                {notification.data.evolution.riskLevel === 'high' && '🔴 High'}
                {notification.data.evolution.riskLevel === 'medium' && '🟡 Medium'}
                {notification.data.evolution.riskLevel === 'safe' && '🟢 Safe'}
              </span>
            </div>
            {notification.data.evolution.snapshotId && (
              <div className="evolution-snapshot">
                <span className="label">Snapshot Created:</span>
                <code>{notification.data.evolution.snapshotId}</code>
              </div>
            )}
          </div>
        )}

        {/* Action buttons */}
        {notification.actions && notification.actions.length > 0 && (
          <div className="toast-actions">
            {notification.actions.map((action, index) => (
              <button
                key={index}
                className={`toast-action-btn action-${action.action}`}
                onClick={() => handleAction(action)}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        className="toast-close"
        onClick={handleDismiss}
        aria-label="Close notification"
      >
        ×
      </button>
    </div>
  );
}

interface NotificationContainerProps {
  notifications: Notification[];
  onDismiss: (id: string) => void;
  onAction?: (notification: Notification, action: NotificationAction) => void;
  maxVisible?: number;
}

/**
 * Container for multiple notification toasts
 */
export function NotificationContainer({
  notifications,
  onDismiss,
  onAction,
  maxVisible = 5,
}: NotificationContainerProps) {
  // Show most recent notifications first, limit to maxVisible
  const visibleNotifications = notifications
    .filter(n => !n.dismissed)
    .slice(0, maxVisible);

  if (visibleNotifications.length === 0) {
    return null;
  }

  return (
    <div className="notification-container" role="region" aria-label="Notifications">
      {visibleNotifications.map(notification => (
        <NotificationToast
          key={notification.id}
          notification={notification}
          onDismiss={onDismiss}
          onAction={onAction ? (action) => onAction(notification, action) : undefined}
        />
      ))}

      {notifications.length > maxVisible && (
        <div className="notification-overflow">
          +{notifications.length - maxVisible} more notifications
        </div>
      )}
    </div>
  );
}

export default NotificationToast;
