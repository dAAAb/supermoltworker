/**
 * SuperMoltWorker Critical Alerts Bar
 *
 * Displays prominent warnings when critical configuration is missing.
 * Shows at the top of the Admin UI to ensure visibility.
 */

import { useState, useEffect } from 'react';
import { getCriticalAlerts, type CriticalAlert } from '../api';
import './CriticalAlertsBar.css';

interface CriticalAlertsBarProps {
  onAlertClick?: (alert: CriticalAlert) => void;
}

export default function CriticalAlertsBar({ onAlertClick }: CriticalAlertsBarProps) {
  const [alerts, setAlerts] = useState<CriticalAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    async function fetchAlerts() {
      try {
        const response = await getCriticalAlerts();
        if (response.success) {
          setAlerts(response.alerts);
        }
      } catch (err) {
        console.error('Failed to fetch critical alerts:', err);
      } finally {
        setLoading(false);
      }
    }

    fetchAlerts();
    // Refresh every 30 seconds
    const interval = setInterval(fetchAlerts, 30000);
    return () => clearInterval(interval);
  }, []);

  const handleDismiss = (type: string) => {
    setDismissed(prev => new Set([...prev, type]));
  };

  const handleCopyCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  if (loading) {
    return null;
  }

  const visibleAlerts = alerts.filter(a => !dismissed.has(a.type));

  if (visibleAlerts.length === 0) {
    return null;
  }

  return (
    <div className="critical-alerts-bar">
      {visibleAlerts.map((alert) => (
        <div
          key={alert.type}
          className={`alert-item alert-${alert.severity}`}
          onClick={() => onAlertClick?.(alert)}
        >
          <div className="alert-icon">
            {alert.severity === 'error' ? '🚨' : '⚠️'}
          </div>
          <div className="alert-content">
            <div className="alert-title">{alert.title}</div>
            <div className="alert-message">{alert.message}</div>
            {alert.actionCommand && (
              <div className="alert-command">
                <code>{alert.actionCommand}</code>
                <button
                  className="copy-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCopyCommand(alert.actionCommand!);
                  }}
                  title="Copy command"
                >
                  📋
                </button>
              </div>
            )}
          </div>
          <button
            className="dismiss-btn"
            onClick={(e) => {
              e.stopPropagation();
              handleDismiss(alert.type);
            }}
            title="Dismiss"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
