import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { R2_MOUNT_PATH } from '../config';
import { mountR2Storage } from './r2';
import { waitForProcess } from './utils';

/**
 * Snapshot metadata
 */
export interface SnapshotMetadata {
  id: string;
  timestamp: string;
  description: string;
  trigger: 'manual' | 'auto' | 'pre-evolution' | 'pre-sync';
  version: number;
  files: {
    clawdbotJson: boolean;
    skillsCount: number;
  };
  metadata: {
    configSize: number;
    skillsSize: number;
  };
}

/**
 * Snapshot index stored in R2
 */
export interface SnapshotIndex {
  snapshots: SnapshotMetadata[];
  currentVersion: number;
  maxSnapshots: number;
}

/**
 * Snapshot content for restore
 */
export interface SnapshotContent {
  metadata: SnapshotMetadata;
  clawdbotJson: string | null;
  skills: Array<{ name: string; content: string }>;
}

/**
 * Result of snapshot operations
 */
export interface SnapshotResult {
  success: boolean;
  snapshot?: SnapshotMetadata;
  error?: string;
  details?: string;
}

/**
 * Configuration for snapshot system
 */
export interface SnapshotConfig {
  maxSnapshots: number;
  autoSnapshotEnabled: boolean;
}

const DEFAULT_CONFIG: SnapshotConfig = {
  maxSnapshots: 10,
  autoSnapshotEnabled: true,
};

const SNAPSHOTS_DIR = `${R2_MOUNT_PATH}/snapshots`;
const SNAPSHOT_INDEX_FILE = `${SNAPSHOTS_DIR}/index.json`;

/**
 * Generate a unique snapshot ID
 */
function generateSnapshotId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `snap-${timestamp}-${random}`;
}

/**
 * Get snapshot configuration from environment
 */
export function getSnapshotConfig(env: MoltbotEnv): SnapshotConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const envAny = env as any;
  const maxSnapshots = parseInt(envAny.SUPER_MOLTWORKER_MAX_SNAPSHOTS || '10', 10);
  const autoSnapshotEnabled = envAny.SUPER_MOLTWORKER_AUTO_SNAPSHOT !== 'false';

  return {
    maxSnapshots: isNaN(maxSnapshots) ? DEFAULT_CONFIG.maxSnapshots : maxSnapshots,
    autoSnapshotEnabled,
  };
}

/**
 * Initialize snapshot directory and index
 */
async function ensureSnapshotDir(sandbox: Sandbox): Promise<boolean> {
  try {
    const proc = await sandbox.startProcess(`mkdir -p ${SNAPSHOTS_DIR}`);
    await waitForProcess(proc, 5000);
    return true;
  } catch (err) {
    console.error('[Snapshot] Failed to create snapshot directory:', err);
    return false;
  }
}

/**
 * Load snapshot index from R2
 */
export async function loadSnapshotIndex(sandbox: Sandbox): Promise<SnapshotIndex> {
  const defaultIndex: SnapshotIndex = {
    snapshots: [],
    currentVersion: 0,
    maxSnapshots: DEFAULT_CONFIG.maxSnapshots,
  };

  try {
    const proc = await sandbox.startProcess(`cat ${SNAPSHOT_INDEX_FILE} 2>/dev/null || echo "{}"`);
    await waitForProcess(proc, 5000);
    const logs = await proc.getLogs();
    const content = logs.stdout?.trim();

    if (content && content !== '{}') {
      const parsed = JSON.parse(content);
      return {
        snapshots: parsed.snapshots || [],
        currentVersion: parsed.currentVersion || 0,
        maxSnapshots: parsed.maxSnapshots || DEFAULT_CONFIG.maxSnapshots,
      };
    }
  } catch (err) {
    console.error('[Snapshot] Failed to load index:', err);
  }

  return defaultIndex;
}

/**
 * Save snapshot index to R2
 */
async function saveSnapshotIndex(sandbox: Sandbox, index: SnapshotIndex): Promise<boolean> {
  try {
    const content = JSON.stringify(index, null, 2);
    const escapedContent = content.replace(/'/g, "'\\''");
    const proc = await sandbox.startProcess(
      `echo '${escapedContent}' > ${SNAPSHOT_INDEX_FILE}`
    );
    await waitForProcess(proc, 5000);
    return true;
  } catch (err) {
    console.error('[Snapshot] Failed to save index:', err);
    return false;
  }
}

/**
 * Create a new snapshot
 */
export async function createSnapshot(
  sandbox: Sandbox,
  env: MoltbotEnv,
  options: {
    description?: string;
    trigger?: 'manual' | 'auto' | 'pre-evolution' | 'pre-sync';
  } = {}
): Promise<SnapshotResult> {
  const { description = '', trigger = 'manual' } = options;

  // Mount R2 if not already mounted
  const mounted = await mountR2Storage(sandbox, env);
  if (!mounted) {
    return { success: false, error: 'R2 storage not available' };
  }

  // Ensure snapshot directory exists
  if (!(await ensureSnapshotDir(sandbox))) {
    return { success: false, error: 'Failed to create snapshot directory' };
  }

  // Load current index
  const index = await loadSnapshotIndex(sandbox);
  const config = getSnapshotConfig(env);

  // Generate snapshot ID and increment version
  const snapshotId = generateSnapshotId();
  const version = index.currentVersion + 1;
  const snapshotDir = `${SNAPSHOTS_DIR}/${snapshotId}`;

  try {
    // Create snapshot directory
    const mkdirProc = await sandbox.startProcess(`mkdir -p ${snapshotDir}/skills`);
    await waitForProcess(mkdirProc, 5000);

    // Copy clawdbot.json
    const copyConfigProc = await sandbox.startProcess(
      `cp /root/.clawdbot/clawdbot.json ${snapshotDir}/clawdbot.json 2>/dev/null || echo "no-config"`
    );
    await waitForProcess(copyConfigProc, 5000);
    const copyConfigLogs = await copyConfigProc.getLogs();
    const hasConfig = !copyConfigLogs.stdout?.includes('no-config');

    // Copy skills
    const copySkillsProc = await sandbox.startProcess(
      `cp -r /root/clawd/skills/. ${snapshotDir}/skills/ 2>/dev/null; ls ${snapshotDir}/skills/ 2>/dev/null | wc -l`
    );
    await waitForProcess(copySkillsProc, 10000);
    const copySkillsLogs = await copySkillsProc.getLogs();
    const skillsCount = parseInt(copySkillsLogs.stdout?.trim() || '0', 10);

    // Get file sizes
    const sizeProc = await sandbox.startProcess(
      `stat -c %s ${snapshotDir}/clawdbot.json 2>/dev/null || echo "0"; du -sb ${snapshotDir}/skills 2>/dev/null | cut -f1 || echo "0"`
    );
    await waitForProcess(sizeProc, 5000);
    const sizeLogs = await sizeProc.getLogs();
    const sizes = sizeLogs.stdout?.trim().split('\n') || ['0', '0'];
    const configSize = parseInt(sizes[0] || '0', 10);
    const skillsSize = parseInt(sizes[1] || '0', 10);

    // Create metadata
    const metadata: SnapshotMetadata = {
      id: snapshotId,
      timestamp: new Date().toISOString(),
      description: description || `${trigger} snapshot`,
      trigger,
      version,
      files: {
        clawdbotJson: hasConfig,
        skillsCount,
      },
      metadata: {
        configSize,
        skillsSize,
      },
    };

    // Save metadata to snapshot directory
    const metadataContent = JSON.stringify(metadata, null, 2).replace(/'/g, "'\\''");
    const saveMetaProc = await sandbox.startProcess(
      `echo '${metadataContent}' > ${snapshotDir}/metadata.json`
    );
    await waitForProcess(saveMetaProc, 5000);

    // Update index
    index.snapshots.unshift(metadata);
    index.currentVersion = version;

    // Enforce max snapshots limit
    while (index.snapshots.length > config.maxSnapshots) {
      const oldSnapshot = index.snapshots.pop();
      if (oldSnapshot) {
        // Delete old snapshot directory
        const deleteProc = await sandbox.startProcess(
          `rm -rf ${SNAPSHOTS_DIR}/${oldSnapshot.id}`
        );
        await waitForProcess(deleteProc, 5000);
        console.log(`[Snapshot] Deleted old snapshot: ${oldSnapshot.id}`);
      }
    }

    // Save updated index
    if (!(await saveSnapshotIndex(sandbox, index))) {
      return { success: false, error: 'Failed to save snapshot index' };
    }

    console.log(`[Snapshot] Created snapshot ${snapshotId} (v${version})`);
    return { success: true, snapshot: metadata };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('[Snapshot] Failed to create snapshot:', errorMessage);
    return { success: false, error: 'Failed to create snapshot', details: errorMessage };
  }
}

/**
 * List all snapshots
 */
export async function listSnapshots(
  sandbox: Sandbox,
  env: MoltbotEnv
): Promise<{ success: boolean; snapshots?: SnapshotMetadata[]; error?: string }> {
  // Mount R2 if not already mounted
  const mounted = await mountR2Storage(sandbox, env);
  if (!mounted) {
    return { success: false, error: 'R2 storage not available' };
  }

  const index = await loadSnapshotIndex(sandbox);
  return { success: true, snapshots: index.snapshots };
}

/**
 * Get snapshot details including content
 */
export async function getSnapshot(
  sandbox: Sandbox,
  env: MoltbotEnv,
  snapshotId: string
): Promise<{ success: boolean; snapshot?: SnapshotContent; error?: string; details?: string }> {
  // Mount R2 if not already mounted
  const mounted = await mountR2Storage(sandbox, env);
  if (!mounted) {
    return { success: false, error: 'R2 storage not available' };
  }

  const snapshotDir = `${SNAPSHOTS_DIR}/${snapshotId}`;

  try {
    // Load metadata
    const metaProc = await sandbox.startProcess(`cat ${snapshotDir}/metadata.json`);
    await waitForProcess(metaProc, 5000);
    const metaLogs = await metaProc.getLogs();
    if (!metaLogs.stdout) {
      return { success: false, error: 'Snapshot not found' };
    }
    const metadata: SnapshotMetadata = JSON.parse(metaLogs.stdout);

    // Load clawdbot.json
    const configProc = await sandbox.startProcess(
      `cat ${snapshotDir}/clawdbot.json 2>/dev/null || echo ""`
    );
    await waitForProcess(configProc, 5000);
    const configLogs = await configProc.getLogs();
    const clawdbotJson = configLogs.stdout?.trim() || null;

    // List skills (don't load content to save memory)
    const skillsProc = await sandbox.startProcess(
      `ls ${snapshotDir}/skills/ 2>/dev/null || echo ""`
    );
    await waitForProcess(skillsProc, 5000);
    const skillsLogs = await skillsProc.getLogs();
    const skillNames = skillsLogs.stdout?.trim().split('\n').filter(Boolean) || [];

    return {
      success: true,
      snapshot: {
        metadata,
        clawdbotJson,
        skills: skillNames.map((name) => ({ name, content: '' })),
      },
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { success: false, error: 'Failed to load snapshot', details: errorMessage };
  }
}

/**
 * Restore a snapshot
 */
export async function restoreSnapshot(
  sandbox: Sandbox,
  env: MoltbotEnv,
  snapshotId: string
): Promise<SnapshotResult> {
  // Mount R2 if not already mounted
  const mounted = await mountR2Storage(sandbox, env);
  if (!mounted) {
    return { success: false, error: 'R2 storage not available' };
  }

  const snapshotDir = `${SNAPSHOTS_DIR}/${snapshotId}`;

  try {
    // Verify snapshot exists
    const checkProc = await sandbox.startProcess(
      `test -f ${snapshotDir}/metadata.json && echo "ok"`
    );
    await waitForProcess(checkProc, 5000);
    const checkLogs = await checkProc.getLogs();
    if (!checkLogs.stdout?.includes('ok')) {
      return { success: false, error: 'Snapshot not found' };
    }

    // Load metadata for return value
    const metaProc = await sandbox.startProcess(`cat ${snapshotDir}/metadata.json`);
    await waitForProcess(metaProc, 5000);
    const metaLogs = await metaProc.getLogs();
    const metadata: SnapshotMetadata = JSON.parse(metaLogs.stdout || '{}');

    // Create a pre-restore snapshot first
    const preRestoreResult = await createSnapshot(sandbox, env, {
      description: `Pre-restore backup (before restoring ${snapshotId})`,
      trigger: 'auto',
    });
    if (!preRestoreResult.success) {
      console.warn('[Snapshot] Failed to create pre-restore snapshot:', preRestoreResult.error);
    }

    // Restore clawdbot.json
    const restoreConfigProc = await sandbox.startProcess(
      `cp ${snapshotDir}/clawdbot.json /root/.clawdbot/clawdbot.json 2>/dev/null || true`
    );
    await waitForProcess(restoreConfigProc, 5000);

    // Restore skills
    const restoreSkillsProc = await sandbox.startProcess(
      `rm -rf /root/clawd/skills/* 2>/dev/null; cp -r ${snapshotDir}/skills/. /root/clawd/skills/ 2>/dev/null || true`
    );
    await waitForProcess(restoreSkillsProc, 10000);

    console.log(`[Snapshot] Restored snapshot ${snapshotId}`);
    return { success: true, snapshot: metadata };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('[Snapshot] Failed to restore snapshot:', errorMessage);
    return { success: false, error: 'Failed to restore snapshot', details: errorMessage };
  }
}

/**
 * Delete a snapshot
 */
export async function deleteSnapshot(
  sandbox: Sandbox,
  env: MoltbotEnv,
  snapshotId: string
): Promise<{ success: boolean; error?: string; details?: string }> {
  // Mount R2 if not already mounted
  const mounted = await mountR2Storage(sandbox, env);
  if (!mounted) {
    return { success: false, error: 'R2 storage not available' };
  }

  try {
    // Load index
    const index = await loadSnapshotIndex(sandbox);

    // Find and remove from index
    const snapshotIndex = index.snapshots.findIndex((s) => s.id === snapshotId);
    if (snapshotIndex === -1) {
      return { success: false, error: 'Snapshot not found' };
    }

    index.snapshots.splice(snapshotIndex, 1);

    // Delete directory
    const deleteProc = await sandbox.startProcess(
      `rm -rf ${SNAPSHOTS_DIR}/${snapshotId}`
    );
    await waitForProcess(deleteProc, 5000);

    // Save updated index
    if (!(await saveSnapshotIndex(sandbox, index))) {
      return { success: false, error: 'Failed to update snapshot index' };
    }

    console.log(`[Snapshot] Deleted snapshot ${snapshotId}`);
    return { success: true };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { success: false, error: 'Failed to delete snapshot', details: errorMessage };
  }
}

/**
 * Compare two snapshots or snapshot with current state
 */
export async function compareSnapshot(
  sandbox: Sandbox,
  env: MoltbotEnv,
  snapshotId: string,
  compareToId?: string // If not provided, compare to current state
): Promise<{
  success: boolean;
  diff?: {
    configChanged: boolean;
    configDiff?: string;
    skillsAdded: string[];
    skillsRemoved: string[];
    skillsModified: string[];
  };
  error?: string;
  details?: string;
}> {
  // Mount R2 if not already mounted
  const mounted = await mountR2Storage(sandbox, env);
  if (!mounted) {
    return { success: false, error: 'R2 storage not available' };
  }

  const snapshotDir = `${SNAPSHOTS_DIR}/${snapshotId}`;
  const compareDir = compareToId
    ? `${SNAPSHOTS_DIR}/${compareToId}`
    : '/root/.clawdbot';
  const compareSkillsDir = compareToId
    ? `${SNAPSHOTS_DIR}/${compareToId}/skills`
    : '/root/clawd/skills';

  try {
    // Compare clawdbot.json
    const diffProc = await sandbox.startProcess(
      `diff ${snapshotDir}/clawdbot.json ${compareDir}/clawdbot.json 2>/dev/null || echo "DIFF"`
    );
    await waitForProcess(diffProc, 5000);
    const diffLogs = await diffProc.getLogs();
    const configChanged = diffLogs.stdout?.includes('DIFF') || (diffLogs.stdout?.trim().length || 0) > 0;

    // Compare skills
    const snapshotSkillsProc = await sandbox.startProcess(
      `ls ${snapshotDir}/skills/ 2>/dev/null | sort`
    );
    await waitForProcess(snapshotSkillsProc, 5000);
    const snapshotSkillsLogs = await snapshotSkillsProc.getLogs();
    const snapshotSkills = new Set(
      snapshotSkillsLogs.stdout?.trim().split('\n').filter(Boolean) || []
    );

    const compareSkillsProc = await sandbox.startProcess(
      `ls ${compareSkillsDir}/ 2>/dev/null | sort`
    );
    await waitForProcess(compareSkillsProc, 5000);
    const compareSkillsLogs = await compareSkillsProc.getLogs();
    const compareSkills = new Set(
      compareSkillsLogs.stdout?.trim().split('\n').filter(Boolean) || []
    );

    const skillsAdded = [...compareSkills].filter((s) => !snapshotSkills.has(s));
    const skillsRemoved = [...snapshotSkills].filter((s) => !compareSkills.has(s));

    return {
      success: true,
      diff: {
        configChanged,
        configDiff: configChanged ? diffLogs.stdout : undefined,
        skillsAdded,
        skillsRemoved,
        skillsModified: [], // TODO: implement file content comparison
      },
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { success: false, error: 'Failed to compare snapshots', details: errorMessage };
  }
}
