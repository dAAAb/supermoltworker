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
          description: 'Final snapshot before reset',
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
              <h2>Full Reset Wizard</h2>
            </div>
            <div className="step-content">
              <p className="intro-text">
                This wizard will guide you through completely resetting moltbot's state.
                After reset, all settings will return to defaults.
              </p>
              <div className="warning-box">
                <span className="warning-icon">⚠️</span>
                <div>
                  <strong>Warning</strong>
                  <p>This action cannot be undone, but you can choose to preserve certain data
                  and create a snapshot before reset for rollback if needed.</p>
                </div>
              </div>
            </div>
            <div className="step-actions">
              <button className="btn btn-secondary" onClick={onCancel}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={() => setStep('options')}>
                Start →
              </button>
            </div>
          </div>
        )}

        {/* Step: Options */}
        {step === 'options' && (
          <div className="wizard-step">
            <div className="step-header">
              <span className="step-icon">📋</span>
              <h2>Select Data to Preserve</h2>
            </div>
            <div className="step-content">
              <p className="options-intro">Choose what data to keep after reset:</p>
              <div className="options-list">
                <label className="option-item">
                  <input
                    type="checkbox"
                    checked={options.preserveConversations}
                    onChange={() => toggleOption('preserveConversations')}
                  />
                  <div className="option-content">
                    <span className="option-label">💬 Preserve Conversations</span>
                    <span className="option-desc">Keep conversation history from all channels</span>
                  </div>
                </label>
                <label className="option-item">
                  <input
                    type="checkbox"
                    checked={options.preservePairedDevices}
                    onChange={() => toggleOption('preservePairedDevices')}
                  />
                  <div className="option-content">
                    <span className="option-label">📱 Preserve Paired Devices</span>
                    <span className="option-desc">No need to re-pair after reset</span>
                  </div>
                </label>
                <label className="option-item">
                  <input
                    type="checkbox"
                    checked={options.preserveCustomSkills}
                    onChange={() => toggleOption('preserveCustomSkills')}
                  />
                  <div className="option-content">
                    <span className="option-label">🔧 Preserve Custom Skills</span>
                    <span className="option-desc">Keep your custom skills files</span>
                  </div>
                </label>
                <label className="option-item highlighted">
                  <input
                    type="checkbox"
                    checked={options.createFinalSnapshot}
                    onChange={() => toggleOption('createFinalSnapshot')}
                  />
                  <div className="option-content">
                    <span className="option-label">💾 Create Final Snapshot</span>
                    <span className="option-desc">Backup before reset, can rollback anytime (recommended)</span>
                  </div>
                </label>
              </div>
            </div>
            <div className="step-actions">
              <button className="btn btn-secondary" onClick={() => setStep('intro')}>
                ← Back
              </button>
              <button className="btn btn-primary" onClick={() => setStep('confirm')}>
                Next →
              </button>
            </div>
          </div>
        )}

        {/* Step: Confirm */}
        {step === 'confirm' && (
          <div className="wizard-step">
            <div className="step-header">
              <span className="step-icon">✅</span>
              <h2>Confirm Reset</h2>
            </div>
            <div className="step-content">
              {error && (
                <div className="error-box">
                  <span>❌</span>
                  <span>{error}</span>
                </div>
              )}
              <div className="confirm-summary">
                <h3>Reset Summary</h3>
                <div className="summary-list">
                  <div className="summary-item">
                    <span className="summary-icon">
                      {options.preserveConversations ? '✓' : '✗'}
                    </span>
                    <span>Conversations</span>
                    <span className={options.preserveConversations ? 'keep' : 'delete'}>
                      {options.preserveConversations ? 'Keep' : 'Delete'}
                    </span>
                  </div>
                  <div className="summary-item">
                    <span className="summary-icon">
                      {options.preservePairedDevices ? '✓' : '✗'}
                    </span>
                    <span>Paired Devices</span>
                    <span className={options.preservePairedDevices ? 'keep' : 'delete'}>
                      {options.preservePairedDevices ? 'Keep' : 'Delete'}
                    </span>
                  </div>
                  <div className="summary-item">
                    <span className="summary-icon">
                      {options.preserveCustomSkills ? '✓' : '✗'}
                    </span>
                    <span>Custom Skills</span>
                    <span className={options.preserveCustomSkills ? 'keep' : 'delete'}>
                      {options.preserveCustomSkills ? 'Keep' : 'Delete'}
                    </span>
                  </div>
                  <div className="summary-item">
                    <span className="summary-icon">
                      {options.createFinalSnapshot ? '✓' : '✗'}
                    </span>
                    <span>Final Snapshot</span>
                    <span className={options.createFinalSnapshot ? 'keep' : 'delete'}>
                      {options.createFinalSnapshot ? 'Create' : 'Skip'}
                    </span>
                  </div>
                </div>
              </div>
              <div className="final-warning">
                <span>⚠️</span>
                <span>Clicking "Execute Reset" will immediately start the reset process.</span>
              </div>
            </div>
            <div className="step-actions">
              <button className="btn btn-secondary" onClick={() => setStep('options')}>
                ← Back
              </button>
              <button className="btn btn-danger" onClick={handleProceed}>
                Execute Reset
              </button>
            </div>
          </div>
        )}

        {/* Step: Backup */}
        {step === 'backup' && (
          <div className="wizard-step">
            <div className="step-header">
              <span className="step-icon">💾</span>
              <h2>Creating Snapshot...</h2>
            </div>
            <div className="step-content center">
              <div className="spinner large"></div>
              <p>Creating final snapshot, please wait...</p>
            </div>
          </div>
        )}

        {/* Step: Resetting */}
        {step === 'resetting' && (
          <div className="wizard-step">
            <div className="step-header">
              <span className="step-icon">🔄</span>
              <h2>Resetting...</h2>
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
              <p>Resetting moltbot state, please do not close this page...</p>
              {snapshotId && (
                <p className="snapshot-note">
                  Snapshot created: <code>{snapshotId}</code>
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
              <h2>Reset Complete!</h2>
            </div>
            <div className="step-content center">
              <div className="success-icon">✅</div>
              <p>Moltbot has been successfully reset to initial state.</p>
              {snapshotId && (
                <div className="snapshot-info">
                  <span>💾</span>
                  <span>Snapshot <code>{snapshotId}</code> created, you can rollback anytime.</span>
                </div>
              )}
              <p className="restart-note">
                It is recommended to restart the Gateway to ensure all changes take effect.
              </p>
            </div>
            <div className="step-actions center">
              <button className="btn btn-primary" onClick={onComplete}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
