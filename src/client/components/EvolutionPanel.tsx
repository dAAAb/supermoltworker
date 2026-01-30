/**
 * Evolution Panel Component
 *
 * Displays evolution history, pending requests, and provides controls
 * for managing moltbot's self-modification attempts.
 */

import { useState, useEffect, useCallback } from 'react';
import RiskBadge, { type RiskLevel } from './RiskBadge';
import EvolutionConfirmDialog from './EvolutionConfirmDialog';
import './EvolutionPanel.css';

interface ConfigChange {
  path: string;
  oldValue: unknown;
  newValue: unknown;
}

interface EvolutionRequest {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'applied' | 'failed' | 'rolled_back' | 'expired';
  source?: {
    channel: string;
    userId?: string;
  };
  analysis: {
    overallRisk: RiskLevel;
    summary: string;
    changes: ConfigChange[];
  };
  snapshotId?: string;
  createdAt: string;
  updatedAt: string;
  reason?: string;
}

interface EvolutionPanelProps {
  onEvolutionChange?: () => void;
}

export default function EvolutionPanel({ onEvolutionChange }: EvolutionPanelProps) {
  const [pending, setPending] = useState<EvolutionRequest[]>([]);
  const [history, setHistory] = useState<EvolutionRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedEvolution, setSelectedEvolution] = useState<EvolutionRequest | null>(null);
  const [activeView, setActiveView] = useState<'pending' | 'history'>('pending');

  const fetchPending = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/evolution/pending');
      if (!response.ok) throw new Error('Failed to fetch pending evolutions');
      const data = await response.json() as { pending: EvolutionRequest[] };
      setPending(data.pending || []);
    } catch (err) {
      console.error('Failed to fetch pending evolutions:', err);
    }
  }, []);

  const fetchHistory = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/evolution/history');
      if (!response.ok) throw new Error('Failed to fetch evolution history');
      const data = await response.json() as { history: EvolutionRequest[] };
      setHistory(data.history || []);
    } catch (err) {
      console.error('Failed to fetch evolution history:', err);
    }
  }, []);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await Promise.all([fetchPending(), fetchHistory()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  }, [fetchPending, fetchHistory]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const handleApprove = async (id: string) => {
    const response = await fetch(`/api/admin/evolution/${id}/approve`, { method: 'POST' });
    const data = await response.json() as { success: boolean; error?: string };
    if (!data.success) {
      throw new Error(data.error || 'Approval failed');
    }
    await fetchAll();
    onEvolutionChange?.();
  };

  const handleReject = async (id: string) => {
    const response = await fetch(`/api/admin/evolution/${id}/reject`, { method: 'POST' });
    const data = await response.json() as { success: boolean; error?: string };
    if (!data.success) {
      throw new Error(data.error || 'Rejection failed');
    }
    await fetchAll();
    onEvolutionChange?.();
  };

  const handleTest = async (id: string) => {
    const response = await fetch(`/api/admin/evolution/${id}/test`, { method: 'POST' });
    const data = await response.json() as { success: boolean; error?: string };
    if (!data.success) {
      throw new Error(data.error || 'Test failed');
    }
    await fetchAll();
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'pending':
        return '⏳';
      case 'approved':
        return '✅';
      case 'rejected':
        return '❌';
      case 'applied':
        return '🚀';
      case 'failed':
        return '💥';
      case 'rolled_back':
        return '⏪';
      case 'expired':
        return '⌛';
      default:
        return '❓';
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'pending':
        return '待確認';
      case 'approved':
        return '已核准';
      case 'rejected':
        return '已拒絕';
      case 'applied':
        return '已應用';
      case 'failed':
        return '失敗';
      case 'rolled_back':
        return '已回滾';
      case 'expired':
        return '已過期';
      default:
        return status;
    }
  };

  const formatTime = (isoString: string) => {
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
      if (seconds < 60) return `${seconds}秒前`;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}分鐘前`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours}小時前`;
      const days = Math.floor(hours / 24);
      return `${days}天前`;
    } catch {
      return isoString;
    }
  };

  if (loading) {
    return (
      <div className="evolution-panel loading">
        <div className="spinner"></div>
        <p>載入進化紀錄中...</p>
      </div>
    );
  }

  return (
    <div className="evolution-panel">
      {error && (
        <div className="panel-error">
          <span>{error}</span>
          <button onClick={() => setError(null)}>關閉</button>
        </div>
      )}

      {/* View Tabs */}
      <div className="view-tabs">
        <button
          className={`view-tab ${activeView === 'pending' ? 'active' : ''}`}
          onClick={() => setActiveView('pending')}
        >
          待確認
          {pending.length > 0 && (
            <span className="tab-badge">{pending.length}</span>
          )}
        </button>
        <button
          className={`view-tab ${activeView === 'history' ? 'active' : ''}`}
          onClick={() => setActiveView('history')}
        >
          歷史紀錄
        </button>
        <button className="refresh-btn" onClick={fetchAll} disabled={loading}>
          重新整理
        </button>
      </div>

      {/* Pending View */}
      {activeView === 'pending' && (
        <div className="pending-section">
          {pending.length === 0 ? (
            <div className="empty-state">
              <span className="empty-icon">✨</span>
              <p>目前沒有待確認的進化請求</p>
              <p className="empty-hint">當小龍蝦嘗試修改高風險設定時，會在這裡顯示</p>
            </div>
          ) : (
            <div className="evolution-list">
              {pending.map((evo) => (
                <div key={evo.id} className="evolution-card pending">
                  <div className="card-header">
                    <span className="status-icon">{getStatusIcon(evo.status)}</span>
                    <span className="evolution-summary">{evo.analysis.summary}</span>
                    <RiskBadge level={evo.analysis.overallRisk} size="sm" />
                  </div>
                  <div className="card-details">
                    <div className="detail-row">
                      <span className="detail-label">請求 ID：</span>
                      <code className="detail-value">{evo.id}</code>
                    </div>
                    {evo.source && (
                      <div className="detail-row">
                        <span className="detail-label">來源：</span>
                        <span className="channel-tag">{evo.source.channel}</span>
                      </div>
                    )}
                    <div className="detail-row">
                      <span className="detail-label">時間：</span>
                      <span className="detail-value" title={formatTime(evo.createdAt)}>
                        {formatTimeAgo(evo.createdAt)}
                      </span>
                    </div>
                  </div>
                  <div className="card-actions">
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => setSelectedEvolution(evo)}
                    >
                      查看詳情
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* History View */}
      {activeView === 'history' && (
        <div className="history-section">
          {history.length === 0 ? (
            <div className="empty-state">
              <span className="empty-icon">📜</span>
              <p>還沒有進化歷史紀錄</p>
            </div>
          ) : (
            <div className="evolution-list">
              {history.map((evo) => (
                <div key={evo.id} className={`evolution-card ${evo.status}`}>
                  <div className="card-header">
                    <span className="status-icon">{getStatusIcon(evo.status)}</span>
                    <span className="evolution-summary">{evo.analysis.summary}</span>
                    <span className={`status-badge status-${evo.status}`}>
                      {getStatusLabel(evo.status)}
                    </span>
                  </div>
                  <div className="card-details">
                    <div className="detail-row">
                      <span className="detail-label">風險等級：</span>
                      <RiskBadge level={evo.analysis.overallRisk} size="sm" />
                    </div>
                    {evo.source && (
                      <div className="detail-row">
                        <span className="detail-label">來源：</span>
                        <span className="channel-tag">{evo.source.channel}</span>
                      </div>
                    )}
                    <div className="detail-row">
                      <span className="detail-label">時間：</span>
                      <span className="detail-value" title={formatTime(evo.updatedAt)}>
                        {formatTimeAgo(evo.updatedAt)}
                      </span>
                    </div>
                    {evo.snapshotId && (
                      <div className="detail-row">
                        <span className="detail-label">快照：</span>
                        <code className="detail-value">{evo.snapshotId}</code>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Evolution Confirm Dialog */}
      {selectedEvolution && (
        <EvolutionConfirmDialog
          evolution={{
            id: selectedEvolution.id,
            riskLevel: selectedEvolution.analysis.overallRisk,
            targetPath: selectedEvolution.analysis.changes[0]?.path || 'configuration',
            changes: selectedEvolution.analysis.changes,
            snapshotId: selectedEvolution.snapshotId,
            reason: selectedEvolution.reason,
            source: selectedEvolution.source,
          }}
          onApprove={handleApprove}
          onReject={handleReject}
          onTest={handleTest}
          onClose={() => setSelectedEvolution(null)}
        />
      )}
    </div>
  );
}
