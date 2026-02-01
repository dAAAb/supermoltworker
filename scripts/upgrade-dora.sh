#!/bin/bash
# ============================================================
# 朵拉龍蝦沙拉升級腳本 - 升級到 SuperMoltWorker
# ============================================================
#
# 這個腳本會將 moltbot-sandbox (朵拉的龍蝦沙拉) 升級到 SuperMoltWorker
#
# 執行前請確認：
# 1. 你在 moltworker 專案目錄
# 2. 已經用 wrangler 登入 Cloudflare
# 3. 已經備份 clawdbot.json (步驟 1 會幫你做)
#

set -e  # 遇到錯誤就停止

# 顏色定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo ""
echo -e "${BLUE}============================================================${NC}"
echo -e "${BLUE}   朵拉龍蝦沙拉升級到 SuperMoltWorker${NC}"
echo -e "${BLUE}============================================================${NC}"
echo ""

# ============================================================
# Phase 1: 備份
# ============================================================
echo -e "${YELLOW}Phase 1: 備份現有資料${NC}"
echo "----------------------------------------"

BACKUP_DIR="./backups/dora-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

echo "1.1 下載 clawdbot.json..."
npx wrangler r2 object get moltbot-data/clawdbot/clawdbot.json \
  --file "$BACKUP_DIR/clawdbot.json" \
  --remote

echo -e "${GREEN}✓ 備份已儲存到: $BACKUP_DIR/clawdbot.json${NC}"
echo ""

# ============================================================
# Phase 1.5: 檢查必要的 Secrets
# ============================================================
echo -e "${YELLOW}Phase 1.5: 檢查必要的 Secrets${NC}"
echo "----------------------------------------"

WORKER_NAME="moltbot-sandbox"
REQUIRED_SECRETS=("ANTHROPIC_API_KEY" "MOLTBOT_GATEWAY_TOKEN" "CF_ACCESS_AUD" "CF_ACCESS_TEAM_DOMAIN" "CF_ACCOUNT_ID" "R2_ACCESS_KEY_ID" "R2_SECRET_ACCESS_KEY")
OPTIONAL_SECRETS=("TELEGRAM_BOT_TOKEN" "BRAVE_SEARCH_API_KEY" "DISCORD_BOT_TOKEN" "SLACK_BOT_TOKEN")

echo "檢查 $WORKER_NAME 的 Secrets..."
EXISTING_SECRETS=$(npx wrangler secret list --name "$WORKER_NAME" 2>/dev/null | grep '"name"' | sed 's/.*"name": "\([^"]*\)".*/\1/')

MISSING_REQUIRED=()
MISSING_OPTIONAL=()

for secret in "${REQUIRED_SECRETS[@]}"; do
  if echo "$EXISTING_SECRETS" | grep -q "^${secret}$"; then
    echo -e "  ${GREEN}✓${NC} $secret"
  else
    echo -e "  ${RED}✗${NC} $secret (必要)"
    MISSING_REQUIRED+=("$secret")
  fi
done

for secret in "${OPTIONAL_SECRETS[@]}"; do
  if echo "$EXISTING_SECRETS" | grep -q "^${secret}$"; then
    echo -e "  ${GREEN}✓${NC} $secret"
  else
    echo -e "  ${YELLOW}○${NC} $secret (可選)"
    MISSING_OPTIONAL+=("$secret")
  fi
done

echo ""

if [ ${#MISSING_REQUIRED[@]} -gt 0 ]; then
  echo -e "${RED}⚠️  缺少必要的 Secrets: ${MISSING_REQUIRED[*]}${NC}"
  echo "請先設定這些 Secrets 再繼續升級："
  for secret in "${MISSING_REQUIRED[@]}"; do
    echo "  npx wrangler secret put $secret --name $WORKER_NAME"
  done
  echo ""
  read -p "是否繼續升級？(y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "升級已取消"
    exit 1
  fi
fi

if [ ${#MISSING_OPTIONAL[@]} -gt 0 ]; then
  echo -e "${YELLOW}提示: 以下可選 Secrets 未設定: ${MISSING_OPTIONAL[*]}${NC}"
  echo "如果需要相關功能（如 Telegram），請在升級後設定。"
  echo ""
fi

# ============================================================
# Phase 2: 建置
# ============================================================
echo -e "${YELLOW}Phase 2: 建置 SuperMoltWorker${NC}"
echo "----------------------------------------"

echo "2.1 執行 npm run build..."
npm run build

echo -e "${GREEN}✓ 建置完成${NC}"
echo ""

# ============================================================
# Phase 3: 部署
# ============================================================
echo -e "${YELLOW}Phase 3: 部署到 moltbot-sandbox${NC}"
echo "----------------------------------------"

echo "3.1 部署中 (使用 wrangler.dora.jsonc)..."
npx wrangler deploy --config wrangler.dora.jsonc

echo -e "${GREEN}✓ 部署完成${NC}"
echo ""

# ============================================================
# Phase 4: 驗證
# ============================================================
echo -e "${YELLOW}Phase 4: 驗證${NC}"
echo "----------------------------------------"

WORKER_URL="https://moltbot-sandbox.dab.workers.dev"

echo "4.1 等待 Container 啟動 (30 秒)..."
sleep 30

echo "4.2 檢查 Worker 是否回應..."
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$WORKER_URL/_admin" 2>/dev/null || echo "000")

if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "302" ]; then
  echo -e "${GREEN}✓ Worker 回應正常 (HTTP $HTTP_STATUS)${NC}"
else
  echo -e "${RED}⚠ Worker 回應異常 (HTTP $HTTP_STATUS)${NC}"
  echo "  請手動檢查: $WORKER_URL/_admin"
fi

echo ""
echo -e "${BLUE}============================================================${NC}"
echo -e "${GREEN}升級完成！${NC}"
echo -e "${BLUE}============================================================${NC}"
echo ""
echo "請驗證以下項目："
echo "  1. 開啟 Admin UI: $WORKER_URL/_admin"
echo "  2. 檢查 Health Dashboard 是否顯示 healthy"
echo "  3. 檢查 Settings Sync 頁面是否正常"
echo "  4. 用 Telegram 發訊息測試龍蝦沙拉是否正常回應"
echo ""
echo "備份位置: $BACKUP_DIR"
echo ""
echo -e "${YELLOW}如果出問題，可以回滾：${NC}"
echo "  npx wrangler r2 object put moltbot-data/clawdbot/clawdbot.json \\"
echo "    --file $BACKUP_DIR/clawdbot.json --remote"
echo ""
