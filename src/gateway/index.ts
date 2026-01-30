export { buildEnvVars } from './env';
export { mountR2Storage } from './r2';
export { findExistingMoltbotProcess, ensureMoltbotGateway } from './process';
export { syncToR2 } from './sync';
export { waitForProcess } from './utils';
export {
  createSnapshot,
  listSnapshots,
  getSnapshot,
  restoreSnapshot,
  deleteSnapshot,
  compareSnapshot,
  loadSnapshotIndex,
  getSnapshotConfig,
  type SnapshotMetadata,
  type SnapshotIndex,
  type SnapshotContent,
  type SnapshotResult,
  type SnapshotConfig,
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
