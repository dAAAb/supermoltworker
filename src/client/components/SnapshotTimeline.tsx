import { useState, useEffect, useCallback } from 'react';
import {
  listSnapshots,
  createSnapshot,
  restoreSnapshot,
  deleteSnapshot,
  compareSnapshot,
  type SnapshotMetadata,
  type SnapshotCompareResponse,
} from '../api';
import './SnapshotTimeline.css';

// Small inline spinner for buttons
function ButtonSpinner() {
  return <span className="btn-spinner" />;
}

interface SnapshotTimelineProps {
  onRestoreComplete?: () => void;
}

export default function SnapshotTimeline({ onRestoreComplete }: SnapshotTimelineProps) {
  const [snapshots, setSnapshots] = useState<SnapshotMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState<string | null>(null);
  const [compareResult, setCompareResult] = useState<SnapshotCompareResponse | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newSnapshotDescription, setNewSnapshotDescription] = useState('');

  const fetchSnapshots = useCallback(async () => {
    try {
      setError(null);
      const data = await listSnapshots();
      if (data.success) {
        setSnapshots(data.snapshots || []);
      } else {
        setError(data.error || 'Failed to fetch snapshots');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch snapshots');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSnapshots();
  }, [fetchSnapshots]);

  const handleCreateSnapshot = async () => {
    setActionInProgress('create');
    try {
      const result = await createSnapshot(newSnapshotDescription || undefined, 'manual');
      if (result.success) {
        setShowCreateModal(false);
        setNewSnapshotDescription('');
        await fetchSnapshots();
      } else {
        setError(result.error || 'Failed to create snapshot');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create snapshot');
    } finally {
      setActionInProgress(null);
    }
  };

  const handleRestoreSnapshot = async (snapshotId: string) => {
    if (
      !confirm(
        'Are you sure you want to restore this snapshot?\n\n' +
          'A backup of the current state will be created automatically.\n' +
          'You may need to restart the gateway for changes to take effect.'
      )
    ) {
      return;
    }

    setActionInProgress(`restore-${snapshotId}`);
    try {
      const result = await restoreSnapshot(snapshotId);
      if (result.success) {
        alert(result.message || 'Snapshot restored successfully');
        await fetchSnapshots();
        onRestoreComplete?.();
      } else {
        setError(result.error || 'Failed to restore snapshot');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restore snapshot');
    } finally {
      setActionInProgress(null);
    }
  };

  const handleDeleteSnapshot = async (snapshotId: string) => {
    if (!confirm('Are you sure you want to delete this snapshot?')) {
      return;
    }

    setActionInProgress(`delete-${snapshotId}`);
    try {
      const result = await deleteSnapshot(snapshotId);
      if (result.success) {
        await fetchSnapshots();
        if (selectedSnapshot === snapshotId) {
          setSelectedSnapshot(null);
          setCompareResult(null);
        }
      } else {
        setError(result.error || 'Failed to delete snapshot');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete snapshot');
    } finally {
      setActionInProgress(null);
    }
  };

  const handleCompareSnapshot = async (snapshotId: string) => {
    if (selectedSnapshot === snapshotId) {
      setSelectedSnapshot(null);
      setCompareResult(null);
      return;
    }

    setSelectedSnapshot(snapshotId);
    setActionInProgress(`compare-${snapshotId}`);
    try {
      const result = await compareSnapshot(snapshotId);
      if (result.success) {
        setCompareResult(result);
      } else {
        setError(result.error || 'Failed to compare snapshot');
        setCompareResult(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to compare snapshot');
      setCompareResult(null);
    } finally {
      setActionInProgress(null);
    }
  };

  const formatTimestamp = (isoString: string) => {
    try {
      const date = new Date(isoString);
      return date.toLocaleString();
    } catch {
      return isoString;
    }
  };

  const formatTimeAgo = (isoString: string) => {
    try {
      const date = new Date(isoString);
      const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
      if (seconds < 60) return `${seconds}s ago`;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m ago`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours}h ago`;
      const days = Math.floor(hours / 24);
      return `${days}d ago`;
    } catch {
      return isoString;
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const getTriggerBadgeClass = (trigger: string) => {
    switch (trigger) {
      case 'manual':
        return 'trigger-manual';
      case 'auto':
        return 'trigger-auto';
      case 'pre-evolution':
        return 'trigger-evolution';
      case 'pre-sync':
        return 'trigger-sync';
      default:
        return '';
    }
  };

  const getTriggerLabel = (trigger: string) => {
    switch (trigger) {
      case 'manual':
        return 'Manual';
      case 'auto':
        return 'Auto';
      case 'pre-evolution':
        return 'Pre-Evolution';
      case 'pre-sync':
        return 'Pre-Sync';
      default:
        return trigger;
    }
  };

  return (
    <div className="snapshot-timeline">
      <div className="snapshot-header">
        <h2>Memory Snapshots</h2>
        <div className="header-actions">
          <button
            className="btn btn-primary"
            onClick={() => setShowCreateModal(true)}
            disabled={actionInProgress !== null}
          >
            Create Snapshot
          </button>
          <button
            className="btn btn-secondary"
            onClick={fetchSnapshots}
            disabled={loading}
          >
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="dismiss-btn">
            Dismiss
          </button>
        </div>
      )}

      {showCreateModal && (
        <div className="modal-overlay">
          <div className="modal">
            <h3>Create New Snapshot</h3>
            <p>Create a backup of the current moltbot configuration and skills.</p>
            <div className="form-group">
              <label htmlFor="snapshot-description">Description (optional)</label>
              <input
                id="snapshot-description"
                type="text"
                value={newSnapshotDescription}
                onChange={(e) => setNewSnapshotDescription(e.target.value)}
                placeholder="e.g., Before testing new feature"
                autoFocus
              />
            </div>
            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setShowCreateModal(false);
                  setNewSnapshotDescription('');
                }}
                disabled={actionInProgress === 'create'}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleCreateSnapshot}
                disabled={actionInProgress === 'create'}
              >
                {actionInProgress === 'create' && <ButtonSpinner />}
                {actionInProgress === 'create' ? 'Creating...' : 'Create Snapshot'}
              </button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="loading">
          <div className="spinner"></div>
          <p>Loading snapshots...</p>
        </div>
      ) : snapshots.length === 0 ? (
        <div className="empty-state">
          <p>No snapshots yet</p>
          <p className="hint">
            Create your first snapshot to backup moltbot's current configuration.
          </p>
        </div>
      ) : (
        <div className="timeline">
          {snapshots.map((snapshot, index) => (
            <div
              key={snapshot.id}
              className={`timeline-item ${selectedSnapshot === snapshot.id ? 'selected' : ''}`}
            >
              <div className="timeline-marker">
                <div className="marker-dot" />
                {index < snapshots.length - 1 && <div className="marker-line" />}
              </div>
              <div className="timeline-content">
                <div className="snapshot-card">
                  <div className="snapshot-header-row">
                    <div className="snapshot-info">
                      <span className="snapshot-version">v{snapshot.version}</span>
                      <span
                        className={`snapshot-trigger ${getTriggerBadgeClass(snapshot.trigger)}`}
                      >
                        {getTriggerLabel(snapshot.trigger)}
                      </span>
                      <span className="snapshot-time" title={formatTimestamp(snapshot.timestamp)}>
                        {formatTimeAgo(snapshot.timestamp)}
                      </span>
                    </div>
                    <div className="snapshot-actions">
                      <button
                        className="btn btn-sm btn-secondary"
                        onClick={() => handleCompareSnapshot(snapshot.id)}
                        disabled={actionInProgress !== null}
                        title="Compare with current state"
                      >
                        {actionInProgress === `compare-${snapshot.id}` ? (
                          <ButtonSpinner />
                        ) : (
                          'Compare'
                        )}
                      </button>
                      <button
                        className="btn btn-sm btn-success"
                        onClick={() => handleRestoreSnapshot(snapshot.id)}
                        disabled={actionInProgress !== null}
                        title="Restore this snapshot"
                      >
                        {actionInProgress === `restore-${snapshot.id}` ? (
                          <ButtonSpinner />
                        ) : (
                          'Restore'
                        )}
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => handleDeleteSnapshot(snapshot.id)}
                        disabled={actionInProgress !== null}
                        title="Delete this snapshot"
                      >
                        {actionInProgress === `delete-${snapshot.id}` ? (
                          <ButtonSpinner />
                        ) : (
                          'Delete'
                        )}
                      </button>
                    </div>
                  </div>
                  <div className="snapshot-description">
                    {snapshot.description || 'No description'}
                  </div>
                  <div className="snapshot-details">
                    <span className="detail-item">
                      Config: {snapshot.files.clawdbotJson ? 'Yes' : 'No'}
                      {snapshot.files.clawdbotJson &&
                        ` (${formatFileSize(snapshot.metadata.configSize)})`}
                    </span>
                    <span className="detail-item">
                      Skills: {snapshot.files.skillsCount}
                      {snapshot.files.skillsCount > 0 &&
                        ` (${formatFileSize(snapshot.metadata.skillsSize)})`}
                    </span>
                  </div>

                  {selectedSnapshot === snapshot.id && compareResult?.diff && (
                    <div className="compare-result">
                      <h4>Comparison with Current State</h4>
                      <div className="compare-summary">
                        <div
                          className={`compare-item ${compareResult.diff.configChanged ? 'changed' : 'unchanged'}`}
                        >
                          Config:{' '}
                          {compareResult.diff.configChanged ? 'Changed' : 'Unchanged'}
                        </div>
                        {compareResult.diff.skillsAdded.length > 0 && (
                          <div className="compare-item added">
                            Skills Added: {compareResult.diff.skillsAdded.join(', ')}
                          </div>
                        )}
                        {compareResult.diff.skillsRemoved.length > 0 && (
                          <div className="compare-item removed">
                            Skills Removed: {compareResult.diff.skillsRemoved.join(', ')}
                          </div>
                        )}
                        {!compareResult.diff.configChanged &&
                          compareResult.diff.skillsAdded.length === 0 &&
                          compareResult.diff.skillsRemoved.length === 0 && (
                            <div className="compare-item unchanged">
                              No changes detected - current state matches this snapshot
                            </div>
                          )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
