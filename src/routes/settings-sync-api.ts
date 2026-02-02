import { Hono } from 'hono';
import type { AppEnv } from '../types';
import {
  getSettingsSyncStatus,
  generateExportCommands,
  loadPendingEnvSync,
  removePendingEnvSync,
  getPendingItemsForReminder,
} from '../gateway/settings-sync';

/**
 * Settings Sync API routes
 *
 * Provides endpoints for:
 * - Viewing sync status between clawdbot.json and environment variables
 * - Generating wrangler secret put commands
 * - Managing pending env sync items
 */
const settingsSyncApi = new Hono<AppEnv>();

/**
 * GET /api/admin/settings/sync-status
 * Get the current sync status of all settings
 */
settingsSyncApi.get('/sync-status', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    const status = await getSettingsSyncStatus(sandbox, c.env);

    // Mask sensitive values in response
    for (const category of Object.values(status.categories)) {
      for (const item of category) {
        if (item.isSensitive && item.configValue) {
          // Keep masked version, remove raw value from response
          delete (item as unknown as Record<string, unknown>).configValueRaw;
        }
      }
    }

    return c.json({
      success: true,
      ...status,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: errorMessage }, 500);
  }
});

/**
 * GET /api/admin/settings/export-commands
 * Generate wrangler secret put commands for unsynced settings
 *
 * Query params:
 * - category: 'all' | 'secrets' | 'channels' | 'agents' | 'gateway' | 'other'
 * - onlyUnsynced: boolean (default: true)
 */
settingsSyncApi.get('/export-commands', async (c) => {
  const sandbox = c.get('sandbox');
  const category = c.req.query('category') as 'all' | 'secrets' | 'channels' | 'agents' | 'gateway' | 'other' || 'all';
  const onlyUnsynced = c.req.query('onlyUnsynced') !== 'false';

  try {
    const result = await generateExportCommands(sandbox, c.env, {
      category,
      onlyUnsynced,
    });

    return c.json({
      success: true,
      commands: result.commands,
      items: result.items,
      commandsText: result.commands.join('\n'),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: errorMessage }, 500);
  }
});

/**
 * GET /api/admin/settings/pending
 * Get pending env sync items
 */
settingsSyncApi.get('/pending', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    const data = await loadPendingEnvSync(sandbox);
    return c.json({
      success: true,
      pending: data.pending,
      lastUpdated: data.lastUpdated,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: errorMessage }, 500);
  }
});

/**
 * DELETE /api/admin/settings/pending/:name
 * Remove a pending env sync item (after user has synced it)
 */
settingsSyncApi.delete('/pending/:name', async (c) => {
  const sandbox = c.get('sandbox');
  const name = c.req.param('name');

  if (!name) {
    return c.json({ success: false, error: 'Setting name is required' }, 400);
  }

  try {
    const removed = await removePendingEnvSync(sandbox, c.env, name);
    return c.json({
      success: removed,
      message: removed ? `Removed ${name} from pending sync` : 'Setting not found in pending list',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: errorMessage }, 500);
  }
});

/**
 * GET /api/admin/settings/reminder-candidates
 * Get pending items that need reminding (for cron job / admin preview)
 *
 * Query params:
 * - minHoursOld: number (default: 24)
 */
settingsSyncApi.get('/reminder-candidates', async (c) => {
  const sandbox = c.get('sandbox');
  const minHoursOld = parseInt(c.req.query('minHoursOld') || '24', 10);

  try {
    const items = await getPendingItemsForReminder(sandbox, c.env, {
      minHoursOld,
      minHoursSinceLastReminder: 24,
    });

    return c.json({
      success: true,
      items,
      count: items.length,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: errorMessage }, 500);
  }
});

/**
 * POST /api/admin/settings/update-config
 * Update a setting value in clawdbot.json
 *
 * Body:
 * - name: string (setting name, e.g., "ANTHROPIC_API_KEY")
 * - value: string (new value)
 */
settingsSyncApi.post('/update-config', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    const body = await c.req.json();
    const { name, value } = body;

    if (!name) {
      return c.json({ success: false, error: 'Setting name is required' }, 400);
    }

    if (value === undefined || value === null) {
      return c.json({ success: false, error: 'Setting value is required' }, 400);
    }

    // Read current config
    const CONFIG_PATH = '/root/.clawdbot/clawdbot.json';
    const readProc = await sandbox.startProcess(`cat ${CONFIG_PATH} 2>/dev/null || echo '{}'`);
    await readProc.wait();
    const readLogs = await readProc.getLogs();

    let config: Record<string, unknown> = {};
    if (readLogs.stdout) {
      try {
        config = JSON.parse(readLogs.stdout);
      } catch (parseErr) {
        console.error('[update-config] Failed to parse config:', parseErr);
        config = {};
      }
    }

    // Update the setting
    // Handle nested paths like "models.providers.anthropic.apiKey"
    const parts = name.split('.');
    let current: Record<string, unknown> = config;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!current[part] || typeof current[part] !== 'object') {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }

    const lastPart = parts[parts.length - 1];
    current[lastPart] = value;

    // Write updated config
    const configJson = JSON.stringify(config, null, 2);
    const writeProc = await sandbox.startProcess(
      `cat > ${CONFIG_PATH} << 'EOF'\n${configJson}\nEOF`
    );
    await writeProc.wait();

    console.log(`[update-config] Updated ${name} in clawdbot.json`);

    return c.json({
      success: true,
      message: `Successfully updated ${name}`,
      name,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[update-config] Error:', errorMessage);
    return c.json({ success: false, error: errorMessage }, 500);
  }
});

export { settingsSyncApi };
