#!/usr/bin/env node
/**
 * Snapshot Creator Script
 *
 * This script runs inside the container to create snapshots of moltbot's configuration.
 * It's called by start-moltbot.sh during startup to create automatic snapshots.
 *
 * Usage:
 *   node snapshot-creator.js [--trigger <trigger>] [--description <description>]
 *
 * Options:
 *   --trigger       Snapshot trigger type: manual, auto, pre-evolution, pre-sync
 *   --description   Optional description for the snapshot
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Configuration
const CONFIG_DIR = '/root/.clawdbot';
const SKILLS_DIR = '/root/clawd/skills';
const BACKUP_DIR = '/data/moltbot';
const SNAPSHOTS_DIR = path.join(BACKUP_DIR, 'snapshots');
const INDEX_FILE = path.join(SNAPSHOTS_DIR, 'index.json');

const DEFAULT_MAX_SNAPSHOTS = 10;

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    trigger: 'auto',
    description: '',
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--trigger' && args[i + 1]) {
      options.trigger = args[i + 1];
      i++;
    } else if (args[i] === '--description' && args[i + 1]) {
      options.description = args[i + 1];
      i++;
    }
  }

  return options;
}

// Generate unique snapshot ID
function generateSnapshotId() {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(4).toString('hex').slice(0, 6);
  return `snap-${timestamp}-${random}`;
}

// Ensure directory exists
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Load snapshot index
function loadIndex() {
  const defaultIndex = {
    snapshots: [],
    currentVersion: 0,
    maxSnapshots: DEFAULT_MAX_SNAPSHOTS,
  };

  try {
    if (fs.existsSync(INDEX_FILE)) {
      const content = fs.readFileSync(INDEX_FILE, 'utf8');
      const parsed = JSON.parse(content);
      return {
        snapshots: parsed.snapshots || [],
        currentVersion: parsed.currentVersion || 0,
        maxSnapshots: parsed.maxSnapshots || DEFAULT_MAX_SNAPSHOTS,
      };
    }
  } catch (err) {
    console.error('[Snapshot] Failed to load index:', err.message);
  }

  return defaultIndex;
}

// Save snapshot index
function saveIndex(index) {
  try {
    fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
    return true;
  } catch (err) {
    console.error('[Snapshot] Failed to save index:', err.message);
    return false;
  }
}

// Copy directory recursively
function copyDir(src, dest) {
  ensureDir(dest);

  if (!fs.existsSync(src)) {
    return 0;
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  let count = 0;

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      count += copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      count++;
    }
  }

  return count;
}

// Get file size
function getFileSize(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return stats.size;
  } catch {
    return 0;
  }
}

// Get directory size
function getDirSize(dir) {
  let size = 0;

  if (!fs.existsSync(dir)) {
    return size;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      size += getDirSize(fullPath);
    } else {
      size += getFileSize(fullPath);
    }
  }

  return size;
}

// Delete directory recursively
function deleteDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Main function
function main() {
  const options = parseArgs();

  console.log('[Snapshot] Creating snapshot...');
  console.log('[Snapshot] Trigger:', options.trigger);

  // Check if R2 is mounted
  if (!fs.existsSync(BACKUP_DIR)) {
    console.log('[Snapshot] R2 not mounted, skipping snapshot');
    process.exit(0);
  }

  // Ensure snapshots directory exists
  ensureDir(SNAPSHOTS_DIR);

  // Load current index
  const index = loadIndex();

  // Generate snapshot ID and increment version
  const snapshotId = generateSnapshotId();
  const version = index.currentVersion + 1;
  const snapshotDir = path.join(SNAPSHOTS_DIR, snapshotId);

  try {
    // Create snapshot directory
    ensureDir(snapshotDir);
    ensureDir(path.join(snapshotDir, 'skills'));

    // Copy clawdbot.json
    const configPath = path.join(CONFIG_DIR, 'clawdbot.json');
    const hasConfig = fs.existsSync(configPath);
    if (hasConfig) {
      fs.copyFileSync(configPath, path.join(snapshotDir, 'clawdbot.json'));
    }

    // Copy skills
    const skillsCount = copyDir(SKILLS_DIR, path.join(snapshotDir, 'skills'));

    // Get file sizes
    const configSize = hasConfig ? getFileSize(path.join(snapshotDir, 'clawdbot.json')) : 0;
    const skillsSize = getDirSize(path.join(snapshotDir, 'skills'));

    // Create metadata
    const metadata = {
      id: snapshotId,
      timestamp: new Date().toISOString(),
      description: options.description || `${options.trigger} snapshot`,
      trigger: options.trigger,
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

    // Save metadata
    fs.writeFileSync(
      path.join(snapshotDir, 'metadata.json'),
      JSON.stringify(metadata, null, 2)
    );

    // Update index
    index.snapshots.unshift(metadata);
    index.currentVersion = version;

    // Get max snapshots from environment
    const maxSnapshots = parseInt(process.env.SUPER_MOLTWORKER_MAX_SNAPSHOTS || '10', 10) || DEFAULT_MAX_SNAPSHOTS;

    // Enforce max snapshots limit
    while (index.snapshots.length > maxSnapshots) {
      const oldSnapshot = index.snapshots.pop();
      if (oldSnapshot) {
        const oldDir = path.join(SNAPSHOTS_DIR, oldSnapshot.id);
        deleteDir(oldDir);
        console.log('[Snapshot] Deleted old snapshot:', oldSnapshot.id);
      }
    }

    // Save updated index
    if (!saveIndex(index)) {
      console.error('[Snapshot] Failed to save index');
      process.exit(1);
    }

    console.log('[Snapshot] Created snapshot:', snapshotId, '(v' + version + ')');
    console.log('[Snapshot] Config:', hasConfig ? 'Yes' : 'No');
    console.log('[Snapshot] Skills:', skillsCount);

  } catch (err) {
    console.error('[Snapshot] Failed to create snapshot:', err.message);
    // Clean up failed snapshot
    deleteDir(snapshotDir);
    process.exit(1);
  }
}

main();
