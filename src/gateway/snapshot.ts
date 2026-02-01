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
  trigger: 'manual' | 'auto' | 'pre-evolution' | 'pre-sync' | 'pre-restart' | 'auto-protection';
  version: number;
  files: {
    clawdbotJson: boolean;
    skillsCount: number;
    conversationsCount: number;
    devicesCount: number;
    databasesCount: number;
  };
  metadata: {
    configSize: number;
    skillsSize: number;
    conversationsSize: number;
    devicesSize: number;
    databasesSize: number;
    totalSize: number;
    completenessScore: number;
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
  conversations: string[];
  devices: string[];
  databases: string[];
}

/**
 * Completeness score breakdown
 */
export interface CompletenessScore {
  score: number;  // 0-100
  breakdown: {
    hasConfig: number;        // 0-20
    hasChannels: number;      // 0-20
    hasApiKeys: number;       // 0-20
    hasDevices: number;       // 0-20
    hasConversations: number; // 0-20
  };
  warnings: string[];
}

/**
 * Calculate completeness score for a configuration
 */
export function calculateCompletenessScore(
  config: Record<string, unknown> | null,
  stats: { conversationsCount: number; devicesCount: number }
): CompletenessScore {
  const breakdown = {
    hasConfig: 0,
    hasChannels: 0,
    hasApiKeys: 0,
    hasDevices: 0,
    hasConversations: 0,
  };
  const warnings: string[] = [];

  // Check clawdbot.json exists and is valid
  if (config && Object.keys(config).length > 0) {
    breakdown.hasConfig = 20;
  } else {
    warnings.push('配置檔案為空或不存在');
  }

  // Check channels
  const channels = config?.channels as Record<string, unknown> | undefined;
  if (channels && Object.keys(channels).length > 0) {
    breakdown.hasChannels = 20;
  } else {
    warnings.push('沒有設定任何 channel');
  }

  // Check API keys
  const models = config?.models as Record<string, unknown> | undefined;
  const providers = models?.providers as Record<string, unknown> | undefined;
  const tools = config?.tools as Record<string, unknown> | undefined;
  const web = tools?.web as Record<string, unknown> | undefined;
  const search = web?.search as Record<string, unknown> | undefined;

  const hasAnthropicKey = !!(providers?.anthropic as Record<string, unknown>)?.apiKey;
  const hasOpenAIKey = !!(providers?.openai as Record<string, unknown>)?.apiKey;
  const hasSearchKey = !!search?.apiKey;

  if (hasAnthropicKey || hasOpenAIKey || hasSearchKey) {
    breakdown.hasApiKeys = 20;
  } else {
    warnings.push('沒有設定任何 API key');
  }

  // Check devices
  if (stats.devicesCount > 0) {
    breakdown.hasDevices = 20;
  } else {
    warnings.push('沒有配對的設備');
  }

  // Check conversations
  if (stats.conversationsCount > 0) {
    breakdown.hasConversations = 20;
  } else {
    warnings.push('沒有對話記錄');
  }

  const score = Object.values(breakdown).reduce((a, b) => a + b, 0);

  return { score, breakdown, warnings };
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
 * Read config from a snapshot directory
 */
async function readConfigFromSnapshot(
  sandbox: Sandbox,
  snapshotDir: string
): Promise<Record<string, unknown> | null> {
  try {
    const proc = await sandbox.startProcess(`cat ${snapshotDir}/clawdbot.json 2>/dev/null`);
    await waitForProcess(proc, 5000);
    const logs = await proc.getLogs();
    if (logs.stdout?.trim()) {
      return JSON.parse(logs.stdout.trim());
    }
  } catch {
    // Ignore parse errors
  }
  return null;
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
    trigger?: 'manual' | 'auto' | 'pre-evolution' | 'pre-sync' | 'pre-restart' | 'auto-protection';
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
    // Create snapshot directory with all subdirectories
    const mkdirProc = await sandbox.startProcess(
      `mkdir -p ${snapshotDir}/skills ${snapshotDir}/conversations ${snapshotDir}/devices ${snapshotDir}/databases`
    );
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

    // Copy conversations (entire directory)
    const copyConvProc = await sandbox.startProcess(
      `cp -r /root/.clawdbot/conversations/. ${snapshotDir}/conversations/ 2>/dev/null; ls ${snapshotDir}/conversations/ 2>/dev/null | wc -l`
    );
    await waitForProcess(copyConvProc, 30000); // Allow more time for large conversation history
    const copyConvLogs = await copyConvProc.getLogs();
    const conversationsCount = parseInt(copyConvLogs.stdout?.trim() || '0', 10);

    // Copy devices data
    const copyDevicesProc = await sandbox.startProcess(
      `cp -r /root/.clawdbot/devices/. ${snapshotDir}/devices/ 2>/dev/null; ls ${snapshotDir}/devices/ 2>/dev/null | wc -l`
    );
    await waitForProcess(copyDevicesProc, 10000);
    const copyDevicesLogs = await copyDevicesProc.getLogs();
    const devicesCount = parseInt(copyDevicesLogs.stdout?.trim() || '0', 10);

    // Copy database files (.db files)
    const copyDbProc = await sandbox.startProcess(
      `cp /root/.clawdbot/*.db ${snapshotDir}/databases/ 2>/dev/null; ls ${snapshotDir}/databases/*.db 2>/dev/null | wc -l`
    );
    await waitForProcess(copyDbProc, 10000);
    const copyDbLogs = await copyDbProc.getLogs();
    const databasesCount = parseInt(copyDbLogs.stdout?.trim() || '0', 10);

    // Get file sizes for all directories
    const sizeProc = await sandbox.startProcess(
      `stat -c %s ${snapshotDir}/clawdbot.json 2>/dev/null || echo "0"; ` +
      `du -sb ${snapshotDir}/skills 2>/dev/null | cut -f1 || echo "0"; ` +
      `du -sb ${snapshotDir}/conversations 2>/dev/null | cut -f1 || echo "0"; ` +
      `du -sb ${snapshotDir}/devices 2>/dev/null | cut -f1 || echo "0"; ` +
      `du -sb ${snapshotDir}/databases 2>/dev/null | cut -f1 || echo "0"`
    );
    await waitForProcess(sizeProc, 10000);
    const sizeLogs = await sizeProc.getLogs();
    const sizes = sizeLogs.stdout?.trim().split('\n') || ['0', '0', '0', '0', '0'];
    const configSize = parseInt(sizes[0] || '0', 10);
    const skillsSize = parseInt(sizes[1] || '0', 10);
    const conversationsSize = parseInt(sizes[2] || '0', 10);
    const devicesSize = parseInt(sizes[3] || '0', 10);
    const databasesSize = parseInt(sizes[4] || '0', 10);
    const totalSize = configSize + skillsSize + conversationsSize + devicesSize + databasesSize;

    // Calculate completeness score
    let completenessScore = 0;
    try {
      const configContent = hasConfig ? await readConfigFromSnapshot(sandbox, snapshotDir) : null;
      const score = calculateCompletenessScore(configContent, { conversationsCount, devicesCount });
      completenessScore = score.score;
    } catch {
      console.warn('[Snapshot] Could not calculate completeness score');
    }

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
        conversationsCount,
        devicesCount,
        databasesCount,
      },
      metadata: {
        configSize,
        skillsSize,
        conversationsSize,
        devicesSize,
        databasesSize,
        totalSize,
        completenessScore,
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

    // List conversations
    const convProc = await sandbox.startProcess(
      `ls ${snapshotDir}/conversations/ 2>/dev/null || echo ""`
    );
    await waitForProcess(convProc, 5000);
    const convLogs = await convProc.getLogs();
    const conversations = convLogs.stdout?.trim().split('\n').filter(Boolean) || [];

    // List devices
    const devicesProc = await sandbox.startProcess(
      `ls ${snapshotDir}/devices/ 2>/dev/null || echo ""`
    );
    await waitForProcess(devicesProc, 5000);
    const devicesLogs = await devicesProc.getLogs();
    const devices = devicesLogs.stdout?.trim().split('\n').filter(Boolean) || [];

    // List databases
    const dbProc = await sandbox.startProcess(
      `ls ${snapshotDir}/databases/*.db 2>/dev/null | xargs -n1 basename 2>/dev/null || echo ""`
    );
    await waitForProcess(dbProc, 5000);
    const dbLogs = await dbProc.getLogs();
    const databases = dbLogs.stdout?.trim().split('\n').filter(Boolean) || [];

    return {
      success: true,
      snapshot: {
        metadata,
        clawdbotJson,
        skills: skillNames.map((name) => ({ name, content: '' })),
        conversations,
        devices,
        databases,
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

    // Restore conversations
    const restoreConvProc = await sandbox.startProcess(
      `mkdir -p /root/.clawdbot/conversations; cp -r ${snapshotDir}/conversations/. /root/.clawdbot/conversations/ 2>/dev/null || true`
    );
    await waitForProcess(restoreConvProc, 30000); // Allow more time for large conversation history

    // Restore devices
    const restoreDevicesProc = await sandbox.startProcess(
      `mkdir -p /root/.clawdbot/devices; cp -r ${snapshotDir}/devices/. /root/.clawdbot/devices/ 2>/dev/null || true`
    );
    await waitForProcess(restoreDevicesProc, 10000);

    // Restore databases
    const restoreDbProc = await sandbox.startProcess(
      `cp ${snapshotDir}/databases/*.db /root/.clawdbot/ 2>/dev/null || true`
    );
    await waitForProcess(restoreDbProc, 10000);

    console.log(`[Snapshot] Restored snapshot ${snapshotId} (config, skills, conversations, devices, databases)`);
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
