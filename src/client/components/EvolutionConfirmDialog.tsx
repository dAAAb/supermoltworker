/**
 * Evolution Confirm Dialog
 *
 * Modal dialog shown when moltbot attempts to modify high-risk configuration.
 * Allows user to approve, reject, or test the proposed changes.
 */

import { useState } from 'react';
import RiskBadge, { type RiskLevel } from './RiskBadge';
import './EvolutionConfirmDialog.css';

interface ConfigChange {
  path: string;
  oldValue: unknown;
  newValue: unknown;
}

interface EvolutionRequestData {
  id: string;
  riskLevel: RiskLevel;
  targetPath: string;
  changes: ConfigChange[];
  snapshotId?: string;
  reason?: string;
  source?: {
    channel: string;
    userId?: string;
  };
}

interface EvolutionConfirmDialogProps {
  evolution: EvolutionRequestData;
  onApprove: (id: string) => Promise<void>;
  onReject: (id: string) => Promise<void>;
  onTest?: (id: string) => Promise<void>;
  onClose: () => void;
}

export default function EvolutionConfirmDialog({
  evolution,
  onApprove,
  onReject,
  onTest,
  onClose,
}: EvolutionConfirmDialogProps) {
  const [processing, setProcessing] = useState<'approve' | 'reject' | 'test' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleAction = async (action: 'approve' | 'reject' | 'test') => {
    setProcessing(action);
    setError(null);
    try {
      if (action === 'approve') {
        await onApprove(evolution.id);
      } else if (action === 'reject') {
        await onReject(evolution.id);
      } else if (action === 'test' && onTest) {
        await onTest(evolution.id);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Operation failed');
    } finally {
      setProcessing(null);
    }
  };

  const formatValue = (value: unknown): string => {
    if (value === undefined) return '(undefined)';
    if (value === null) return '(null)';
    if (typeof value === 'string') return `"${value}"`;
    if (typeof value === 'object') return JSON.stringify(value, null, 2);
    return String(value);
  };

  return (
    <div className="evolution-dialog-overlay" onClick={onClose}>
      <div className="evolution-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <span className="dialog-icon">
            {evolution.riskLevel === 'high' ? '⚠️' : evolution.riskLevel === 'medium' ? '🔔' : '📝'}
          </span>
          <h2>小龍蝦想要進化！</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="dialog-content">
          {error && (
            <div className="dialog-error">
              <span>{error}</span>
              <button onClick={() => setError(null)}>×</button>
            </div>
          )}

          <p className="dialog-description">
            moltbot 正在嘗試修改以下{evolution.riskLevel === 'high' ? '高風險' : evolution.riskLevel === 'medium' ? '中風險' : ''}設定：
          </p>

          <div className="change-info">
            <div className="info-row">
              <span className="info-label">修改項目：</span>
              <code className="info-value">{evolution.targetPath}</code>
            </div>
            <div className="info-row">
              <span className="info-label">風險等級：</span>
              <RiskBadge level={evolution.riskLevel} />
            </div>
            {evolution.source && (
              <div className="info-row">
                <span className="info-label">來源通道：</span>
                <span className="info-value channel-badge">{evolution.source.channel}</span>
              </div>
            )}
            {evolution.reason && (
              <div className="info-row">
                <span className="info-label">修改原因：</span>
                <span className="info-value">{evolution.reason}</span>
              </div>
            )}
          </div>

          <div className="changes-section">
            <h3>變更內容</h3>
            <div className="changes-diff">
              {evolution.changes.map((change, index) => (
                <div key={index} className="change-item">
                  <div className="change-path">{change.path}</div>
                  <div className="change-values">
                    <div className="old-value">
                      <span className="value-label">- </span>
                      <code>{formatValue(change.oldValue)}</code>
                    </div>
                    <div className="new-value">
                      <span className="value-label">+ </span>
                      <code>{formatValue(change.newValue)}</code>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {evolution.snapshotId && (
            <div className="snapshot-info">
              <span className="snapshot-icon">💾</span>
              <span>已自動創建快照：<code>{evolution.snapshotId}</code>（可隨時回滾）</span>
            </div>
          )}
        </div>

        <div className="dialog-actions">
          <button
            className="btn btn-success"
            onClick={() => handleAction('approve')}
            disabled={processing !== null}
          >
            {processing === 'approve' ? '處理中...' : '✅ 允許'}
          </button>
          <button
            className="btn btn-danger"
            onClick={() => handleAction('reject')}
            disabled={processing !== null}
          >
            {processing === 'reject' ? '處理中...' : '❌ 拒絕'}
          </button>
          {onTest && (
            <button
              className="btn btn-secondary"
              onClick={() => handleAction('test')}
              disabled={processing !== null}
            >
              {processing === 'test' ? '測試中...' : '🧪 先測試'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
