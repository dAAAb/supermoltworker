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
  type SettingsSyncStatus,
  type SettingItem,
  type ExportCommandsResponse,
} from '../api';
import './SettingsSyncPanel.css';

type CategoryKey = 'secrets' | 'channels' | 'agents' | 'gateway' | 'other';

const CATEGORY_LABELS: Record<CategoryKey, { label: string; icon: string }> = {
  secrets: { label: '機密設定', icon: '🔴' },
  channels: { label: 'Channel 設定', icon: '🟡' },
  agents: { label: 'Agent/Model 設定', icon: '🟢' },
  gateway: { label: 'Gateway 設定', icon: '🔵' },
  other: { label: '其他設定', icon: '⚪' },
};

function getStatusIcon(status: string) {
  switch (status) {
    case 'synced':
      return '✅';
    case 'unsynced':
      return '⚠️';
    case 'env_only':
      return '📦';
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
      return '已同步';
    case 'unsynced':
      return '未同步';
    case 'env_only':
      return '僅環境變數';
    case 'not_set':
      return '未設定';
    case 'conflict':
      return '衝突';
    default:
      return status;
  }
}

function getPriorityBadge(priority: string) {
  switch (priority) {
    case 'critical':
      return <span className="priority-badge critical">關鍵</span>;
    case 'important':
      return <span className="priority-badge important">重要</span>;
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
          <h3>📋 Wrangler 環境變數設定指令</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {loading ? (
            <div className="modal-loading">
              <div className="spinner" />
              <p>載入中...</p>
            </div>
          ) : commandsData?.commands && commandsData.commands.length > 0 ? (
            <>
              <p className="modal-intro">
                請在終端機執行以下指令，將設定備份到 Cloudflare 環境變數：
              </p>
              <div className="commands-box">
                <pre>{commandsData.commandsText}</pre>
              </div>
              <div className="modal-notes">
                <p>⚠️ <strong>注意：</strong></p>
                <ul>
                  <li>這些指令需要在專案目錄下執行</li>
                  <li>執行後需要重新部署才會生效</li>
                  <li>機密資訊請勿分享給他人</li>
                </ul>
              </div>
            </>
          ) : (
            <div className="no-commands">
              <p>✅ 目前 {category === 'all' ? '所有' : CATEGORY_LABELS[category as CategoryKey]?.label} 設定已同步或無需同步</p>
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
              {copied ? '✓ 已複製' : '📋 複製到剪貼簿'}
            </button>
          )}
          <button className="btn btn-secondary" onClick={onClose}>
            關閉
          </button>
        </div>
      </div>
    </div>
  );
}

interface SettingsTableProps {
  category: CategoryKey;
  items: SettingItem[];
}

function SettingsTable({ category, items }: SettingsTableProps) {
  if (items.length === 0) {
    return (
      <div className="empty-category">
        <p>此類別無設定項目</p>
      </div>
    );
  }

  return (
    <table className="settings-table">
      <thead>
        <tr>
          <th>設定項目</th>
          <th>clawdbot.json</th>
          <th>環境變數</th>
          <th>狀態</th>
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
            <td className="setting-value">
              {item.configValue ? (
                <>
                  <span className="value-preview">{item.configValue}</span>
                  <span className="value-check">✓</span>
                </>
              ) : (
                <span className="value-empty">─</span>
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
              <span className={`status-badge status-${item.status}`}>
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

  if (loading) {
    return (
      <div className="settings-sync-panel loading">
        <div className="spinner" />
        <p>載入設定同步狀態...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="settings-sync-panel error">
        <div className="error-banner">
          <span>{error}</span>
          <button onClick={() => { setError(null); fetchSyncStatus(); }}>
            重試
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
          <h3>同步摘要</h3>
          <div className="summary-stats">
            <span className="stat stat-synced">
              ✅ 已同步: <strong>{summary.synced}</strong> 項
            </span>
            <span className="stat stat-unsynced">
              ⚠️ 未同步: <strong>{summary.unsynced}</strong> 項
            </span>
            <span className="stat stat-env-only">
              📦 僅環境變數: <strong>{summary.envOnly}</strong> 項
            </span>
          </div>
        </div>
        <div className="summary-actions">
          <button
            className="btn btn-secondary"
            onClick={fetchSyncStatus}
          >
            重新整理
          </button>
        </div>
      </section>

      {/* Warning if unsynced */}
      {summary.unsynced > 0 && (
        <div className="unsynced-warning">
          <span className="warning-icon">⚠️</span>
          <div className="warning-content">
            <strong>有 {summary.unsynced} 個設定尚未同步到環境變數</strong>
            <p>這些設定目前只存在 clawdbot.json，如果 R2 儲存發生問題可能會丟失。建議同步到環境變數作為備份。</p>
          </div>
          <button
            className="btn btn-primary"
            onClick={() => handleExportCommands('all')}
          >
            📋 複製同步指令
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
                  <span className="unsynced-count">{unsyncedCount} 未同步</span>
                )}
              </h3>
              {unsyncedCount > 0 && (
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={() => handleExportCommands(category)}
                >
                  📋 複製指令
                </button>
              )}
            </div>
            <SettingsTable category={category} items={items} />
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
          📋 複製所有未同步設定的指令
        </button>
        <button
          className="btn btn-secondary btn-lg"
          onClick={() => handleExportCommands('secrets')}
        >
          📋 僅複製機密設定指令
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
