// API client for admin endpoints
// Authentication is handled by Cloudflare Access (JWT in cookies)

const API_BASE = '/api/admin';

export interface PendingDevice {
  requestId: string;
  deviceId: string;
  displayName?: string;
  platform?: string;
  clientId?: string;
  clientMode?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  remoteIp?: string;
  ts: number;
}

export interface PairedDevice {
  deviceId: string;
  displayName?: string;
  platform?: string;
  clientId?: string;
  clientMode?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  createdAtMs: number;
  approvedAtMs: number;
}

export interface DeviceListResponse {
  pending: PendingDevice[];
  paired: PairedDevice[];
  raw?: string;
  stderr?: string;
  parseError?: string;
  error?: string;
}

export interface ApproveResponse {
  success: boolean;
  requestId: string;
  message?: string;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface ApproveAllResponse {
  approved: string[];
  failed: Array<{ requestId: string; success: boolean; error?: string }>;
  message?: string;
  error?: string;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

async function apiRequest<T>(
  path: string,
  options: globalThis.RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  } as globalThis.RequestInit);

  if (response.status === 401) {
    throw new AuthError('Unauthorized - please log in via Cloudflare Access');
  }

  const data = await response.json() as T & { error?: string };

  if (!response.ok) {
    throw new Error(data.error || `API error: ${response.status}`);
  }

  return data;
}

export async function listDevices(): Promise<DeviceListResponse> {
  return apiRequest<DeviceListResponse>('/devices');
}

export async function approveDevice(requestId: string): Promise<ApproveResponse> {
  return apiRequest<ApproveResponse>(`/devices/${requestId}/approve`, {
    method: 'POST',
  });
}

export async function approveAllDevices(): Promise<ApproveAllResponse> {
  return apiRequest<ApproveAllResponse>('/devices/approve-all', {
    method: 'POST',
  });
}

export interface RestartGatewayResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export async function restartGateway(): Promise<RestartGatewayResponse> {
  return apiRequest<RestartGatewayResponse>('/gateway/restart', {
    method: 'POST',
  });
}

export interface StorageStatusResponse {
  configured: boolean;
  missing?: string[];
  lastSync: string | null;
  message: string;
}

export async function getStorageStatus(): Promise<StorageStatusResponse> {
  return apiRequest<StorageStatusResponse>('/storage');
}

export interface SyncResponse {
  success: boolean;
  message?: string;
  lastSync?: string;
  error?: string;
  details?: string;
}

export async function triggerSync(): Promise<SyncResponse> {
  return apiRequest<SyncResponse>('/storage/sync', {
    method: 'POST',
  });
}

// ============================================================
// Snapshot API
// ============================================================

export interface SnapshotMetadata {
  id: string;
  timestamp: string;
  description: string;
  trigger: 'manual' | 'auto' | 'pre-evolution' | 'pre-sync' | 'pre-restart';
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

export interface SnapshotListResponse {
  success: boolean;
  snapshots: SnapshotMetadata[];
  count: number;
  error?: string;
}

export interface SnapshotCreateResponse {
  success: boolean;
  snapshot?: SnapshotMetadata;
  message?: string;
  error?: string;
  details?: string;
}

export interface SnapshotRestoreResponse {
  success: boolean;
  snapshot?: SnapshotMetadata;
  message?: string;
  requiresRestart?: boolean;
  error?: string;
  details?: string;
}

export interface SnapshotDeleteResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export interface SnapshotCompareResponse {
  success: boolean;
  snapshotId: string;
  compareToId: string;
  diff?: {
    configChanged: boolean;
    configDiff?: string;
    skillsAdded: string[];
    skillsRemoved: string[];
    skillsModified: string[];
  };
  error?: string;
}

export async function listSnapshots(): Promise<SnapshotListResponse> {
  return apiRequest<SnapshotListResponse>('/snapshots');
}

export async function createSnapshot(
  description?: string,
  trigger?: 'manual' | 'auto' | 'pre-evolution' | 'pre-sync' | 'pre-restart'
): Promise<SnapshotCreateResponse> {
  return apiRequest<SnapshotCreateResponse>('/snapshots', {
    method: 'POST',
    body: JSON.stringify({ description, trigger }),
  });
}

export async function getSnapshotDetails(
  snapshotId: string
): Promise<{ success: boolean; snapshot?: unknown; error?: string }> {
  return apiRequest(`/snapshots/${snapshotId}`);
}

export async function restoreSnapshot(
  snapshotId: string
): Promise<SnapshotRestoreResponse> {
  return apiRequest<SnapshotRestoreResponse>(`/snapshots/${snapshotId}/restore`, {
    method: 'POST',
  });
}

export async function deleteSnapshot(
  snapshotId: string
): Promise<SnapshotDeleteResponse> {
  return apiRequest<SnapshotDeleteResponse>(`/snapshots/${snapshotId}`, {
    method: 'DELETE',
  });
}

export async function compareSnapshot(
  snapshotId: string,
  compareToId?: string
): Promise<SnapshotCompareResponse> {
  const query = compareToId ? `?compareToId=${compareToId}` : '';
  return apiRequest<SnapshotCompareResponse>(`/snapshots/${snapshotId}/compare${query}`);
}

// ============================================================
// Settings Sync API
// ============================================================

export interface SettingItem {
  name: string;
  displayName: string;
  category: 'secrets' | 'channels' | 'agents' | 'gateway' | 'other';
  priority: 'critical' | 'important' | 'optional';
  configPath: string;
  configValue: string | null;
  envValue: string | null;
  envExists: boolean;
  isSensitive: boolean;
  status: 'synced' | 'unsynced' | 'env_only' | 'not_set' | 'conflict';
  conflict?: {
    configValue: string;
    envValue: string;
    recommendation: 'use_config' | 'use_env';
  };
}

export interface SettingsSyncStatus {
  success: boolean;
  summary: {
    synced: number;
    unsynced: number;
    envOnly: number;
    notSet: number;
  };
  categories: {
    secrets: SettingItem[];
    channels: SettingItem[];
    agents: SettingItem[];
    gateway: SettingItem[];
    other: SettingItem[];
  };
  error?: string;
}

export interface ExportCommandsResponse {
  success: boolean;
  commands: string[];
  items: Array<{ name: string; value: string }>;
  commandsText: string;
  error?: string;
}

export interface PendingEnvSync {
  name: string;
  displayName: string;
  setAt: string;
  priority: 'critical' | 'important' | 'optional';
  lastReminded?: string;
}

export interface PendingSyncResponse {
  success: boolean;
  pending: PendingEnvSync[];
  lastUpdated?: string;
  error?: string;
}

export async function getSettingsSyncStatus(): Promise<SettingsSyncStatus> {
  return apiRequest<SettingsSyncStatus>('/settings/sync-status');
}

export async function getExportCommands(
  category: 'all' | 'secrets' | 'channels' | 'agents' | 'gateway' | 'other' = 'all',
  onlyUnsynced: boolean = true
): Promise<ExportCommandsResponse> {
  return apiRequest<ExportCommandsResponse>(
    `/settings/export-commands?category=${category}&onlyUnsynced=${onlyUnsynced}`
  );
}

export async function getPendingSync(): Promise<PendingSyncResponse> {
  return apiRequest<PendingSyncResponse>('/settings/pending');
}

export async function removePendingSync(name: string): Promise<{ success: boolean; message?: string; error?: string }> {
  return apiRequest(`/settings/pending/${name}`, { method: 'DELETE' });
}
