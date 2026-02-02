# Claude OAuth Token 使用指南

## 🔥 重要澄清

**有一些 GitHub issues 聲稱 Anthropic 會阻擋 moltbot 使用 Claude OAuth Token。這是錯誤的資訊！**

### 事實真相

✅ **OAuth tokens 完全可以在 moltbot/SuperMoltWorker 中使用**
✅ **Anthropic API 完全支援 OAuth 認證**
✅ **OAuth tokens 是推薦的認證方式**（見下方成本比較）
✅ **本專案已測試並驗證 OAuth tokens 可正常運作**

---

## 為什麼選擇 OAuth Token？

### 成本比較

| 認證方式 | 每月成本 | 適合場景 |
|---------|---------|---------|
| **Claude Max OAuth Token** | **$20 固定費用** | **重度使用（強烈推薦）** |
| Anthropic API Key | 依使用量計費 | 輕度使用、測試 |
| AI Gateway + API Key | 依使用量 + $5 Workers | 需要請求記錄/快取 |

### 實際案例

假設每月使用：
- 100M input tokens
- 50M output tokens

**成本計算：**
- API Key 方式：$15 (input) + $37.5 (output) = **$52.5/月**
- **OAuth Token 方式：$20/月（無上限）** 💰 **省下 $32.5/月**

---

## 快速開始

### 步驟 1：產生 OAuth Token

```bash
# 需要 Claude Max 或 Claude Pro 訂閱
npx clawdbot models auth setup-token --provider anthropic
```

**執行過程：**
1. 會開啟瀏覽器，導向 Claude 登入頁面
2. 使用您的 Claude Max/Pro 帳號登入並授權
3. 成功後會顯示 OAuth token（格式：`sk-ant-oat01-...`）

**重要：Token 只顯示一次，請立即複製儲存！**

### 步驟 2：設定為環境變數

```bash
# 設定為 CLAUDE_CODE_OAUTH_TOKEN（最高優先級）
npx wrangler secret put CLAUDE_CODE_OAUTH_TOKEN
# 貼上您的 sk-ant-oat01-... token
```

**或者**（相容性方式）：

```bash
# 也可以設定為 ANTHROPIC_API_KEY
# OAuth token 格式與 API key 相容
npx wrangler secret put ANTHROPIC_API_KEY
# 貼上您的 sk-ant-oat01-... token
```

### 步驟 3：部署

```bash
npm run deploy
```

---

## 認證優先順序

SuperMoltWorker 使用以下優先順序（由高到低）：

1. **`CLAUDE_CODE_OAUTH_TOKEN`** ← 最高優先級，強烈推薦
2. `AI_GATEWAY_API_KEY`（當設定了 `AI_GATEWAY_BASE_URL` 時）
3. `ANTHROPIC_API_KEY`（回退選項）
4. `OPENAI_API_KEY`（替代 provider）

**範例：** 如果同時設定了 `CLAUDE_CODE_OAUTH_TOKEN` 和 `ANTHROPIC_API_KEY`，系統會優先使用 `CLAUDE_CODE_OAUTH_TOKEN`。

---

## 驗證設定

### 檢查已設定的 Secrets

```bash
npx wrangler secret list
```

應該會看到：
```json
[
  { "name": "CLAUDE_CODE_OAUTH_TOKEN", "type": "secret_text" },
  { "name": "MOLTBOT_GATEWAY_TOKEN", "type": "secret_text" },
  ...
]
```

### 檢查 Worker Logs

```bash
npx wrangler tail
```

啟動時應該會看到：
```
[AUTH] Using CLAUDE_CODE_OAUTH_TOKEN (highest priority, recommended)
```

---

## 常見問題

### Q1: OAuth Token 有效期限是多久？

**A:** 1 年。到期前記得重新產生新的 token。

### Q2: 可以同時設定多個認證方式嗎？

**A:** 可以，系統會依照優先順序自動選擇。建議只設定一個以避免混淆。

### Q3: 如何更新 OAuth Token？

```bash
# 1. 產生新 token
npx clawdbot models auth setup-token --provider anthropic

# 2. 更新 secret
npx wrangler secret put CLAUDE_CODE_OAUTH_TOKEN

# 3. 重新部署（可選，下次請求時會自動使用新 token）
npm run deploy
```

### Q4: 為什麼有人說 OAuth Token 不能用？

**A:** 這通常是因為：
1. **設定錯誤的環境變數名稱**（應該用 `CLAUDE_CODE_OAUTH_TOKEN` 或 `ANTHROPIC_API_KEY`）
2. **混用多種認證方式** 造成優先順序混淆
3. **R2 快取問題**（舊的認證狀態殘留）

**不是** 因為 Anthropic 阻擋 OAuth tokens。

### Q5: 如何清除舊的認證狀態？

如果遇到認證問題，可以清除 R2 快取：

```bash
# 方法 1：透過 Dashboard
# 到 R2 Dashboard → super-moltbot-data → 刪除所有檔案

# 方法 2：透過 CLI（需確認 bucket 名稱）
npx wrangler r2 object delete super-moltbot-data --recursive

# 重新部署
npm run deploy
```

**警告：** 這會刪除對話歷史和配對裝置，需要重新配對。

### Q6: 可以和 AI Gateway 一起使用嗎？

**A:** 可以！AI Gateway 只是代理層，不影響認證方式：

```bash
# 設定 OAuth Token
npx wrangler secret put CLAUDE_CODE_OAUTH_TOKEN

# 設定 AI Gateway（可選，用於監控/快取）
npx wrangler secret put AI_GATEWAY_BASE_URL
# 輸入：https://gateway.ai.cloudflare.com/v1/{account}/{ gateway}/anthropic

# 重新部署
npm run deploy
```

---

## 故障排除

### 問題：部署後無法連線

**檢查清單：**
1. ✅ 確認已設定 `CLAUDE_CODE_OAUTH_TOKEN` 或 `ANTHROPIC_API_KEY`
2. ✅ 確認已設定 `MOLTBOT_GATEWAY_TOKEN`
3. ✅ 確認已設定 Cloudflare Access（`CF_ACCESS_TEAM_DOMAIN` 和 `CF_ACCESS_AUD`）
4. ✅ 等待容器啟動（首次啟動需要 1-2 分鐘）

**檢查命令：**
```bash
npx wrangler secret list
npx wrangler tail
```

### 問題：顯示 "Authentication failed"

**可能原因：**
1. Token 已過期（超過 1 年）→ 重新產生 token
2. Token 格式錯誤 → 確認是 `sk-ant-oat01-...` 格式
3. 沒有 Claude Max/Pro 訂閱 → 需要有效訂閱

### 問題：從 API Key 切換到 OAuth Token 後出現問題

**解決方案：** 清除 R2 快取（見 Q5）

---

## 技術細節

### OAuth Token 格式

```
sk-ant-oat01-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
         ^^^
         oat = OAuth Token
```

與 API Key 格式相容：
```
sk-ant-api03-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
         ^^^
         api = API Key
```

### 程式碼實作

OAuth token 優先順序在以下檔案中實作：

- `src/types.ts` - 類型定義和註解
- `src/gateway/env.ts` - 環境變數處理邏輯
- `src/index.ts` - 驗證邏輯

核心邏輯（`src/gateway/env.ts`）：
```typescript
// 優先級 1: CLAUDE_CODE_OAUTH_TOKEN（最高優先級）
if (env.CLAUDE_CODE_OAUTH_TOKEN) {
  envVars.ANTHROPIC_API_KEY = env.CLAUDE_CODE_OAUTH_TOKEN;
  console.log('[AUTH] Using CLAUDE_CODE_OAUTH_TOKEN (highest priority, recommended)');
}

// 優先級 2: AI_GATEWAY_API_KEY
if (!envVars.ANTHROPIC_API_KEY && env.AI_GATEWAY_API_KEY) {
  // ...
}

// 優先級 3: ANTHROPIC_API_KEY（回退）
if (!envVars.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY) {
  // ...
}
```

---

## 相關資源

- [Moltbot 官方文檔](https://docs.molt.bot)
- [Cloudflare Workers 文檔](https://developers.cloudflare.com/workers/)
- [Claude Max 訂閱資訊](https://claude.ai/upgrade)
- [SuperMoltWorker 完整文檔](../README.md)

---

## 貢獻

如果您發現任何關於 OAuth token 的問題或有改進建議，請：

1. 開 GitHub Issue 並附上詳細資訊（logs、設定等）
2. **請勿散佈** "Anthropic 阻擋 OAuth tokens" 的錯誤資訊
3. 如果看到其他人提出這樣的問題，請引導他們到本文檔

---

> 💡 **記住：** OAuth tokens 是完全支援且推薦的認證方式！不要被錯誤資訊誤導。
