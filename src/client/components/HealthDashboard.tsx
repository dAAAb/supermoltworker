/**
 * SuperMoltWorker Health Dashboard
 *
 * Displays system health status, conflict detection, and repair options.
 */

import { useState, useEffect, useCallback } from 'react';
import './HealthDashboard.css';

interface HealthCheckItem {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  message: string;
  canRepair?: boolean;
}

interface HealthIssue {
  check: string;
  severity: 'warning' | 'error';
  description: string;
  suggestion: string;
  autoRepairAvailable: boolean;
}

interface HealthReport {
  overall: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  checks: Record<string, HealthCheckItem>;
  issues: HealthIssue[];
  autoRepairAvailable: boolean;
}

interface Conflict {
  type: string;
  severity: 'info' | 'warning' | 'error';
  description: string;
  suggestion: string;
  autoFixAvailable: boolean;
}

interface ConflictReport {
  hasConflicts: boolean;
  timestamp: string;
  conflicts: Conflict[];
  recommendations: string[];
  summary: {
    total: number;
    errors: number;
    warnings: number;
    infos: number;
    autoFixable: number;
  };
}

export default function HealthDashboard() {
  const [healthReport, setHealthReport] = useState<HealthReport | null>(null);
  const [conflictReport, setConflictReport] = useState<ConflictReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [repairing, setRepairing] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchHealth = useCallback(async () => {
    try {
      setError(null);
      const response = await fetch('/api/admin/health');
      if (!response.ok) throw new Error('Failed to fetch health status');
      const data = await response.json() as HealthReport;
      setHealthReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch health');
    }
  }, []);

  const fetchConflicts = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/health/conflicts');
      if (!response.ok) throw new Error('Failed to fetch conflicts');
      const data = await response.json() as ConflictReport;
      setConflictReport(data);
    } catch (err) {
      console.error('Failed to fetch conflicts:', err);
    }
  }, []);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([fetchHealth(), fetchConflicts()]);
    setLoading(false);
  }, [fetchHealth, fetchConflicts]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const handleRepair = async () => {
    setRepairing(true);
    try {
      const response = await fetch('/api/admin/health/repair', { method: 'POST' });
      const data = await response.json() as { success: boolean; error?: string };
      if (data.success) {
        await fetchHealth();
      } else {
        setError(data.error || 'Repair failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Repair failed');
    } finally {
      setRepairing(false);
    }
  };

  const handleAutoFix = async () => {
    setFixing(true);
    try {
      const response = await fetch('/api/admin/health/conflicts/auto-fix', { method: 'POST' });
      const data = await response.json() as { success: boolean; error?: string };
      if (data.success) {
        await fetchConflicts();
      } else {
        setError(data.error || 'Auto-fix failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Auto-fix failed');
    } finally {
      setFixing(false);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'healthy':
        return '✅';
      case 'degraded':
        return '⚠️';
      case 'unhealthy':
        return '❌';
      default:
        return '❓';
    }
  };

  const getSeverityIcon = (severity: string) => {
    switch (severity) {
      case 'error':
        return '🔴';
      case 'warning':
        return '🟡';
      case 'info':
        return '🔵';
      default:
        return '⚪';
    }
  };

  if (loading) {
    return (
      <div className="health-dashboard loading">
        <div className="spinner"></div>
        <p>Loading health status...</p>
      </div>
    );
  }

  return (
    <div className="health-dashboard">
      {error && (
        <div className="health-error">
          <span>{error}</span>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {/* Overall Status */}
      <section className="health-section status-section">
        <div className="status-header">
          <div className="status-icon-large">
            {getStatusIcon(healthReport?.overall || 'unknown')}
          </div>
          <div className="status-info">
            <h2>System Health</h2>
            <p className={`status-text status-${healthReport?.overall}`}>
              {healthReport?.overall === 'healthy' && 'All systems operational'}
              {healthReport?.overall === 'degraded' && 'Some issues detected'}
              {healthReport?.overall === 'unhealthy' && 'Critical issues require attention'}
            </p>
          </div>
          <button
            className="btn btn-secondary"
            onClick={fetchAll}
            disabled={loading}
          >
            Refresh
          </button>
        </div>
      </section>

      {/* Health Checks */}
      <section className="health-section">
        <h3>Health Checks</h3>
        <div className="checks-grid">
          {healthReport?.checks &&
            Object.entries(healthReport.checks).map(([key, check]) => (
              <div key={key} className={`check-card status-${check.status}`}>
                <div className="check-header">
                  <span className="check-icon">{getStatusIcon(check.status)}</span>
                  <span className="check-name">{check.name}</span>
                </div>
                <p className="check-message">{check.message}</p>
              </div>
            ))}
        </div>

        {healthReport?.autoRepairAvailable && (
          <div className="repair-action">
            <button
              className="btn btn-primary"
              onClick={handleRepair}
              disabled={repairing}
            >
              {repairing ? 'Repairing...' : 'Auto-Repair Issues'}
            </button>
          </div>
        )}
      </section>

      {/* Conflicts */}
      <section className="health-section">
        <h3>Conflict Detection</h3>

        {!conflictReport?.hasConflicts ? (
          <div className="no-conflicts">
            <span className="no-conflicts-icon">✅</span>
            <p>No configuration conflicts detected</p>
          </div>
        ) : (
          <>
            <div className="conflict-summary">
              <span className="summary-item errors">
                {conflictReport.summary.errors} errors
              </span>
              <span className="summary-item warnings">
                {conflictReport.summary.warnings} warnings
              </span>
              <span className="summary-item infos">
                {conflictReport.summary.infos} info
              </span>
            </div>

            <div className="conflicts-list">
              {conflictReport.conflicts.map((conflict, index) => (
                <div key={index} className={`conflict-item severity-${conflict.severity}`}>
                  <div className="conflict-header">
                    <span className="conflict-icon">
                      {getSeverityIcon(conflict.severity)}
                    </span>
                    <span className="conflict-type">{conflict.type}</span>
                    {conflict.autoFixAvailable && (
                      <span className="auto-fix-badge">Auto-fixable</span>
                    )}
                  </div>
                  <p className="conflict-description">{conflict.description}</p>
                  <p className="conflict-suggestion">{conflict.suggestion}</p>
                </div>
              ))}
            </div>

            {conflictReport.summary.autoFixable > 0 && (
              <div className="fix-action">
                <button
                  className="btn btn-primary"
                  onClick={handleAutoFix}
                  disabled={fixing}
                >
                  {fixing
                    ? 'Fixing...'
                    : `Auto-Fix ${conflictReport.summary.autoFixable} Conflict(s)`}
                </button>
              </div>
            )}

            {conflictReport.recommendations.length > 0 && (
              <div className="recommendations">
                <h4>Recommendations</h4>
                <ul>
                  {conflictReport.recommendations.map((rec, index) => (
                    <li key={index}>{rec}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </section>

      {/* Last Updated */}
      <div className="last-updated">
        Last updated: {healthReport?.timestamp
          ? new Date(healthReport.timestamp).toLocaleString()
          : 'Never'}
      </div>
    </div>
  );
}
