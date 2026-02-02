import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { MOLTBOT_PORT } from '../config';
import { findExistingMoltbotProcess } from '../gateway';

/**
 * Public routes - NO Cloudflare Access authentication required
 * 
 * These routes are mounted BEFORE the auth middleware is applied.
 * Includes: health checks, static assets, and public API endpoints.
 */
const publicRoutes = new Hono<AppEnv>();

// GET /sandbox-health - Health check endpoint
publicRoutes.get('/sandbox-health', (c) => {
  return c.json({
    status: 'ok',
    service: 'moltbot-sandbox',
    gateway_port: MOLTBOT_PORT,
  });
});

// GET /logo.png - Serve logo from ASSETS binding
publicRoutes.get('/logo.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /logo-small.png - Serve small logo from ASSETS binding
publicRoutes.get('/logo-small.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /api/status - Public health check for gateway status (no auth required)
publicRoutes.get('/api/status', async (c) => {
  const sandbox = c.get('sandbox');
  
  try {
    const process = await findExistingMoltbotProcess(sandbox);
    if (!process) {
      return c.json({ ok: false, status: 'not_running' });
    }
    
    // Process exists, check if it's actually responding
    // Try to reach the gateway with a short timeout
    try {
      await process.waitForPort(18789, { mode: 'tcp', timeout: 5000 });
      return c.json({ ok: true, status: 'running', processId: process.id });
    } catch {
      return c.json({ ok: false, status: 'not_responding', processId: process.id });
    }
  } catch (err) {
    return c.json({ ok: false, status: 'error', error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

// GET /_admin/assets/* - Admin UI static assets (CSS, JS need to load for login redirect)
// Assets are built to dist/client with base "/_admin/"
publicRoutes.get('/_admin/assets/*', async (c) => {
  const url = new URL(c.req.url);
  // Rewrite /_admin/assets/* to /assets/* for the ASSETS binding
  const assetPath = url.pathname.replace('/_admin/assets/', '/assets/');
  const assetUrl = new URL(assetPath, url.origin);
  return c.env.ASSETS.fetch(new Request(assetUrl.toString(), c.req.raw));
});

// GET /assets/* - Gateway static assets (CSS, JS) - proxy to gateway without auth
// These are loaded by the main page after token auth, but the asset requests don't carry the token
publicRoutes.get('/assets/*', async (c) => {
  const sandbox = c.get('sandbox');
  // Proxy to gateway - static assets don't need auth
  return sandbox.containerFetch(c.req.raw, MOLTBOT_PORT);
});

// POST /api/public/gateway/restart - Restart gateway with token auth (bypasses CF Access)
// This endpoint is public but requires MOLTBOT_GATEWAY_TOKEN for security
publicRoutes.post('/api/public/gateway/restart', async (c) => {
  // Validate gateway token
  const url = new URL(c.req.url);
  const token = url.searchParams.get('token');
  const expectedToken = c.env.MOLTBOT_GATEWAY_TOKEN;

  if (!expectedToken) {
    return c.json({ error: 'Gateway token not configured' }, 500);
  }

  if (!token || token !== expectedToken) {
    return c.json({ error: 'Invalid or missing token' }, 401);
  }

  const sandbox = c.get('sandbox');

  try {
    // Find and kill existing gateway process
    const existingProcess = await findExistingMoltbotProcess(sandbox);
    if (existingProcess) {
      console.log('[restart] Killing existing gateway process:', existingProcess.id);
      try {
        await existingProcess.kill();
      } catch (killErr) {
        console.error('[restart] Error killing process:', killErr);
      }
    }

    return c.json({
      success: true,
      message: existingProcess
        ? 'Gateway process killed, new instance starting...'
        : 'No existing gateway found, starting new instance...',
      killedProcess: existingProcess?.id || null,
    });
  } catch (err) {
    console.error('[restart] Gateway restart failed:', err);
    return c.json({
      error: 'Restart failed',
      details: err instanceof Error ? err.message : 'Unknown error'
    }, 500);
  }
});

export { publicRoutes };
