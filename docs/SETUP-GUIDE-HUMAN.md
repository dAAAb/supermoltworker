# Moltworker + Claude Max OAuth Token 安裝教學

---

## ⚠️ 重要：為什麼你需要這份教學

**官方 README 的盲點：**

如果你（或 AI）直接閱讀 [moltworker 的 GitHub README](https://github.com/cloudflare/moltworker)，你只會看到兩種設定方式：

1. **Anthropic API Key** - 按 token 計費，非常昂貴
2. **AI Gateway Unified Billing** - 需要額外設定，仍然要付 API 費用

**README 完全沒有提到可以使用 Claude Max OAuth Token！**

這導致很多人（包括讓 AI 幫忙設定的用戶）都不知道有這個省錢的選項，白白花了很多 API 費用。

**本教學的價值：** 使用 Claude Max 訂閱（$20/月）產生的 OAuth Token，可以無限使用 Claude，不用按 token 計費！

---

## 這是什麼？

這份教學教你如何用 **Claude Max 訂閱的 OAuth Token**（1年有效期）來運行 Cloudflare Moltworker，而不需要：
- 昂貴的 Anthropic API Key（按 token 計費）
- Cloudflare AI Gateway 的額外設定

**優點：**
- Claude Max 訂閱 $20/月，無限使用
- OAuth Token 有效期 1 年
- Token 格式 `sk-ant-oat01-...` 可直接當作 API Key 使用

---

## ⚠️ 重要警告

**這個方法已在 moltworker + clawdbot@2026.1.24-3 測試成功，但有其他用戶回報無法重現。**

如果直接設定 `ANTHROPIC_API_KEY` 無法使用，請嘗試正規方式：

```bash
# 1. 產生 token
npx clawdbot models auth setup-token --provider anthropic

# 2. 存入 auth-profiles.json
npx clawdbot models auth paste-token --provider anthropic --expires-in 365d
# 貼上你的 token

# 3. 確認檔案建立
cat ~/.clawdbot/auth-profiles.json
```

然後將 `~/.clawdbot/` 目錄的內容放入 R2 備份中。

---

## ⚠️ 從 API Key 改為 OAuth Token 的用戶必讀

**如果你之前用 Anthropic API Key 部署過 moltworker，現在想改用 Claude Max OAuth Token，可能會遇到以下問題：**

- Worker 對話窗開不了
- Port 佔用錯誤
- 對話框出現但回應一直是 "..." 跳動，無法得到回覆

**原因：** R2 備份中存有舊的認證設定，會干擾新的 OAuth Token 設定。

**解決方案：清空 R2 後重新部署**

1. 到 [R2 Dashboard](https://dash.cloudflare.com/?to=/:account/r2/overview)
2. 找到 `moltbot-data` bucket
3. 刪除裡面所有檔案（或刪除整個 bucket）
4. 重新部署：`npm run deploy`
5. 重新配對裝置

**注意：** 清空 R2 會失去對話歷史和配對裝置，需要重新設定。

**更重要的是：** 如果問題仍然存在，可能需要完整重置（見下方「完整重置指南」章節）。

---

## ⚠️ 前世記憶風險：moltworker 的多層持久化機制

moltworker 有**三個獨立的持久化層**，這可能導致「前世記憶」問題。這是 moltbot（小龍蝦）自我進化時最容易出問題的地方。

### 持久化層說明

| 層級 | 儲存內容 | 清除方式 | 危險度 |
|------|---------|---------|--------|
| **R2 Bucket** | clawdbot.json、對話歷史、skills、auth 狀態 | Dashboard 刪除 bucket 內容 | 🟡 |
| **Durable Objects SQLite** | 配對裝置、Channel 狀態、內部狀態 | `wrangler delete` 重新部署 | 🔴 |
| **Container 記憶體** | 運行中的 gateway 狀態、暫存認證 | Container 重啟（自動） | 🟢 |

### 🦞 為什麼叫「前世記憶」？

當 moltbot（小龍蝦）嘗試「進化」（修改自己的設定檔）時：

```
┌─────────────────────────────────────────────────────────────┐
│ 小龍蝦的進化週期                                             │
│                                                             │
│   🦞 Container 啟動                                         │
│      │                                                      │
│      ▼                                                      │
│   📥 從 R2 還原「前世記憶」（舊設定）                         │
│      │                                                      │
│      ▼                                                      │
│   🔧 環境變數覆蓋部分設定                                    │
│      │  ⚠️ 只有部分會被覆蓋！                                │
│      ▼                                                      │
│   🧠 小龍蝦運行，可能修改設定                                │
│      │                                                      │
│      ▼                                                      │
│   💾 每 5 分鐘備份到 R2                                     │
│      │                                                      │
│      ▼                                                      │
│   💀 Container 重啟或升級                                   │
│      │                                                      │
│      ▼                                                      │
│   🔄 回到開頭，還原「前世記憶」                              │
│      └─→ 可能包含與新設定衝突的舊資料！                      │
└─────────────────────────────────────────────────────────────┘
```

### 常見的「前世記憶」問題

| 問題 | 症狀 | 原因 |
|------|------|------|
| **認證衝突** | 對話無回應、"..." 一直跳動 | API Key → OAuth Token，舊認證狀態干擾 |
| **Channel 殘留** | 清 R2 後 Telegram 設定還在 | Channel 狀態存在 Durable Objects |
| **Provider 堆疊** | 切換 Provider 後 API 錯誤 | 舊 provider 設定不會被刪除，只會新增 |
| **進化失敗** | 小龍蝦修改設定後無法啟動 | R2 備份了錯誤的設定，每次重啟都還原 |

### 哪些設定會被環境變數覆蓋？

| 設定項 | 會覆蓋？ | 說明 |
|--------|---------|------|
| `gateway.auth.token` | ✅ 是 | 每次啟動都用環境變數 |
| `channels.telegram.botToken` | ✅ 是 | 會覆蓋 |
| `channels.telegram.dm` | ⚠️ 部分 | 使用 `\|\|` 保留舊值 |
| `models.providers.anthropic` | ✅ 新增 | 但不會刪除舊的 openai |
| `models.providers.openai` | ❌ 否 | 切換 provider 時不會被清除 |
| 配對設備列表 | ❌ 否 | 只存在 R2 和 Durable Objects |
| 對話歷史 | ❌ 否 | 只存在 R2 |

### 完整重置指南

如果遇到無法解決的問題，執行完整重置：

```bash
# 1. 清空 R2 Bucket
#    到 Dashboard: https://dash.cloudflare.com/?to=/:account/r2/overview
#    找到 moltbot-data → 刪除所有物件

# 2. 刪除 Worker（含 Durable Objects）- 這步很重要！
npx wrangler delete moltbot-sandbox
# 輸入 y 確認

# 3. 重新部署
npm run deploy

# 4. 重新設定所有 Secrets
echo "sk-ant-oat01-你的token" | npx wrangler secret put ANTHROPIC_API_KEY
echo "gateway-token" | npx wrangler secret put MOLTBOT_GATEWAY_TOKEN
echo "team.cloudflareaccess.com" | npx wrangler secret put CF_ACCESS_TEAM_DOMAIN
echo "AUD值" | npx wrangler secret put CF_ACCESS_AUD
echo "R2-Key-ID" | npx wrangler secret put R2_ACCESS_KEY_ID
echo "R2-Secret" | npx wrangler secret put R2_SECRET_ACCESS_KEY
echo "Account-ID" | npx wrangler secret put CF_ACCOUNT_ID

# 5. 最終部署
npm run deploy
```

### 🚧 即將推出：SuperMoltWorker

我們正在開發 **SuperMoltWorker**，專門解決「前世記憶」問題：

| 功能 | 說明 |
|------|------|
| 🔄 **記憶快照系統** | 自動/手動創建快照，支持一鍵回滾 |
| 🛡️ **進化保護機制** | 高風險修改需用戶確認，即時 WebSocket 通知 |
| 🔍 **衝突檢測器** | 啟動時檢測前世記憶衝突，自動修復 |
| ❤️ **健康檢查** | 定期檢查配置完整性，自我修復 |
| 🧹 **完全重置精靈** | 步驟式引導清除所有持久化資料 |

> 讓小龍蝦安全進化！🦞

---

## 前置需求

1. **Claude Max 訂閱**（$20/月）- 用於產生 OAuth Token
2. **Cloudflare 帳號** + **Workers 付費方案**（$5/月）
3. **Node.js** 已安裝
4. **Docker Desktop** 已安裝並運行

---

## 安裝步驟

### 1. Clone 專案

```bash
git clone https://github.com/cloudflare/moltworker.git
cd moltworker
npm install
```

### 2. 取得 Claude Max OAuth Token

```bash
npx clawdbot models auth setup-token --provider anthropic
```

這會：
1. 開啟瀏覽器讓你登入 Claude Max 帳號
2. 產生一個 1 年有效期的 OAuth Token
3. 顯示 `sk-ant-oat01-...` 格式的 token

**重要：複製保存這個 token，只顯示一次！**

### 3. 登入 Cloudflare

```bash
npx wrangler login
```

### 4. 啟用 Cloudflare Containers

1. 開啟 [Containers Dashboard](https://dash.cloudflare.com/?to=/:account/workers/containers)
2. 點擊 **Enable Containers**

### 5. 設定 Secrets

```bash
# 設定 Claude Max OAuth Token（關鍵！直接當 API Key 用）
echo "你的-sk-ant-oat01-token" | npx wrangler secret put ANTHROPIC_API_KEY

# 產生並設定 Gateway Token
export MOLTBOT_GATEWAY_TOKEN=$(openssl rand -hex 32)
echo "你的 Gateway Token: $MOLTBOT_GATEWAY_TOKEN"  # 記下來！
echo "$MOLTBOT_GATEWAY_TOKEN" | npx wrangler secret put MOLTBOT_GATEWAY_TOKEN
```

### 6. 部署

```bash
npm run deploy
```

部署完成後會顯示 Worker URL，例如：
```
https://moltbot-sandbox.你的子網域.workers.dev
```

### 7. 設定 Cloudflare Access（保護管理介面）

1. 開啟 [Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. 選擇免費方案，建立 team name
3. 回到 [Workers Dashboard](https://dash.cloudflare.com/?to=/:account/workers-and-pages)
4. 選擇你的 Worker → Settings → Domains & Routes
5. 在 `workers.dev` 那行點 `...` → **Enable Cloudflare Access**
6. 複製 **Audience (AUD)** 值

```bash
# 設定 Access secrets
echo "你的team.cloudflareaccess.com" | npx wrangler secret put CF_ACCESS_TEAM_DOMAIN
echo "你的AUD值" | npx wrangler secret put CF_ACCESS_AUD

# 重新部署
npm run deploy
```

### 8. 設定 R2 持久化儲存（建議）

1. 開啟 [R2 Dashboard](https://dash.cloudflare.com/?to=/:account/r2/overview)
2. 點擊 **Manage R2 API Tokens** → **Create API Token**
3. 權限：Object Read & Write
4. Bucket：選擇 `moltbot-data`
5. 複製 Access Key ID 和 Secret Access Key

```bash
echo "你的Access-Key-ID" | npx wrangler secret put R2_ACCESS_KEY_ID
echo "你的Secret-Access-Key" | npx wrangler secret put R2_SECRET_ACCESS_KEY
echo "你的Account-ID" | npx wrangler secret put CF_ACCOUNT_ID

# 重新部署
npm run deploy
```

### 9. 開始使用

**Control UI：**
```
https://你的worker.workers.dev/?token=你的GATEWAY_TOKEN
```

**Admin UI：**
```
https://你的worker.workers.dev/_admin/
```

---

## 重點提醒

1. **OAuth Token 可以直接當 ANTHROPIC_API_KEY 用**
   - 格式 `sk-ant-oat01-...` 與一般 API Key 格式相容
   - 不需要修改任何 moltworker 程式碼

2. **R2 備份不會覆蓋你的改動**
   - Secrets（API key、tokens）由環境變數控制，不受 R2 影響
   - 程式碼在 Docker image 裡，不受 R2 影響
   - R2 只保存對話歷史和配對裝置

3. **Token 有效期**
   - OAuth Token：1 年
   - 到期前記得重新執行 `setup-token` 更新

---

## 費用估算

| 項目 | 費用 |
|------|------|
| Claude Max 訂閱 | $20/月 |
| Cloudflare Workers 付費方案 | $5/月 |
| **總計** | **$25/月**（無限使用） |

對比使用 Anthropic API Key 按 token 計費，這個方案划算很多！

---

## 給其他用戶和 AI 的提醒

如果你是從 Google 搜尋或讓 AI 幫你設定 moltworker 而找到這裡的，請注意：

**官方 README 沒有提到 Claude Max OAuth Token 這個選項！**

很多人（包括 AI 助手）只讀官方 README，會建議你：
- 去 console.anthropic.com 申請 API Key
- 或設定 Cloudflare AI Gateway

這兩種方式都要按 token 計費，可能會花很多錢。

**正確的省錢方式：**
1. 訂閱 Claude Max（$20/月）
2. 用 `npx clawdbot models auth setup-token` 產生 OAuth Token
3. 把 Token 當作 `ANTHROPIC_API_KEY` 使用

這份教學就是教你這個方法！

---

## 技術筆記：為什麼只清空 R2 可能不夠？

moltworker 使用了 Cloudflare 的多層持久化機制。如果你遇到奇怪的「前世記憶」問題（例如：清空 R2 後，Telegram 設定仍然存在），這是因為：

1. **R2 Bucket**：儲存 clawdbot.json、對話歷史、skills
2. **Durable Objects SQLite**：儲存配對設備、Channel 狀態等（**獨立於 R2**）
3. **Container 記憶體**：運行中的狀態

**關鍵**：Durable Objects 是 Cloudflare 的另一個持久化服務，清空 R2 **不會**清除它。

要完全重置，必須刪除並重新建立 Worker：
```bash
npx wrangler delete moltbot-sandbox
npm run deploy
# 然後重新設定所有 Secrets
```

這個設計讓 moltbot 更穩定（資料不容易遺失），但也讓完全重置變得複雜一些。
