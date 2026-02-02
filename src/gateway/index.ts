export { buildEnvVars } from './env';
export { mountR2Storage } from './r2';
export { findExistingMoltbotProcess, ensureMoltbotGateway } from './process';
export { syncToR2, syncToR2WithProtection } from './sync';
export { waitForProcess } from './utils';
export {
  validateSync,
  handleDangerousSync,
  getSyncStatus,
  getConflictAlerts,
  resolveConflictAlert,
  getSyncValidatorConfig,
  type SyncDecision,
  type SyncDiff,
  type ConflictAlert,
  type SyncValidatorConfig,
} from './sync-validator';
export {
  getSettingsSyncStatus,
  generateExportCommands,
  loadPendingEnvSync,
  savePendingEnvSync,
  addPendingEnvSync,
  removePendingEnvSync,
  markAsReminded,
  getPendingItemsForReminder,
  SETTING_DEFINITIONS,
  type SettingDefinition,
  type SettingItem,
  type PendingEnvSync,
  type PendingEnvSyncFile,
  type SettingsSyncStatus,
} from './settings-sync';
export {
  checkAndSendReminders,
  saveAdminInfo,
  generateImmediateNotification,
} from './env-sync-reminder';
export {
  createSnapshot,
  listSnapshots,
  getSnapshot,
  restoreSnapshot,
  deleteSnapshot,
  compareSnapshot,
  loadSnapshotIndex,
  getSnapshotConfig,
  calculateCompletenessScore,
  type SnapshotMetadata,
  type SnapshotIndex,
  type SnapshotContent,
  type SnapshotResult,
  type SnapshotConfig,
  type CompletenessScore,
} from './snapshot';
export {
  getNotificationManager,
  notifySnapshotCreated,
  notifyConflictDetected,
  notifyHealthWarning,
  type Notification,
  type NotificationType,
  type NotificationSeverity,
  type NotificationAction,
  type NotificationSource,
  type EvolutionDetails,
  type PendingEvolution,
} from './notification';
export {
  detectConflicts,
  autoFixConflicts,
  type ConflictType,
  type ConflictSeverity,
  type Conflict,
  type ConflictReport,
  type AutoFixResult,
} from './conflict-detector';
export {
  quickHealthCheck,
  fullHealthCheck,
  repairHealthIssues,
  type HealthStatus,
  type HealthCheckItem,
  type HealthIssue,
  type HealthReport,
  type RepairResult,
} from './health-check';
export {
  analyzeRisk,
  detectChanges,
  requiresConfirmation,
  describeChange,
  generateDiffString,
  type RiskLevel,
  type ConfigChange,
  type RiskAnalysis,
} from './risk-analyzer';
export {
  createEvolutionRequest,
  applyEvolution,
  rollbackEvolution,
  approveEvolution,
  rejectEvolution,
  loadCurrentConfig,
  saveConfig,
  previewEvolution,
  getEvolutionMode,
  type EvolutionStatus,
  type EvolutionRequest,
  type EvolutionMode,
} from './evolution';
export {
  recordSyncSuccess,
  recordSyncFailure,
  getSyncAlertStatus,
  sendSyncFailureAlert,
  type SyncStatus,
} from './sync-alert';
