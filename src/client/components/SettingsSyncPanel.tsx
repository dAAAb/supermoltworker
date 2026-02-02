/**
 * SuperMoltWorker Settings Sync Panel
 *
 * Displays sync status between clawdbot.json and environment variables,
 * allowing users to generate wrangler commands to backup settings.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  getSettingsSyncStatus,
  getExportCommands,
  updateConfigValue,
  type SettingsSyncStatus,
  type SettingItem,
  type ExportCommandsResponse,
} from '../api';
import './SettingsSyncPanel.css';

type CategoryKey = 'secrets' | 'channels' | 'agents' | 'gateway' | 'other';

const CATEGORY_LABELS: Record<CategoryKey, { label: string; icon: string }> = {
  secrets: { label: 'Secrets', icon: '🔴' },
  channels: { label: 'Channel Settings', icon: '🟡' },
  agents: { label: 'Agent/Model Settings', icon: '🟢' },
  gateway: { label: 'Gateway Settings', icon: '🔵' },
  other: { label: 'Other Settings', icon: '⚪' },
};

function getStatusIcon(status: string) {
  switch (status) {
    case 'synced':
      return '✅';
    case 'unsynced':
      return '⚠️';
    case 'env_only':
      return '📦';
    case 'env_only_ok':
      return '🔒';
    case 'not_set':
      return '─';
    case 'conflict':
      return '🔶';
    default:
      return '❓';
  }
}

function getStatusLabel(status: string) {
  switch (status) {
    case 'synced':
      return 'Synced';
    case 'unsynced':
      return 'Unsynced';
    case 'env_only':
      return 'Env Only';
    case 'env_only_ok':
      return 'Secure';
    case 'not_set':
      return 'Not Set';
    case 'conflict':
      return 'Conflict';
    default:
      return status;
  }
}

function getStatusTooltip(status: string): string | null {
  switch (status) {
    case 'env_only_ok':
      return 'This setting is intentionally kept only in environment variables for security. It will never be stored in R2.';
    case 'env_only':
      return 'This setting only exists in environment variables. Consider syncing to clawdbot.json if needed.';
    case 'unsynced':
      return 'This setting only exists in clawdbot.json. If R2 fails, this value may be lost.';
    default:
      return null;
  }
}

function getPriorityBadge(priority: string) {
  switch (priority) {
    case 'critical':
      return <span className="priority-badge critical">Critical</span>;
    case 'important':
      return <span className="priority-badge important">Important</span>;
    default:
      return null;
  }
}

interface CommandsModalProps {
  isOpen: boolean;
  onClose: () => void;
  commandsData: ExportCommandsResponse | null;
  loading: boolean;
  category: string;
}

function CommandsModal({ isOpen, onClose, commandsData, loading, category }: CommandsModalProps) {
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const handleCopy = async () => {
    if (commandsData?.commandsText) {
      try {
        await navigator.clipboard.writeText(commandsData.commandsText);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (err) {
        console.error('Failed to copy:', err);
      }
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>📋 Wrangler Secret Commands</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {loading ? (
            <div className="modal-loading">
              <div className="spinner" />
              <p>Loading...</p>
            </div>
          ) : commandsData?.commands && commandsData.commands.length > 0 ? (
            <>
              <p className="modal-intro">
                Run the following commands in your terminal to backup settings to Cloudflare environment variables:
              </p>
              <div className="commands-box">
                <pre>{commandsData.commandsText}</pre>
              </div>
              <div className="modal-notes">
                <p>⚠️ <strong>Note:</strong></p>
                <ul>
                  <li>These commands must be run in the project directory</li>
                  <li>Redeploy is required for changes to take effect</li>
                  <li>Do not share sensitive information with others</li>
                </ul>
              </div>
            </>
          ) : (
            <div className="no-commands">
              <p>✅ All {category === 'all' ? '' : CATEGORY_LABELS[category as CategoryKey]?.label + ' '}settings are synced or don't need syncing</p>
            </div>
          )}
        </div>

        <div className="modal-footer">
          {commandsData?.commands && commandsData.commands.length > 0 && (
            <button
              className="btn btn-primary"
              onClick={handleCopy}
              disabled={loading}
            >
              {copied ? '✓ Copied' : '📋 Copy to Clipboard'}
            </button>
          )}
          <button className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

interface SettingsTableProps {
  category: CategoryKey;
  items: SettingItem[];
  onValueUpdate: (name: string, value: string) => Promise<void>;
}

function SettingsTable({ category, items, onValueUpdate }: SettingsTableProps) {
  const [editingItem, setEditingItem] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);

  if (items.length === 0) {
    return (
      <div className="empty-category">
        <p>No settings in this category</p>
      </div>
    );
  }

  const handleEdit = (item: SettingItem) => {
    setEditingItem(item.name);
    setEditValue(item.configValue || '');
  };

  const handleSave = async (name: string) => {
    setSaving(true);
    try {
      await onValueUpdate(name, editValue);
      setEditingItem(null);
    } catch (err) {
      console.error('Failed to save:', err);
      alert('Failed to save: ' + (err instanceof Error ? err.message : 'Unknown error'));
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setEditingItem(null);
    setEditValue('');
  };

  return (
    <table className="settings-table">
      <thead>
        <tr>
          <th>Setting</th>
          <th>clawdbot.json</th>
          <th>Env Variable</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.name} className={`status-row-${item.status}`}>
            <td className="setting-name">
              <code>{item.name}</code>
              {getPriorityBadge(item.priority)}
              <span className="display-name">{item.displayName}</span>
            </td>
            <td className="setting-value editable-cell">
              {editingItem === item.name ? (
                <div className="edit-container">
                  <input
                    type="text"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    disabled={saving}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSave(item.name);
                      } else if (e.key === 'Escape') {
                        handleCancel();
                      }
                    }}
                  />
                  <div className="edit-actions">
                    <button
                      className="btn-save"
                      onClick={() => handleSave(item.name)}
                      disabled={saving}
                      title="Save (Enter)"
                    >
                      {saving ? '...' : '✓'}
                    </button>
                    <button
                      className="btn-cancel"
                      onClick={handleCancel}
                      disabled={saving}
                      title="Cancel (Esc)"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ) : (
                <div
                  className="value-display"
                  onClick={() => handleEdit(item)}
                  title="Click to edit"
                >
                  {item.configValue ? (
                    <>
                      <span className="value-preview">{item.configValue}</span>
                      <span className="value-check">✓</span>
                    </>
                  ) : (
                    <span className="value-empty">─ (click to add)</span>
                  )}
                  <span className="edit-icon">✎</span>
                </div>
              )}
            </td>
            <td className="setting-value">
              {item.envExists ? (
                <>
                  <span className="value-preview">{item.envValue || '***'}</span>
                  <span className="value-check">✓</span>
                </>
              ) : (
                <span className="value-empty">─</span>
              )}
            </td>
            <td className="setting-status">
              <span
                className={`status-badge status-${item.status}`}
                title={getStatusTooltip(item.status) || undefined}
              >
                {getStatusIcon(item.status)} {getStatusLabel(item.status)}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function SettingsSyncPanel() {
  const [syncStatus, setSyncStatus] = useState<SettingsSyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalCategory, setModalCategory] = useState<string>('all');
  const [commandsData, setCommandsData] = useState<ExportCommandsResponse | null>(null);
  const [commandsLoading, setCommandsLoading] = useState(false);

  const fetchSyncStatus = useCallback(async () => {
    try {
      setError(null);
      setLoading(true);
      const data = await getSettingsSyncStatus();
      if (data.success) {
        setSyncStatus(data);
      } else {
        setError(data.error || 'Failed to fetch sync status');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch sync status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSyncStatus();
  }, [fetchSyncStatus]);

  const handleExportCommands = async (category: 'all' | CategoryKey) => {
    setModalCategory(category);
    setModalOpen(true);
    setCommandsLoading(true);

    try {
      const data = await getExportCommands(category, true);
      setCommandsData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate commands');
    } finally {
      setCommandsLoading(false);
    }
  };

  const closeModal = () => {
    setModalOpen(false);
    setCommandsData(null);
  };

  const handleValueUpdate = useCallback(async (name: string, value: string) => {
    try {
      const result = await updateConfigValue(name, value);
      if (result.success) {
        // Refresh sync status after update
        await fetchSyncStatus();
      } else {
        throw new Error(result.error || 'Failed to update');
      }
    } catch (err) {
      throw err;
    }
  }, [fetchSyncStatus]);

  if (loading) {
    return (
      <div className="settings-sync-panel loading">
        <div className="spinner" />
        <p>Loading sync status...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="settings-sync-panel error">
        <div className="error-banner">
          <span>{error}</span>
          <button onClick={() => { setError(null); fetchSyncStatus(); }}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!syncStatus) {
    return null;
  }

  const { summary, categories } = syncStatus;

  return (
    <div className="settings-sync-panel">
      {/* Summary Section */}
      <section className="sync-summary">
        <div className="summary-icon">📊</div>
        <div className="summary-content">
          <h3>Sync Summary</h3>
          <div className="summary-stats">
            <span className="stat stat-synced">
              ✅ Synced: <strong>{summary.synced}</strong>
            </span>
            <span className="stat stat-secure" title="Settings intentionally kept only in environment variables for security">
              🔒 Secure: <strong>{summary.envOnlyOk || 0}</strong>
            </span>
            <span className="stat stat-unsynced">
              ⚠️ Unsynced: <strong>{summary.unsynced}</strong>
            </span>
            <span className="stat stat-env-only">
              📦 Env Only: <strong>{summary.envOnly}</strong>
            </span>
          </div>
        </div>
        <div className="summary-actions">
          <button
            className="btn btn-secondary"
            onClick={fetchSyncStatus}
          >
            Refresh
          </button>
        </div>
      </section>

      {/* Warning if unsynced */}
      {summary.unsynced > 0 && (
        <div className="unsynced-warning">
          <span className="warning-icon">⚠️</span>
          <div className="warning-content">
            <strong>{summary.unsynced} setting(s) not synced to environment variables</strong>
            <p>These settings only exist in clawdbot.json and may be lost if R2 storage fails. Recommended to sync to environment variables as backup.</p>
          </div>
          <button
            className="btn btn-primary"
            onClick={() => handleExportCommands('all')}
          >
            📋 Copy Sync Commands
          </button>
        </div>
      )}

      {/* Category Tables */}
      {(Object.entries(categories) as [CategoryKey, SettingItem[]][]).map(([category, items]) => {
        const { label, icon } = CATEGORY_LABELS[category];
        const unsyncedCount = items.filter((i) => i.status === 'unsynced').length;

        return (
          <section key={category} className="settings-category">
            <div className="category-header">
              <h3>
                <span className="category-icon">{icon}</span>
                {label}
                {unsyncedCount > 0 && (
                  <span className="unsynced-count">{unsyncedCount} unsynced</span>
                )}
              </h3>
              {unsyncedCount > 0 && (
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={() => handleExportCommands(category)}
                >
                  📋 Copy Commands
                </button>
              )}
            </div>
            <SettingsTable category={category} items={items} onValueUpdate={handleValueUpdate} />
          </section>
        );
      })}

      {/* Export Buttons */}
      <section className="export-actions">
        <button
          className="btn btn-primary btn-lg"
          onClick={() => handleExportCommands('all')}
          disabled={summary.unsynced === 0}
        >
          📋 Copy All Unsynced Commands
        </button>
        <button
          className="btn btn-secondary btn-lg"
          onClick={() => handleExportCommands('secrets')}
        >
          📋 Copy Secrets Only
        </button>
      </section>

      {/* Commands Modal */}
      <CommandsModal
        isOpen={modalOpen}
        onClose={closeModal}
        commandsData={commandsData}
        loading={commandsLoading}
        category={modalCategory}
      />
    </div>
  );
}
