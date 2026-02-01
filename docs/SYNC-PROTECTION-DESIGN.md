# SuperMoltWorker 同步保護機制設計

## 問題背景

2026-02-01 發生的災難：
1. 容器啟動時沒有 R2 憑證
2. 無法從 R2 讀取配置
3. 用預設/空配置啟動 Gateway
4. Cron job 把空配置同步回 R2
5. 好配置被覆蓋，資料永久丟失

## 解決方案架構

```
┌─────────────────────────────────────────────────────────────────┐
│                    SuperMoltWorker 同步保護                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Layer 1: 完整快照系統                                          │
│  ├─ 備份整個 /root/.clawdbot/ 目錄                              │
│  ├─ 包含: config, conversations, devices, skills, databases    │
│  └─ 自動保留「最後已知良好配置」(Last Known Good)                │
│                                                                 │
│  Layer 2: 同步前驗證                                            │
│  ├─ 比較本地 vs R2 配置                                         │
│  ├─ 計算「完整度分數」                                          │
│  ├─ 檢測「明顯變空」的情況                                      │
│  └─ 危險操作需要用戶確認                                        │
│                                                                 │
│  Layer 3: 衝突檢測與警告                                        │
│  ├─ 啟動時檢測配置衝突                                          │
│  ├─ Admin UI 顯示警告橫幅                                       │
│  ├─ WebSocket 即時通知                                          │
│  └─ 記錄衝突歷史供診斷                                          │
│                                                                 │
│  Layer 4: 用戶確認機制                                          │
│  ├─ 高風險操作前彈出確認對話框                                  │
│  ├─ 提供「查看差異」選項                                        │
│  ├─ 支持「取消」和「強制執行」                                  │
│  └─ 記錄用戶決策供審計                                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Layer 1: 完整快照系統

### 需要備份的資料

```typescript
interface CompleteBackup {
  // 配置檔案
  config: {
    'clawdbot.json': string;          // 主配置
  };

  // 技能
  skills: {
    files: string[];                   // 技能檔案列表
    content: Record<string, string>;   // 技能內容
  };

  // 對話記憶
  conversations: {
    files: string[];                   // 對話檔案列表
    // 內容可選備份（可能很大）
  };

  // 設備配對
  devices: {
    paired: DeviceInfo[];              // 已配對設備
    pending: DeviceInfo[];             // 待配對設備
  };

  // 資料庫
  databases: {
    files: string[];                   // .db 檔案列表
  };

  // 元數據
  metadata: {
    timestamp: string;
    trigger: string;
    completenessScore: number;         // 完整度分數
    fileCount: number;
    totalSize: number;
  };
}
```

### 備份路徑

```bash
# 需要備份的完整路徑
/root/.clawdbot/
├── clawdbot.json           # 主配置 ✓
├── conversations/          # 對話歷史 ✓ (新增)
├── devices/                # 設備資料 ✓ (新增)
├── *.db                    # 資料庫檔案 ✓ (新增)
└── .last-sync              # 同步時間戳

/root/clawd/
└── skills/                 # 技能檔案 ✓
```

## Layer 2: 同步前驗證

### 完整度分數計算

```typescript
interface CompletenessScore {
  score: number;           // 0-100
  breakdown: {
    hasConfig: number;     // 0-20: clawdbot.json 存在且有效
    hasChannels: number;   // 0-20: channels 不為空
    hasApiKeys: number;    // 0-20: 有 API keys 配置
    hasDevices: number;    // 0-20: 有設備配對資料
    hasConversations: number; // 0-20: 有對話記錄
  };
  warnings: string[];
}

function calculateCompleteness(config: any, stats: FileStats): CompletenessScore {
  let score = 0;
  const warnings: string[] = [];

  // 檢查 clawdbot.json
  if (config && Object.keys(config).length > 0) {
    score += 20;
  } else {
    warnings.push('配置檔案為空或不存在');
  }

  // 檢查 channels
  if (config?.channels && Object.keys(config.channels).length > 0) {
    score += 20;
  } else {
    warnings.push('沒有設定任何 channel');
  }

  // 檢查 API keys
  const hasApiKeys = !!(
    config?.models?.providers?.anthropic?.apiKey ||
    config?.models?.providers?.openai?.apiKey ||
    config?.tools?.web?.search?.apiKey
  );
  if (hasApiKeys) {
    score += 20;
  } else {
    warnings.push('沒有設定任何 API key');
  }

  // 檢查設備資料
  if (stats.devicesCount > 0) {
    score += 20;
  } else {
    warnings.push('沒有配對的設備');
  }

  // 檢查對話記錄
  if (stats.conversationsCount > 0) {
    score += 20;
  } else {
    warnings.push('沒有對話記錄');
  }

  return { score, breakdown: {...}, warnings };
}
```

### 同步決策邏輯

```typescript
interface SyncDecision {
  action: 'allow' | 'warn' | 'block';
  reason: string;
  requiresConfirmation: boolean;
  diff: ConfigDiff;
}

function decideSyncAction(local: CompletenessScore, remote: CompletenessScore): SyncDecision {
  const scoreDiff = local.score - remote.score;

  // 本地比遠端完整度低 20 分以上 → 阻止
  if (scoreDiff < -20) {
    return {
      action: 'block',
      reason: `本地配置完整度 (${local.score}) 遠低於雲端 (${remote.score})`,
      requiresConfirmation: true,
      diff: calculateDiff(local, remote),
    };
  }

  // 本地比遠端完整度低 → 警告
  if (scoreDiff < 0) {
    return {
      action: 'warn',
      reason: `本地配置完整度 (${local.score}) 低於雲端 (${remote.score})`,
      requiresConfirmation: true,
      diff: calculateDiff(local, remote),
    };
  }

  // 本地 channels 為空但遠端有 → 阻止
  if (local.breakdown.hasChannels === 0 && remote.breakdown.hasChannels > 0) {
    return {
      action: 'block',
      reason: '本地沒有 channel 設定，但雲端有',
      requiresConfirmation: true,
      diff: calculateDiff(local, remote),
    };
  }

  // 正常情況
  return {
    action: 'allow',
    reason: '配置完整度正常',
    requiresConfirmation: false,
    diff: calculateDiff(local, remote),
  };
}
```

## Layer 3: 衝突檢測與警告

### 衝突類型

```typescript
type ConflictType =
  | 'empty_overwrites_full'      // 空配置即將覆蓋完整配置
  | 'config_regression'          // 配置退化（完整度下降）
  | 'channel_lost'               // Channel 設定丟失
  | 'device_lost'                // 設備配對丟失
  | 'conversation_lost'          // 對話記錄丟失
  | 'api_key_lost';              // API Key 丟失

interface ConflictAlert {
  id: string;
  type: ConflictType;
  severity: 'warning' | 'critical';
  timestamp: string;
  description: string;
  localState: CompletenessScore;
  remoteState: CompletenessScore;
  suggestedAction: string;
  resolved: boolean;
  resolvedAt?: string;
  resolvedBy?: 'user' | 'auto';
}
```

### Admin UI 警告顯示

```
┌─────────────────────────────────────────────────────────────────┐
│ ⚠️ 同步衝突警告                                     [查看詳情]  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ 系統檢測到潛在的配置衝突：                                      │
│                                                                 │
│ 🔴 嚴重：空配置即將覆蓋雲端備份                                 │
│    - 本地完整度: 20/100                                         │
│    - 雲端完整度: 80/100                                         │
│    - 將丟失: Telegram channel, Brave API Key                    │
│                                                                 │
│ 建議操作：                                                      │
│ 1. 從雲端恢復配置                                               │
│ 2. 或確認這是預期的重置操作                                     │
│                                                                 │
│ [從雲端恢復] [查看差異] [我知道了，繼續同步] [創建快照後同步]   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Layer 4: 用戶確認機制

### 確認對話框 (WebSocket 通知)

當 moltbot 或 cron job 嘗試執行危險同步時：

```typescript
interface SyncConfirmationRequest {
  id: string;
  type: 'sync_confirmation';
  severity: 'warning' | 'critical';
  title: string;
  message: string;
  diff: {
    willLose: string[];      // 將丟失的項目
    willKeep: string[];      // 將保留的項目
    willAdd: string[];       // 將新增的項目
  };
  options: [
    { label: '取消同步', action: 'cancel' },
    { label: '查看詳細差異', action: 'view_diff' },
    { label: '先創建快照再同步', action: 'snapshot_then_sync' },
    { label: '我確定要同步', action: 'force_sync', requiresDoubleConfirm: true },
  ];
  expiresAt: string;         // 超時後自動取消
}
```

### 自動保護機制

```typescript
// 當危險同步被檢測到但無法即時通知用戶時
async function handleDangerousSyncWithoutUser(
  decision: SyncDecision
): Promise<void> {
  // 1. 自動創建快照（救命符）
  await createSnapshot({
    trigger: 'auto-protection',
    description: `Auto snapshot before dangerous sync (score: ${decision.localScore} → ${decision.remoteScore})`,
  });

  // 2. 記錄衝突警告
  await recordConflictAlert({
    type: 'empty_overwrites_full',
    severity: 'critical',
    suggestedAction: 'Review and restore from snapshot if needed',
  });

  // 3. 阻止同步（不覆蓋 R2）
  console.log('[SYNC BLOCKED] Dangerous sync prevented. Snapshot created for recovery.');

  // 4. 等待用戶確認（下次訪問 Admin UI 時顯示）
}
```

## 實作計劃

### Phase 1: 擴展快照系統
- [ ] 修改 `snapshot.ts` 備份整個 `/root/.clawdbot/`
- [ ] 新增對話、設備、資料庫備份
- [ ] 實作「最後已知良好配置」自動保存

### Phase 2: 同步驗證機制
- [ ] 新增 `src/gateway/sync-validator.ts`
- [ ] 實作完整度分數計算
- [ ] 實作同步決策邏輯
- [ ] 修改 `syncToR2()` 加入驗證

### Phase 3: 衝突檢測與警告
- [ ] 新增 `src/gateway/conflict-detector.ts`
- [ ] Admin UI 新增警告橫幅組件
- [ ] 實作衝突歷史記錄

### Phase 4: 用戶確認機制
- [ ] 擴展 WebSocket 通知系統
- [ ] 新增確認對話框 API
- [ ] 前端實作確認 UI

## API 設計

### 新增 API 端點

```
GET  /api/admin/sync/status         - 獲取同步狀態和衝突警告
POST /api/admin/sync/validate       - 驗證即將進行的同步
POST /api/admin/sync/confirm        - 確認危險同步
POST /api/admin/sync/cancel         - 取消待確認的同步
GET  /api/admin/conflicts           - 獲取衝突歷史
POST /api/admin/conflicts/:id/resolve - 解決衝突
```

## 配置選項

```typescript
interface SyncProtectionConfig {
  // 啟用同步保護
  enabled: boolean;

  // 完整度分數閾值
  minScoreToSync: number;          // 預設: 40
  warningScoreDiff: number;        // 預設: 10
  blockingScoreDiff: number;       // 預設: 20

  // 自動保護
  autoSnapshotOnDanger: boolean;   // 預設: true
  autoBlockEmptySync: boolean;     // 預設: true

  // 通知設定
  notifyOnWarning: boolean;        // 預設: true
  notifyOnBlock: boolean;          // 預設: true

  // 超時設定
  confirmationTimeoutMs: number;   // 預設: 300000 (5 分鐘)
}
```
