/**
 * Reset Wizard Component
 *
 * A step-by-step wizard for completely resetting moltbot state.
 * Allows users to selectively preserve certain data before reset.
 */

import { useState } from 'react';
import './ResetWizard.css';

interface ResetOptions {
  preserveConversations: boolean;
  preservePairedDevices: boolean;
  preserveCustomSkills: boolean;
  createFinalSnapshot: boolean;
}

interface ResetWizardProps {
  onComplete: () => void;
  onCancel: () => void;
}

type Step = 'intro' | 'options' | 'confirm' | 'backup' | 'resetting' | 'complete';

export default function ResetWizard({ onComplete, onCancel }: ResetWizardProps) {
  const [step, setStep] = useState<Step>('intro');
  const [options, setOptions] = useState<ResetOptions>({
    preserveConversations: false,
    preservePairedDevices: false,
    preserveCustomSkills: true,
    createFinalSnapshot: true,
  });
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  const handleCreateSnapshot = async () => {
    setStep('backup');
    setError(null);
    try {
      const response = await fetch('/api/admin/snapshots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: '重置前最終快照',
          trigger: 'pre-reset',
        }),
      });
      const data = await response.json() as { success: boolean; snapshot?: { id: string }; error?: string };
      if (data.success && data.snapshot) {
        setSnapshotId(data.snapshot.id);
        setStep('resetting');
        await performReset();
      } else {
        throw new Error(data.error || 'Failed to create snapshot');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create snapshot');
      setStep('confirm');
    }
  };

  const performReset = async () => {
    setProgress(0);
    setError(null);

    try {
      // Simulate progress for better UX
      const progressInterval = setInterval(() => {
        setProgress((p) => Math.min(p + 10, 90));
      }, 500);

      const response = await fetch('/api/admin/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preserveConversations: options.preserveConversations,
          preservePairedDevices: options.preservePairedDevices,
          preserveCustomSkills: options.preserveCustomSkills,
        }),
      });

      clearInterval(progressInterval);
      const data = await response.json() as { success: boolean; error?: string };

      if (data.success) {
        setProgress(100);
        setStep('complete');
      } else {
        throw new Error(data.error || 'Reset failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reset failed');
      setStep('confirm');
    }
  };

  const handleProceed = async () => {
    if (options.createFinalSnapshot) {
      await handleCreateSnapshot();
    } else {
      setStep('resetting');
      await performReset();
    }
  };

  const toggleOption = (key: keyof ResetOptions) => {
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div className="reset-wizard-overlay">
      <div className="reset-wizard">
        {/* Step: Intro */}
        {step === 'intro' && (
          <div className="wizard-step">
            <div className="step-header">
              <span className="step-icon">🔄</span>
              <h2>完全重置精靈</h2>
            </div>
            <div className="step-content">
              <p className="intro-text">
                此精靈將引導您完全重置小龍蝦的狀態。
                重置後，所有設定將回到預設值。
              </p>
              <div className="warning-box">
                <span className="warning-icon">⚠️</span>
                <div>
                  <strong>注意</strong>
                  <p>此操作無法復原，但您可以選擇保留部分資料，
                  並在重置前創建快照以備需要時回滾。</p>
                </div>
              </div>
            </div>
            <div className="step-actions">
              <button className="btn btn-secondary" onClick={onCancel}>
                取消
              </button>
              <button className="btn btn-primary" onClick={() => setStep('options')}>
                開始 →
              </button>
            </div>
          </div>
        )}

        {/* Step: Options */}
        {step === 'options' && (
          <div className="wizard-step">
            <div className="step-header">
              <span className="step-icon">📋</span>
              <h2>選擇保留項目</h2>
            </div>
            <div className="step-content">
              <p className="options-intro">選擇重置後要保留的資料：</p>
              <div className="options-list">
                <label className="option-item">
                  <input
                    type="checkbox"
                    checked={options.preserveConversations}
                    onChange={() => toggleOption('preserveConversations')}
                  />
                  <div className="option-content">
                    <span className="option-label">💬 保留對話歷史</span>
                    <span className="option-desc">保留所有通道的對話紀錄</span>
                  </div>
                </label>
                <label className="option-item">
                  <input
                    type="checkbox"
                    checked={options.preservePairedDevices}
                    onChange={() => toggleOption('preservePairedDevices')}
                  />
                  <div className="option-content">
                    <span className="option-label">📱 保留配對設備</span>
                    <span className="option-desc">重置後不需重新配對</span>
                  </div>
                </label>
                <label className="option-item">
                  <input
                    type="checkbox"
                    checked={options.preserveCustomSkills}
                    onChange={() => toggleOption('preserveCustomSkills')}
                  />
                  <div className="option-content">
                    <span className="option-label">🔧 保留自訂技能</span>
                    <span className="option-desc">保留您創建的 skills 檔案</span>
                  </div>
                </label>
                <label className="option-item highlighted">
                  <input
                    type="checkbox"
                    checked={options.createFinalSnapshot}
                    onChange={() => toggleOption('createFinalSnapshot')}
                  />
                  <div className="option-content">
                    <span className="option-label">💾 創建最終快照</span>
                    <span className="option-desc">重置前備份，可隨時回滾（建議勾選）</span>
                  </div>
                </label>
              </div>
            </div>
            <div className="step-actions">
              <button className="btn btn-secondary" onClick={() => setStep('intro')}>
                ← 上一步
              </button>
              <button className="btn btn-primary" onClick={() => setStep('confirm')}>
                下一步 →
              </button>
            </div>
          </div>
        )}

        {/* Step: Confirm */}
        {step === 'confirm' && (
          <div className="wizard-step">
            <div className="step-header">
              <span className="step-icon">✅</span>
              <h2>確認重置</h2>
            </div>
            <div className="step-content">
              {error && (
                <div className="error-box">
                  <span>❌</span>
                  <span>{error}</span>
                </div>
              )}
              <div className="confirm-summary">
                <h3>重置摘要</h3>
                <div className="summary-list">
                  <div className="summary-item">
                    <span className="summary-icon">
                      {options.preserveConversations ? '✓' : '✗'}
                    </span>
                    <span>對話歷史</span>
                    <span className={options.preserveConversations ? 'keep' : 'delete'}>
                      {options.preserveConversations ? '保留' : '刪除'}
                    </span>
                  </div>
                  <div className="summary-item">
                    <span className="summary-icon">
                      {options.preservePairedDevices ? '✓' : '✗'}
                    </span>
                    <span>配對設備</span>
                    <span className={options.preservePairedDevices ? 'keep' : 'delete'}>
                      {options.preservePairedDevices ? '保留' : '刪除'}
                    </span>
                  </div>
                  <div className="summary-item">
                    <span className="summary-icon">
                      {options.preserveCustomSkills ? '✓' : '✗'}
                    </span>
                    <span>自訂技能</span>
                    <span className={options.preserveCustomSkills ? 'keep' : 'delete'}>
                      {options.preserveCustomSkills ? '保留' : '刪除'}
                    </span>
                  </div>
                  <div className="summary-item">
                    <span className="summary-icon">
                      {options.createFinalSnapshot ? '✓' : '✗'}
                    </span>
                    <span>最終快照</span>
                    <span className={options.createFinalSnapshot ? 'keep' : 'delete'}>
                      {options.createFinalSnapshot ? '創建' : '跳過'}
                    </span>
                  </div>
                </div>
              </div>
              <div className="final-warning">
                <span>⚠️</span>
                <span>點擊「執行重置」後將立即開始重置程序。</span>
              </div>
            </div>
            <div className="step-actions">
              <button className="btn btn-secondary" onClick={() => setStep('options')}>
                ← 上一步
              </button>
              <button className="btn btn-danger" onClick={handleProceed}>
                執行重置
              </button>
            </div>
          </div>
        )}

        {/* Step: Backup */}
        {step === 'backup' && (
          <div className="wizard-step">
            <div className="step-header">
              <span className="step-icon">💾</span>
              <h2>創建快照中...</h2>
            </div>
            <div className="step-content center">
              <div className="spinner large"></div>
              <p>正在創建最終快照，請稍候...</p>
            </div>
          </div>
        )}

        {/* Step: Resetting */}
        {step === 'resetting' && (
          <div className="wizard-step">
            <div className="step-header">
              <span className="step-icon">🔄</span>
              <h2>重置中...</h2>
            </div>
            <div className="step-content center">
              <div className="progress-container">
                <div className="progress-bar">
                  <div
                    className="progress-fill"
                    style={{ width: `${progress}%` }}
                  ></div>
                </div>
                <span className="progress-text">{progress}%</span>
              </div>
              <p>正在重置小龍蝦狀態，請勿關閉此頁面...</p>
              {snapshotId && (
                <p className="snapshot-note">
                  快照已創建：<code>{snapshotId}</code>
                </p>
              )}
            </div>
          </div>
        )}

        {/* Step: Complete */}
        {step === 'complete' && (
          <div className="wizard-step">
            <div className="step-header">
              <span className="step-icon">🎉</span>
              <h2>重置完成！</h2>
            </div>
            <div className="step-content center">
              <div className="success-icon">✅</div>
              <p>小龍蝦已成功重置為初始狀態。</p>
              {snapshotId && (
                <div className="snapshot-info">
                  <span>💾</span>
                  <span>已創建快照 <code>{snapshotId}</code>，可隨時回滾。</span>
                </div>
              )}
              <p className="restart-note">
                建議重新啟動 Gateway 以確保所有變更生效。
              </p>
            </div>
            <div className="step-actions center">
              <button className="btn btn-primary" onClick={onComplete}>
                完成
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
