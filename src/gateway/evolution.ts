/**
 * SuperMoltWorker Evolution Protection
 *
 * Intercepts and manages moltbot's attempts to modify its own configuration.
 * Provides safety mechanisms to prevent "evolution death" from bad config changes.
 *
 * Key features:
 * - Detects config modifications from any channel (Telegram, LINE, Discord, etc.)
 * - Analyzes risk level of changes
 * - Creates pre-evolution snapshots
 * - Requires user confirmation for high-risk changes
 * - Supports rollback if evolution fails
 */

import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { waitForProcess } from './utils';
import { createSnapshot } from './snapshot';
import { analyzeRisk, generateDiffString, type RiskAnalysis, type ConfigChange } from './risk-analyzer';
import {
  getNotificationManager,
  type NotificationSource,
  type EvolutionDetails,
  type PendingEvolution,
} from './notification';

const CONFIG_PATH = '/root/.clawdbot/clawdbot.json';

/**
 * Evolution request status
 */
export type EvolutionStatus =
  | 'pending'     // Waiting for user approval
  | 'approved'    // User approved, ready to apply
  | 'rejected'    // User rejected
  | 'applied'     // Changes applied successfully
  | 'failed'      // Changes failed to apply
  | 'rolled_back' // Changes rolled back after failure
  | 'expired';    // Request timed out

/**
 * Evolution request
 */
export interface EvolutionRequest {
  id: string;
  status: EvolutionStatus;
  source?: NotificationSource;
  currentConfig: Record<string, unknown>;
  proposedConfig: Record<string, unknown>;
  analysis: RiskAnalysis;
  snapshotId?: string;
  createdAt: string;
  updatedAt: string;
  reason?: string;
  result?: {
    success: boolean;
    error?: string;
  };
}

/**
 * Evolution mode configuration
 */
export type EvolutionMode = 'auto' | 'confirm' | 'test';

/**
 * Get evolution mode from environment
 */
export function getEvolutionMode(env: MoltbotEnv): EvolutionMode {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mode = (env as any).SUPER_MOLTWORKER_EVOLUTION_MODE;
  if (mode === 'auto' || mode === 'confirm' || mode === 'test') {
    return mode;
  }
  return 'confirm'; // Default to requiring confirmation
}

/**
 * Generate evolution request ID
 */
function generateRequestId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `evo-${timestamp}-${random}`;
}

/**
 * Load current configuration from container
 */
export async function loadCurrentConfig(
  sandbox: Sandbox
): Promise<Record<string, unknown> | null> {
  try {
    const proc = await sandbox.startProcess(`cat ${CONFIG_PATH} 2>/dev/null`);
    await waitForProcess(proc, 5000);
    const logs = await proc.getLogs();

    if (!logs.stdout) {
      return null;
    }

    return JSON.parse(logs.stdout);
  } catch {
    return null;
  }
}

/**
 * Save configuration to container
 */
export async function saveConfig(
  sandbox: Sandbox,
  config: Record<string, unknown>
): Promise<{ success: boolean; error?: string }> {
  try {
    const configJson = JSON.stringify(config, null, 2);
    // Escape for shell
    const escaped = configJson.replace(/'/g, "'\\''");
    const proc = await sandbox.startProcess(`echo '${escaped}' > ${CONFIG_PATH}`);
    await waitForProcess(proc, 5000);

    if (proc.exitCode !== 0) {
      const logs = await proc.getLogs();
      return { success: false, error: logs.stderr || 'Failed to write config' };
    }

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Create an evolution request
 *
 * This is called when moltbot attempts to modify its configuration.
 * It analyzes the changes, creates a snapshot, and (depending on mode)
 * either auto-applies or waits for user approval.
 */
export async function createEvolutionRequest(
  sandbox: Sandbox,
  env: MoltbotEnv,
  proposedConfig: Record<string, unknown>,
  options: {
    source?: NotificationSource;
    reason?: string;
    autoApproveIfSafe?: boolean;
  } = {}
): Promise<{
  request: EvolutionRequest;
  autoApproved: boolean;
  notification?: PendingEvolution;
}> {
  const currentConfig = await loadCurrentConfig(sandbox);
  if (!currentConfig) {
    throw new Error('Cannot load current configuration');
  }

  // Analyze risk
  const analysis = analyzeRisk(currentConfig, proposedConfig);

  // Generate request
  const requestId = generateRequestId();
  const now = new Date().toISOString();

  const request: EvolutionRequest = {
    id: requestId,
    status: 'pending',
    source: options.source,
    currentConfig,
    proposedConfig,
    analysis,
    createdAt: now,
    updatedAt: now,
    reason: options.reason,
  };

  // Get evolution mode
  const mode = getEvolutionMode(env);

  // Determine if we should auto-approve
  const shouldAutoApprove =
    mode === 'auto' ||
    (options.autoApproveIfSafe && analysis.overallRisk === 'safe');

  if (shouldAutoApprove && analysis.overallRisk === 'safe') {
    // Auto-approve safe changes
    request.status = 'approved';

    // Apply immediately
    const applyResult = await applyEvolution(sandbox, env, request);
    request.status = applyResult.success ? 'applied' : 'failed';
    request.result = applyResult;

    return {
      request,
      autoApproved: true,
    };
  }

  // Create pre-evolution snapshot
  try {
    const snapshotResult = await createSnapshot(sandbox, env, {
      trigger: 'pre-evolution',
      description: `Pre-evolution snapshot for ${requestId}`,
    });

    if (snapshotResult.success && snapshotResult.snapshot) {
      request.snapshotId = snapshotResult.snapshot.id;
    }
  } catch {
    // Continue without snapshot if it fails
    console.error('[Evolution] Failed to create pre-evolution snapshot');
  }

  // Create notification for user approval
  const manager = getNotificationManager();
  const primaryChange = analysis.changes[0];

  const evolutionDetails: EvolutionDetails = {
    requestId,
    targetPath: primaryChange?.path || 'configuration',
    riskLevel: analysis.overallRisk,
    changes: analysis.changes.map(c => ({
      path: c.path,
      oldValue: c.oldValue,
      newValue: c.newValue,
    })),
    snapshotId: request.snapshotId,
    reason: options.reason,
  };

  const notification = manager.createEvolutionRequest(evolutionDetails, options.source);

  return {
    request,
    autoApproved: false,
    notification,
  };
}

/**
 * Apply an approved evolution
 */
export async function applyEvolution(
  sandbox: Sandbox,
  env: MoltbotEnv,
  request: EvolutionRequest
): Promise<{ success: boolean; error?: string }> {
  // Verify request is approved
  if (request.status !== 'approved' && request.status !== 'pending') {
    return { success: false, error: `Cannot apply evolution in ${request.status} state` };
  }

  // Save the new configuration
  const saveResult = await saveConfig(sandbox, request.proposedConfig);

  if (!saveResult.success) {
    return saveResult;
  }

  console.log(`[Evolution] Applied evolution ${request.id}`);
  console.log(`[Evolution] Changes: ${request.analysis.summary}`);

  return { success: true };
}

/**
 * Rollback an evolution using its snapshot
 */
export async function rollbackEvolution(
  sandbox: Sandbox,
  env: MoltbotEnv,
  request: EvolutionRequest
): Promise<{ success: boolean; error?: string }> {
  if (!request.snapshotId) {
    return { success: false, error: 'No snapshot available for rollback' };
  }

  // Restore from snapshot
  try {
    // Import dynamically to avoid circular dependency
    const { restoreSnapshot } = await import('./snapshot');
    const result = await restoreSnapshot(sandbox, env, request.snapshotId);

    if (result.success) {
      console.log(`[Evolution] Rolled back evolution ${request.id} to snapshot ${request.snapshotId}`);
      return { success: true };
    }

    return { success: false, error: result.error || 'Restore failed' };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Preview what an evolution would change
 */
export function previewEvolution(
  currentConfig: Record<string, unknown>,
  proposedConfig: Record<string, unknown>
): {
  analysis: RiskAnalysis;
  diff: string;
  summary: string;
} {
  const analysis = analyzeRisk(currentConfig, proposedConfig);
  const diff = generateDiffString(analysis.changes);

  return {
    analysis,
    diff,
    summary: analysis.summary,
  };
}

/**
 * Handle evolution approval from user
 */
export async function approveEvolution(
  sandbox: Sandbox,
  env: MoltbotEnv,
  requestId: string,
  source?: NotificationSource
): Promise<{
  success: boolean;
  request?: EvolutionRequest;
  error?: string;
}> {
  const manager = getNotificationManager();
  const pendingEvolution = manager.getPendingEvolution(requestId);

  if (!pendingEvolution) {
    return { success: false, error: 'Evolution request not found' };
  }

  // Update notification status
  manager.updateEvolutionStatus(requestId, 'approved', source);

  // We need to retrieve the full request - in a real implementation,
  // this would be stored in a proper store. For now, return success
  // and the actual apply would happen via API.

  return {
    success: true,
  };
}

/**
 * Handle evolution rejection from user
 */
export async function rejectEvolution(
  requestId: string,
  source?: NotificationSource
): Promise<{ success: boolean; error?: string }> {
  const manager = getNotificationManager();
  const pendingEvolution = manager.getPendingEvolution(requestId);

  if (!pendingEvolution) {
    return { success: false, error: 'Evolution request not found' };
  }

  // Update notification status
  manager.updateEvolutionStatus(requestId, 'rejected', source);

  console.log(`[Evolution] Rejected evolution ${requestId}`);

  return { success: true };
}

/**
 * Watch for config file changes (placeholder for future implementation)
 *
 * In a full implementation, this would use inotify or polling to detect
 * when moltbot modifies the config file, and trigger the evolution flow.
 */
export function watchConfigChanges(
  sandbox: Sandbox,
  env: MoltbotEnv,
  callback: (oldConfig: Record<string, unknown>, newConfig: Record<string, unknown>) => void
): () => void {
  // Placeholder - would implement file watching
  console.log('[Evolution] Config watching not yet implemented');

  // Return cleanup function
  return () => {
    console.log('[Evolution] Stopped watching config');
  };
}
