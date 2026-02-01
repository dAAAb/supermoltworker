/**
 * Environment Variable Sync Reminder System
 *
 * Sends periodic reminders via Telegram when critical settings
 * haven't been synced to environment variables.
 */

import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { mountR2Storage } from './r2';
import { waitForProcess } from './utils';
import {
  getPendingItemsForReminder,
  markAsReminded,
  type PendingEnvSync,
} from './settings-sync';

/**
 * Admin info stored for reminders
 */
interface AdminInfo {
  telegramUserId?: string;
  telegramChatId?: string;
  lastInteraction?: string;
}

const ADMIN_INFO_PATH = '/root/.clawdbot/admin-info.json';

/**
 * Load admin info from container
 */
async function loadAdminInfo(sandbox: Sandbox): Promise<AdminInfo | null> {
  try {
    const proc = await sandbox.startProcess(`cat ${ADMIN_INFO_PATH} 2>/dev/null`);
    await waitForProcess(proc, 5000);
    const logs = await proc.getLogs();
    if (logs.stdout?.trim()) {
      return JSON.parse(logs.stdout.trim());
    }
  } catch {
    // No admin info yet
  }
  return null;
}

/**
 * Save admin info to container
 */
export async function saveAdminInfo(
  sandbox: Sandbox,
  info: AdminInfo
): Promise<boolean> {
  try {
    const content = JSON.stringify(info, null, 2).replace(/'/g, "'\\''");
    const proc = await sandbox.startProcess(`echo '${content}' > ${ADMIN_INFO_PATH}`);
    await waitForProcess(proc, 5000);
    return true;
  } catch (err) {
    console.error('[EnvSyncReminder] Failed to save admin info:', err);
    return false;
  }
}

/**
 * Get Telegram bot token from config
 */
async function getTelegramBotToken(sandbox: Sandbox): Promise<string | null> {
  try {
    const proc = await sandbox.startProcess(
      `cat /root/.clawdbot/clawdbot.json 2>/dev/null | node -e "
        const chunks = [];
        process.stdin.on('data', c => chunks.push(c));
        process.stdin.on('end', () => {
          try {
            const config = JSON.parse(Buffer.concat(chunks).toString());
            console.log(config.channels?.telegram?.botToken || '');
          } catch { console.log(''); }
        });
      "`
    );
    await waitForProcess(proc, 5000);
    const logs = await proc.getLogs();
    const token = logs.stdout?.trim();
    return token && token.length > 10 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Send a Telegram message using the bot API
 */
async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
  parseMode: 'HTML' | 'Markdown' = 'HTML'
): Promise<boolean> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('[EnvSyncReminder] Telegram API error:', error);
      return false;
    }

    return true;
  } catch (err) {
    console.error('[EnvSyncReminder] Failed to send Telegram message:', err);
    return false;
  }
}

/**
 * Format reminder message
 */
function formatReminderMessage(items: PendingEnvSync[]): string {
  const criticalItems = items.filter(i => i.priority === 'critical');
  const otherItems = items.filter(i => i.priority !== 'critical');

  let message = '🔔 <b>環境變數同步提醒</b>\n\n';

  if (criticalItems.length > 0) {
    message += `你有 ${criticalItems.length} 個<b>關鍵設定</b>尚未同步到環境變數：\n`;
    for (const item of criticalItems) {
      const hoursOld = Math.round((Date.now() - new Date(item.setAt).getTime()) / (1000 * 60 * 60));
      message += `• <code>${item.name}</code> (${hoursOld} 小時前設定)\n`;
    }
    message += '\n';
  }

  if (otherItems.length > 0) {
    message += `另有 ${otherItems.length} 個一般設定未同步。\n\n`;
  }

  message += '⚠️ 這些設定只存在 clawdbot.json，如果發生問題可能會丟失。\n\n';
  message += '👉 請在 Claude Code 說「<code>幫我同步環境變數</code>」\n';
  message += '👉 或前往 _admin → Settings Sync';

  return message;
}

/**
 * Check and send reminders for pending env syncs
 *
 * Called by cron job. Sends reminder if:
 * - There are pending items older than 24 hours
 * - Haven't reminded in the last 24 hours
 */
export async function checkAndSendReminders(
  sandbox: Sandbox,
  env: MoltbotEnv
): Promise<{ sent: boolean; itemCount: number; error?: string }> {
  try {
    // Mount R2
    await mountR2Storage(sandbox, env);

    // Get items that need reminding
    const items = await getPendingItemsForReminder(sandbox, env, {
      minHoursOld: 24,
      minHoursSinceLastReminder: 24,
    });

    if (items.length === 0) {
      return { sent: false, itemCount: 0 };
    }

    console.log(`[EnvSyncReminder] Found ${items.length} items needing reminder`);

    // Get admin info
    const adminInfo = await loadAdminInfo(sandbox);
    if (!adminInfo?.telegramChatId) {
      console.log('[EnvSyncReminder] No admin chat ID configured, skipping Telegram reminder');
      // Still mark as "reminded" to avoid repeated checks
      await markAsReminded(sandbox, env, items.map(i => i.name));
      return { sent: false, itemCount: items.length, error: 'No admin chat ID' };
    }

    // Get bot token
    const botToken = await getTelegramBotToken(sandbox);
    if (!botToken) {
      console.log('[EnvSyncReminder] No Telegram bot token found');
      return { sent: false, itemCount: items.length, error: 'No bot token' };
    }

    // Send reminder
    const message = formatReminderMessage(items);
    const sent = await sendTelegramMessage(botToken, adminInfo.telegramChatId, message);

    if (sent) {
      // Mark items as reminded
      await markAsReminded(sandbox, env, items.map(i => i.name));
      console.log(`[EnvSyncReminder] Sent reminder for ${items.length} items`);
    }

    return { sent, itemCount: items.length };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[EnvSyncReminder] Error:', error);
    return { sent: false, itemCount: 0, error };
  }
}

/**
 * Generate immediate notification message when a setting is changed
 * This should be called when moltbot saves a setting via chat
 */
export function generateImmediateNotification(settingName: string, displayName: string): string {
  return `✅ 已更新 <b>${displayName}</b>！

⚠️ <b>安全提醒</b>：這個設定目前只存在 clawdbot.json。
如果 R2 掛載失敗，可能會丟失。

建議同步到環境變數：
📋 在 Claude Code 執行：
<code>npx wrangler secret put ${settingName}</code>

或稍後在 _admin → Settings Sync 處理。`;
}
