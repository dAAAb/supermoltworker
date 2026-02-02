#!/bin/bash
# 自動同步 CLAUDE_CODE_OAUTH_TOKEN 到 ANTHROPIC_API_KEY
#
# 使用方式：
#   ./scripts/sync-oauth-token.sh <your-oauth-token>
# 或者從 stdin 讀取：
#   echo "sk-ant-oat01-..." | ./scripts/sync-oauth-token.sh

set -e

TOKEN="${1:-}"

# 如果沒有提供參數，從 stdin 讀取
if [ -z "$TOKEN" ]; then
  if [ -t 0 ]; then
    # 互動模式：提示用戶輸入
    echo "請輸入您的 CLAUDE_CODE_OAUTH_TOKEN (sk-ant-oat01-...):"
    read -r TOKEN
  else
    # 非互動模式：從 stdin 讀取
    read -r TOKEN
  fi
fi

# 驗證 token 格式
if [ -z "$TOKEN" ]; then
  echo "❌ 錯誤：未提供 token"
  exit 1
fi

if [[ ! "$TOKEN" =~ ^sk-ant- ]]; then
  echo "⚠️  警告：Token 格式可能不正確（應該以 sk-ant- 開頭）"
  echo "是否繼續？(y/N)"
  read -r confirm
  if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "已取消"
    exit 0
  fi
fi

echo "🔄 正在設定 CLAUDE_CODE_OAUTH_TOKEN..."
echo "$TOKEN" | npx wrangler secret put CLAUDE_CODE_OAUTH_TOKEN

echo "🔄 正在同步到 ANTHROPIC_API_KEY..."
echo "$TOKEN" | npx wrangler secret put ANTHROPIC_API_KEY

echo "✅ 完成！兩個 secret 已成功設定："
echo "   - CLAUDE_CODE_OAUTH_TOKEN"
echo "   - ANTHROPIC_API_KEY (相同值)"
