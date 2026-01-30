# SuperMoltWorker 開發與部署筆記

> **讓小龍蝦安全進化** - 解決 moltworker 的「前世記憶」問題

## 專案概述

**SuperMoltWorker** 是 [cloudflare/moltworker](https://github.com/cloudflare/moltworker) 的 fork，新增了進化保護機制，讓 moltbot（小龍蝦）能夠安全地自我進化，不會因為持久化機制的衝突而「進化失敗死亡」。

### 新增功能

| 功能 | 說明 |
|------|------|
| 🔄 **Memory Snapshots** | 快照系統，可儲存和還原 moltbot 配置 |
| 🛡️ **Evolution Protection** | 高風險修改需用戶確認，即時通知 |
| 🔍 **Health Dashboard** | 健康檢查儀表板，衝突檢測 |
| ❤️ **Auto-Repair** | 自動修復常見問題 |
| 🧹 **Reset Wizard** | 完全重置精靈 |

### GitHub Repository

- **Fork**: https://github.com/dAAAb/supermoltworker
- **Upstream**: https://github.com/cloudflare/moltworker

---

## 部署指南：在同一個 Cloudflare 帳號部署多個 Worker

以下說明如何在已有 `moltbot-sandbox` 的情況下，部署獨立的 `super-moltbot-sandbox`。

### 前置條件

- 已有運作中的 `moltbot-sandbox`
- Cloudflare 帳號已設定好 Zero Trust (Cloudflare Access)
- 已安裝 Node.js 和 npm

### Step 1: Clone 並設定專案

```bash
# Clone SuperMoltWorker
git clone https://github.com/dAAAb/supermoltworker.git
cd supermoltworker

# 安裝依賴
npm install
```

### Step 2: 修改 Worker 名稱（重要！）

編輯 `wrangler.jsonc`，將 `name` 改為不同於現有 worker 的名稱：

```jsonc
{
  "name": "super-moltbot-sandbox",  // 原本是 "moltbot-sandbox"
  // ...其他設定
}
```

### Step 3: 建立獨立的 R2 Bucket

**為什麼需要獨立 bucket？** 如果兩個 worker 共用同一個 R2 bucket，它們的資料（對話、配對設備、配置）會互相覆蓋。

```bash
# 在 Cloudflare Dashboard 建立新的 R2 bucket
# 名稱：super-moltbot-data（或你喜歡的名稱）
```

更新 `wrangler.jsonc`：

```jsonc
{
  "r2_buckets": [
    {
      "binding": "MOLTBOT_BUCKET",
      "bucket_name": "super-moltbot-data",  // 改為新 bucket 名稱
    },
  ],
}
```

**同時更新** `src/config.ts`：

```typescript
/** R2 bucket name for persistent storage */
export const R2_BUCKET_NAME = 'super-moltbot-data';  // 改為新 bucket 名稱
```

### Step 4: 建立 R2 API Token

1. 前往 Cloudflare Dashboard → R2 → Manage R2 API Tokens
2. 建立新 token，權限選「Read & Write」
3. **重要**：Bucket 範圍只選 `super-moltbot-data`（不要選全部）
4. 記下 Access Key ID 和 Secret Access Key

### Step 5: 部署 Worker

```bash
# 建置
npm run build

# 部署
npx wrangler deploy
```

### Step 6: 設定 Secrets

以下 secrets 需要個別設定：

```bash
# Claude Max OAuth Token（或 Anthropic API Key）
echo "sk-ant-oat01-your-token" | npx wrangler secret put ANTHROPIC_API_KEY --name super-moltbot-sandbox

# Gateway Token（建議產生新的，與原本 worker 區隔）
echo "$(openssl rand -hex 32)" | npx wrangler secret put MOLTBOT_GATEWAY_TOKEN --name super-moltbot-sandbox

# Cloudflare Account ID（可共用）
echo "your-account-id" | npx wrangler secret put CF_ACCOUNT_ID --name super-moltbot-sandbox

# Cloudflare Access（可共用，見下方說明）
echo "your-team.cloudflareaccess.com" | npx wrangler secret put CF_ACCESS_TEAM_DOMAIN --name super-moltbot-sandbox
echo "your-aud-value" | npx wrangler secret put CF_ACCESS_AUD --name super-moltbot-sandbox

# R2 Credentials（使用 Step 4 建立的新 token）
echo "your-r2-access-key-id" | npx wrangler secret put R2_ACCESS_KEY_ID --name super-moltbot-sandbox
echo "your-r2-secret-access-key" | npx wrangler secret put R2_SECRET_ACCESS_KEY --name super-moltbot-sandbox
```

### Step 7: 設定 Cloudflare Access

你有兩個選擇：

#### 選項 A：共用現有 Access Application（簡單）

1. 前往 Zero Trust → Access → Applications
2. 編輯現有的 moltbot-sandbox 應用
3. 點擊 "+ Add public hostname"
4. 新增：`super-moltbot-sandbox.your-subdomain.workers.dev`
5. 儲存

**優點**：設定簡單
**缺點**：兩個 worker 共用相同的存取控制

#### 選項 B：建立獨立 Access Application（推薦）

1. 前往 Zero Trust → Access → Applications
2. 點擊 "+ Add an application"
3. 選擇 "Self-hosted"
4. 設定：
   - Application name: `super-moltbot-sandbox`
   - Application domain: `super-moltbot-sandbox.your-subdomain.workers.dev`
5. 設定 Policy（允許的使用者）
6. 複製新的 AUD 值，更新 `CF_ACCESS_AUD` secret

---

## Secrets 共用規則

| Secret | 可否共用 | 說明 |
|--------|---------|------|
| `ANTHROPIC_API_KEY` | ✅ 可共用 | 同一個 API key 可給多個 worker 使用 |
| `MOLTBOT_GATEWAY_TOKEN` | ❌ 建議獨立 | 用於 Control UI 存取，獨立比較安全 |
| `CF_ACCOUNT_ID` | ✅ 可共用 | 帳號層級，所有 worker 相同 |
| `CF_ACCESS_TEAM_DOMAIN` | ✅ 可共用 | 帳號層級，所有 worker 相同 |
| `CF_ACCESS_AUD` | ⚠️ 視需求 | 共用 = 相同存取控制；獨立 = 分開管理 |
| `R2_ACCESS_KEY_ID` | ❌ 建議獨立 | 使用只有新 bucket 權限的 token |
| `R2_SECRET_ACCESS_KEY` | ❌ 建議獨立 | 同上 |

---

## 重要資訊（請保存）

部署完成後，記錄以下資訊：

```
────────────────────────────────────────
項目: Control UI
值: https://super-moltbot-sandbox.your-subdomain.workers.dev/?token=YOUR_GATEWAY_TOKEN

────────────────────────────────────────
項目: Admin UI
值: https://super-moltbot-sandbox.your-subdomain.workers.dev/_admin/

────────────────────────────────────────
項目: Gateway Token
值: YOUR_GATEWAY_TOKEN

────────────────────────────────────────
項目: Claude OAuth Token
值: sk-ant-oat01-xxx...

────────────────────────────────────────
項目: R2 API Token
Access Key ID: xxx
Secret Access Key: xxx
Bucket: super-moltbot-data

────────────────────────────────────────
項目: GitHub Repository
值: https://github.com/your-username/supermoltworker
────────────────────────────────────────
```

---

## 已知問題

### R2 Mount 失敗

**症狀**：Health Dashboard 顯示 "R2 credentials configured but mount failed"

**可能原因**：
1. `sandbox.mountBucket` API 可能需要容器完全重建
2. Durable Object 快取了失敗狀態
3. R2 bucket 剛建立，可能需要時間傳播

**影響**：
- Memory Snapshots 功能可能無法使用
- 跨容器重啟的資料持久化受影響
- 核心功能（Evolution Protection、Health Dashboard）不受影響

**解決方案**：
- 嘗試 Restart Gateway
- 等待一段時間後重試
- 確認 R2 API token 有正確的 bucket 權限

### Skills Directory 不存在

**症狀**：Health Dashboard 顯示 "Skills directory does not exist"

**解決方案**：點擊 "Auto-Repair Issues" 按鈕自動建立

---

## 與 Upstream 同步

```bash
# 新增 upstream remote（如果還沒有）
git remote add upstream https://github.com/cloudflare/moltworker.git

# 取得 upstream 更新
git fetch upstream

# 合併更新（可能需要解決衝突）
git merge upstream/main

# 推送到你的 fork
git push origin main
```

---

## 檔案結構（SuperMoltWorker 新增部分）

```
src/
├── gateway/
│   ├── snapshot.ts          # 快照系統核心
│   ├── evolution.ts         # 進化保護核心
│   ├── risk-analyzer.ts     # 風險分析器
│   ├── conflict-detector.ts # 衝突檢測器
│   ├── health-check.ts      # 健康檢查
│   └── notification.ts      # 通知系統
├── routes/
│   ├── snapshot-api.ts      # 快照 API
│   ├── evolution-api.ts     # 進化 API
│   ├── health-api.ts        # 健康 API
│   └── notification-api.ts  # 通知 API
└── client/
    └── components/
        ├── MemoryPanel.tsx       # 記憶管理面板
        ├── EvolutionPanel.tsx    # 進化控制面板
        ├── HealthDashboard.tsx   # 健康儀表板
        └── ResetWizard.tsx       # 重置精靈
```

---

## 附錄：完整 Secrets 設定指令

```bash
# 設定所有 secrets（替換 YOUR_* 為實際值）
WORKER_NAME="super-moltbot-sandbox"

echo "YOUR_ANTHROPIC_API_KEY" | npx wrangler secret put ANTHROPIC_API_KEY --name $WORKER_NAME
echo "YOUR_GATEWAY_TOKEN" | npx wrangler secret put MOLTBOT_GATEWAY_TOKEN --name $WORKER_NAME
echo "YOUR_CF_ACCOUNT_ID" | npx wrangler secret put CF_ACCOUNT_ID --name $WORKER_NAME
echo "YOUR_CF_ACCESS_TEAM_DOMAIN" | npx wrangler secret put CF_ACCESS_TEAM_DOMAIN --name $WORKER_NAME
echo "YOUR_CF_ACCESS_AUD" | npx wrangler secret put CF_ACCESS_AUD --name $WORKER_NAME
echo "YOUR_R2_ACCESS_KEY_ID" | npx wrangler secret put R2_ACCESS_KEY_ID --name $WORKER_NAME
echo "YOUR_R2_SECRET_ACCESS_KEY" | npx wrangler secret put R2_SECRET_ACCESS_KEY --name $WORKER_NAME

# 驗證設定
npx wrangler secret list --name $WORKER_NAME
```

---

## 更新日誌

- **2026-01-31**: 初始版本，完成 SuperMoltWorker 開發與部署
  - 新增 Memory Snapshots、Evolution Protection、Health Dashboard
  - 成功部署 super-moltbot-sandbox 與 moltbot-sandbox 並存
  - 已知問題：R2 mount 可能失敗，待後續調查

---

*本文件由 Claude Code 協助撰寫*
