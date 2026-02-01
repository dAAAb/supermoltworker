# SuperMoltWorker - Moltbot on Cloudflare Workers

Run [Moltbot](https://molt.bot/) personal AI assistant in a [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) with enhanced evolution protection and memory management.

> **SuperMoltWorker** is an enhanced fork of moltworker that adds evolution protection, memory snapshots, conflict detection, and health monitoring to help your moltbot safely evolve without "past-life memory" issues.

> **Experimental:** This is a proof of concept demonstrating that Moltbot can run in Cloudflare Sandbox. It is not officially supported and may break without notice. Use at your own risk.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/moltworker)

![moltworker architecture](./assets/logo.png)

## Requirements

- [Workers Paid plan](https://www.cloudflare.com/plans/developer-platform/) ($5 USD/month) — required for Cloudflare Sandbox containers
- [Anthropic API key](https://console.anthropic.com/) — for Claude access, or you can use AI Gateway's [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)

The following Cloudflare features used by this project have free tiers:
- Cloudflare Access (authentication)
- Browser Rendering (for browser navigation)
- AI Gateway (optional, for API routing/analytics)
- R2 Storage (optional, for persistence)

## What is Moltbot?

[Moltbot](https://molt.bot/) is a personal AI assistant with a gateway architecture that connects to multiple chat platforms. Key features:

- **Control UI** - Web-based chat interface at the gateway
- **Multi-channel support** - Telegram, Discord, Slack
- **Device pairing** - Secure DM authentication requiring explicit approval
- **Persistent conversations** - Chat history and context across sessions
- **Agent runtime** - Extensible AI capabilities with workspace and skills

This project packages Moltbot to run in a [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) container, providing a fully managed, always-on deployment without needing to self-host. Optional R2 storage enables persistence across container restarts.

## Architecture

![moltworker architecture](./assets/architecture.png)

## Quick Start

_Cloudflare Sandboxes are available on the [Workers Paid plan](https://dash.cloudflare.com/?to=/:account/workers/plans)._

```bash
# Install dependencies
npm install

# Set your API key (direct Anthropic access)
npx wrangler secret put ANTHROPIC_API_KEY

# Or use AI Gateway instead (see "Optional: Cloudflare AI Gateway" below)
# npx wrangler secret put AI_GATEWAY_API_KEY
# npx wrangler secret put AI_GATEWAY_BASE_URL

# Generate and set a gateway token (required for remote access)
# Save this token - you'll need it to access the Control UI
export MOLTBOT_GATEWAY_TOKEN=$(openssl rand -hex 32)
echo "Your gateway token: $MOLTBOT_GATEWAY_TOKEN"
echo "$MOLTBOT_GATEWAY_TOKEN" | npx wrangler secret put MOLTBOT_GATEWAY_TOKEN

# Deploy
npm run deploy
```

After deploying, open the Control UI with your token:

```
https://your-worker.workers.dev/?token=YOUR_GATEWAY_TOKEN
```

Replace `your-worker` with your actual worker subdomain and `YOUR_GATEWAY_TOKEN` with the token you generated above.

**Note:** The first request may take 1-2 minutes while the container starts.

> **Important:** You will not be able to use the Control UI until you complete the following steps. You MUST:
> 1. [Set up Cloudflare Access](#setting-up-the-admin-ui) to protect the admin UI
> 2. [Pair your device](#device-pairing) via the admin UI at `/_admin/`

You'll also likely want to [enable R2 storage](#persistent-storage-r2) so your paired devices and conversation history persist across container restarts (optional but recommended).

## Setting Up the Admin UI

To use the admin UI at `/_admin/` for device management, you need to:
1. Enable Cloudflare Access on your worker
2. Set the Access secrets so the worker can validate JWTs

### 1. Enable Cloudflare Access on workers.dev

The easiest way to protect your worker is using the built-in Cloudflare Access integration for workers.dev:

1. Go to the [Workers & Pages dashboard](https://dash.cloudflare.com/?to=/:account/workers-and-pages)
2. Select your Worker (e.g., `moltbot-sandbox`)
3. In **Settings**, under **Domains & Routes**, in the `workers.dev` row, click the meatballs menu (`...`)
4. Click **Enable Cloudflare Access**
5. Click **Manage Cloudflare Access** to configure who can access:
   - Add your email address to the allow list
   - Or configure other identity providers (Google, GitHub, etc.)
6. Copy the **Application Audience (AUD)** tag from the Access application settings. This will be your `CF_ACCESS_AUD` in Step 2 below

### 2. Set Access Secrets

After enabling Cloudflare Access, set the secrets so the worker can validate JWTs:

```bash
# Your Cloudflare Access team domain (e.g., "myteam.cloudflareaccess.com")
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN

# The Application Audience (AUD) tag from your Access application that you copied in the step above
npx wrangler secret put CF_ACCESS_AUD
```

You can find your team domain in the [Zero Trust Dashboard](https://one.dash.cloudflare.com/) under **Settings** > **Custom Pages** (it's the subdomain before `.cloudflareaccess.com`).

### 3. Redeploy

```bash
npm run deploy
```

Now visit `/_admin/` and you'll be prompted to authenticate via Cloudflare Access before accessing the admin UI.

### Alternative: Manual Access Application

If you prefer more control, you can manually create an Access application:

1. Go to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. Navigate to **Access** > **Applications**
3. Create a new **Self-hosted** application
4. Set the application domain to your Worker URL (e.g., `moltbot-sandbox.your-subdomain.workers.dev`)
5. Add paths to protect: `/_admin/*`, `/api/*`, `/debug/*`
6. Configure your desired identity providers (e.g., email OTP, Google, GitHub)
7. Copy the **Application Audience (AUD)** tag and set the secrets as shown above

### Local Development

For local development, create a `.dev.vars` file with:

```bash
DEV_MODE=true               # Skip Cloudflare Access auth + bypass device pairing
DEBUG_ROUTES=true           # Enable /debug/* routes (optional)
```

## Authentication

By default, moltbot uses **device pairing** for authentication. When a new device (browser, CLI, etc.) connects, it must be approved via the admin UI at `/_admin/`.

### Device Pairing

1. A device connects to the gateway
2. The connection is held pending until approved
3. An admin approves the device via `/_admin/`
4. The device is now paired and can connect freely

This is the most secure option as it requires explicit approval for each device.

### Gateway Token (Required)

A gateway token is required to access the Control UI when hosted remotely. Pass it as a query parameter:

```
https://your-worker.workers.dev/?token=YOUR_TOKEN
wss://your-worker.workers.dev/ws?token=YOUR_TOKEN
```

**Note:** Even with a valid token, new devices still require approval via the admin UI at `/_admin/` (see Device Pairing above).

For local development only, set `DEV_MODE=true` in `.dev.vars` to skip Cloudflare Access authentication and enable `allowInsecureAuth` (bypasses device pairing entirely).

## Persistent Storage (R2)

By default, moltbot data (configs, paired devices, conversation history) is lost when the container restarts. To enable persistent storage across sessions, configure R2:

### 1. Create R2 API Token

1. Go to **R2** > **Overview** in the [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Click **Manage R2 API Tokens**
3. Create a new token with **Object Read & Write** permissions
4. Select the `moltbot-data` bucket (created automatically on first deploy)
5. Copy the **Access Key ID** and **Secret Access Key**

### 2. Set Secrets

```bash
# R2 Access Key ID
npx wrangler secret put R2_ACCESS_KEY_ID

# R2 Secret Access Key
npx wrangler secret put R2_SECRET_ACCESS_KEY

# Your Cloudflare Account ID
npx wrangler secret put CF_ACCOUNT_ID
```

To find your Account ID: Go to the [Cloudflare Dashboard](https://dash.cloudflare.com/), click the three dots menu next to your account name, and select "Copy Account ID".

### How It Works

R2 storage uses a backup/restore approach for simplicity:

**On container startup:**
- If R2 is mounted and contains backup data, it's restored to the moltbot config directory
- Moltbot uses its default paths (no special configuration needed)

**During operation:**
- A cron job runs every 5 minutes to sync the moltbot config to R2
- You can also trigger a manual backup from the admin UI at `/_admin/`

**In the admin UI:**
- When R2 is configured, you'll see "Last backup: [timestamp]"
- Click "Backup Now" to trigger an immediate sync

Without R2 credentials, moltbot still works but uses ephemeral storage (data lost on container restart).

## Container Lifecycle

By default, the sandbox container stays alive indefinitely (`SANDBOX_SLEEP_AFTER=never`). This is recommended because cold starts take 1-2 minutes.

To reduce costs for infrequently used deployments, you can configure the container to sleep after a period of inactivity:

```bash
npx wrangler secret put SANDBOX_SLEEP_AFTER
# Enter: 10m (or 1h, 30m, etc.)
```

When the container sleeps, the next request will trigger a cold start. If you have R2 storage configured, your paired devices and data will persist across restarts.

## Admin UI

![admin ui](./assets/adminui.png)

Access the admin UI at `/_admin/` to:
- **R2 Storage Status** - Shows if R2 is configured, last backup time, and a "Backup Now" button
- **Restart Gateway** - Kill and restart the moltbot gateway process
- **Device Pairing** - View pending requests, approve devices individually or all at once, view paired devices
- **Memory Panel** - View and manage snapshots, restore to previous states (SuperMoltWorker)
- **Health Dashboard** - Monitor system health, detect conflicts, auto-repair issues (SuperMoltWorker)
- **Evolution Panel** - Manage moltbot's self-modification requests, approve/reject config changes (SuperMoltWorker)

The admin UI requires Cloudflare Access authentication (or `DEV_MODE=true` for local development).

## SuperMoltWorker Features

SuperMoltWorker adds several features to help manage moltbot's "evolution" - its ability to modify its own configuration and learn from interactions.

### Memory Snapshot System

Automatic and manual snapshots of moltbot's configuration state:

- **Auto-snapshots** - Created automatically before startup and before risky operations
- **Manual snapshots** - Create snapshots anytime via the Memory Panel
- **Snapshot restore** - Roll back to any previous snapshot
- **Configurable retention** - Keep the last N snapshots (default: 10)

```bash
# Disable auto-snapshots (not recommended)
npx wrangler secret put AUTO_SNAPSHOT
# Enter: false
```

### Evolution Protection

When moltbot tries to modify its configuration (e.g., changing AI providers, updating channel settings), SuperMoltWorker intercepts the change and:

1. **Analyzes risk level** - Safe, Medium, or High based on what's being changed
2. **Creates a pre-evolution snapshot** - So you can roll back if needed
3. **Notifies you via WebSocket** - Real-time notification to approve/reject changes

Risk levels:
- **Safe** - Workspace paths, agent defaults, adding skills
- **Medium** - Gateway settings, channel configuration
- **High** - AI provider changes, authentication settings

```bash
# Set evolution mode (default: confirm)
npx wrangler secret put SUPER_MOLTWORKER_EVOLUTION_MODE
# Options:
#   confirm - Require approval for medium/high risk changes
#   auto - Auto-approve safe changes only
#   test - Test mode, never actually apply changes
```

### Conflict Detection

At startup, SuperMoltWorker checks for "past-life memory" conflicts:

- **Provider stacking** - Multiple AI providers configured simultaneously
- **Auth mismatch** - Inconsistent authentication settings
- **Channel residue** - Old channel configs from previous sessions
- **Timestamp anomalies** - Future timestamps or other time issues

```bash
# Enable auto-fix for detected conflicts
npx wrangler secret put CONFLICT_AUTO_FIX
# Enter: true
```

### Health Monitoring

Continuous health checks and self-repair capabilities:

- **Config validation** - Ensure configuration is valid JSON
- **Provider status** - Check AI provider connectivity
- **R2 connectivity** - Verify backup storage is working
- **Gateway health** - Monitor gateway responsiveness

Access the Health Dashboard at `/_admin/` (Health tab) to view status and trigger repairs.

### Complete Reset Wizard

If moltbot gets into an unrecoverable state, use the Reset Wizard:

1. Choose what to preserve (conversations, devices, skills)
2. Create a final snapshot for safety
3. Reset to initial state
4. Optionally restore from snapshot later

### API Endpoints (SuperMoltWorker)

| Endpoint | Description |
|----------|-------------|
| `GET /api/admin/snapshots` | List all snapshots |
| `POST /api/admin/snapshots` | Create a new snapshot |
| `POST /api/admin/snapshots/:id/restore` | Restore to a snapshot |
| `GET /api/admin/health` | Full health check |
| `POST /api/admin/health/repair` | Auto-repair issues |
| `GET /api/admin/health/conflicts` | Detect configuration conflicts |
| `POST /api/admin/health/conflicts/auto-fix` | Auto-fix conflicts |
| `GET /api/admin/evolution/pending` | List pending evolution requests |
| `POST /api/admin/evolution/:id/approve` | Approve an evolution |
| `POST /api/admin/evolution/:id/reject` | Reject an evolution |
| `GET /api/admin/notifications` | Get all notifications |
| `WS /ws/notifications` | WebSocket for real-time notifications |

## Design Philosophy

SuperMoltWorker introduces a unique approach to managing AI assistant configuration that addresses the "past-life memory" problem - where an AI assistant's persistent state conflicts with new deployment settings.

### The Dual-Storage Architecture

SuperMoltWorker maintains configuration in two separate locations:

1. **R2 Storage (clawdbot.json)** - The primary configuration file containing all settings, managed by the AI assistant itself
2. **Cloudflare Secrets (Environment Variables)** - Critical secrets stored securely in Cloudflare's infrastructure

This dual-storage approach provides a safety net: if the AI accidentally corrupts its configuration or "forgets" important settings, the Cloudflare Secrets remain intact.

### Settings Sync Status

The Settings Sync panel displays four status types:

| Status | Meaning | Safety Level |
|--------|---------|--------------|
| **Synced** | Value exists in both clawdbot.json and Cloudflare Secrets | ✅ Safe |
| **Env Only** | Value exists only in Cloudflare Secrets | ✅✅ Safest |
| **Unsynced** | Value exists only in clawdbot.json | ⚠️ At Risk |
| **Not Set** | Value not configured anywhere | ❌ Missing |

**Why "Env Only" is the safest configuration:**
- Cloudflare Secrets are immutable and managed outside the container
- Even if R2 data is lost or corrupted, secrets persist
- The AI assistant cannot accidentally delete or modify these values
- On restart, the system always has access to critical credentials

**Why "Unsynced" is risky:**
- If R2 storage fails, the value is lost forever
- If the AI corrupts clawdbot.json, the value may become invalid
- No backup exists in the infrastructure

### The Evolution Protection Model

When moltbot (the AI assistant) attempts to modify its own configuration:

```
┌─────────────────────────────────────────────────────────┐
│  AI Assistant requests config change                    │
│                    ↓                                    │
│  ┌─────────────────────────────────────────────┐       │
│  │  SuperMoltWorker intercepts the request     │       │
│  │  1. Analyze risk level                      │       │
│  │  2. Create pre-evolution snapshot           │       │
│  │  3. Notify user (if high risk)              │       │
│  │  4. Wait for approval                       │       │
│  │  5. Apply change (or reject)                │       │
│  └─────────────────────────────────────────────┘       │
│                    ↓                                    │
│  Change applied with full rollback capability           │
└─────────────────────────────────────────────────────────┘
```

This prevents the "evolution death spiral" where:
1. AI modifies configuration
2. Configuration becomes invalid
3. AI can't start properly
4. AI tries to "fix" by modifying more
5. Situation gets worse

### Safe Restart Protocol

One critical lesson learned: restarting immediately after configuration changes can cause data loss because R2 sync happens every 5 minutes.

SuperMoltWorker's safe restart:
1. Create a snapshot before restart
2. Force-sync to R2 immediately
3. Notify user that snapshot exists for rollback
4. Execute restart

### Upgrade Script Design

The `scripts/upgrade-dora.sh` demonstrates best practices for upgrading existing moltbot deployments:

1. **Pre-flight checks** - Verify all required secrets exist before deployment
2. **Automatic backup** - Download existing clawdbot.json before any changes
3. **Phased deployment** - Build → Deploy → Verify in separate steps
4. **Post-deployment verification** - Health check after deployment completes

```bash
# Example: Required secrets check
REQUIRED_SECRETS=("ANTHROPIC_API_KEY" "MOLTBOT_GATEWAY_TOKEN" ...)
for secret in "${REQUIRED_SECRETS[@]}"; do
  if ! exists "$secret"; then
    warn "Missing required secret: $secret"
  fi
done
```

### Lessons from Production

Based on real-world deployment experience:

1. **Secret naming consistency matters** - Use the exact secret names that the Worker expects (e.g., `MOLTBOT_GATEWAY_TOKEN` not `GATEWAY_AUTH_TOKEN`)

2. **Always backup before upgrade** - Even if you think nothing will change, unexpected issues happen

3. **Verify Settings Sync after upgrade** - Check that all "Unsynced" items are intentional

4. **Set critical secrets to "Env Only"** - For maximum resilience, configure important credentials as Cloudflare Secrets even if they're also in clawdbot.json

## Debug Endpoints

Debug endpoints are available at `/debug/*` when enabled (requires `DEBUG_ROUTES=true` and Cloudflare Access):

- `GET /debug/processes` - List all container processes
- `GET /debug/logs?id=<process_id>` - Get logs for a specific process
- `GET /debug/version` - Get container and moltbot version info

## Optional: Chat Channels

### Telegram

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npm run deploy
```

### Discord

```bash
npx wrangler secret put DISCORD_BOT_TOKEN
npm run deploy
```

### Slack

```bash
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SLACK_APP_TOKEN
npm run deploy
```

## Optional: Browser Automation (CDP)

This worker includes a Chrome DevTools Protocol (CDP) shim that enables browser automation capabilities. This allows Moltbot to control a headless browser for tasks like web scraping, screenshots, and automated testing.

### Setup

1. Set a shared secret for authentication:

```bash
npx wrangler secret put CDP_SECRET
# Enter a secure random string
```

2. Set your worker's public URL:

```bash
npx wrangler secret put WORKER_URL
# Enter: https://your-worker.workers.dev
```

3. Redeploy:

```bash
npm run deploy
```

### Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /cdp/json/version` | Browser version information |
| `GET /cdp/json/list` | List available browser targets |
| `GET /cdp/json/new` | Create a new browser target |
| `WS /cdp/devtools/browser/{id}` | WebSocket connection for CDP commands |

All endpoints require the `CDP_SECRET` header for authentication.

## Built-in Skills

The container includes pre-installed skills in `/root/clawd/skills/`:

### cloudflare-browser

Browser automation via the CDP shim. Requires `CDP_SECRET` and `WORKER_URL` to be set (see [Browser Automation](#optional-browser-automation-cdp) above).

**Scripts:**
- `screenshot.js` - Capture a screenshot of a URL
- `video.js` - Create a video from multiple URLs
- `cdp-client.js` - Reusable CDP client library

**Usage:**
```bash
# Screenshot
node /root/clawd/skills/cloudflare-browser/scripts/screenshot.js https://example.com output.png

# Video from multiple URLs
node /root/clawd/skills/cloudflare-browser/scripts/video.js "https://site1.com,https://site2.com" output.mp4 --scroll
```

See `skills/cloudflare-browser/SKILL.md` for full documentation.

## Optional: Cloudflare AI Gateway

You can route API requests through [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) for caching, rate limiting, analytics, and cost tracking. AI Gateway supports multiple providers — configure your preferred provider in the gateway and use these env vars:

### Setup

1. Create an AI Gateway in the [AI Gateway section](https://dash.cloudflare.com/?to=/:account/ai/ai-gateway/create-gateway) of the Cloudflare Dashboard.
2. Add a provider (e.g., Anthropic) to your gateway
3. Set the gateway secrets:

You'll find the base URL on the Overview tab of your newly created gateway. At the bottom of the page, expand the **Native API/SDK Examples** section and select "Anthropic".

```bash
# Your provider's API key (e.g., Anthropic API key)
npx wrangler secret put AI_GATEWAY_API_KEY

# Your AI Gateway endpoint URL
npx wrangler secret put AI_GATEWAY_BASE_URL
# Enter: https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/anthropic
```

4. Redeploy:

```bash
npm run deploy
```

The `AI_GATEWAY_*` variables take precedence over `ANTHROPIC_*` if both are set.

## All Secrets Reference

| Secret | Required | Description |
|--------|----------|-------------|
| `AI_GATEWAY_API_KEY` | Yes* | API key for your AI Gateway provider (requires `AI_GATEWAY_BASE_URL`) |
| `AI_GATEWAY_BASE_URL` | Yes* | AI Gateway endpoint URL (required when using `AI_GATEWAY_API_KEY`) |
| `ANTHROPIC_API_KEY` | Yes* | Direct Anthropic API key (fallback if AI Gateway not configured) |
| `ANTHROPIC_BASE_URL` | No | Direct Anthropic API base URL (fallback) |
| `OPENAI_API_KEY` | No | OpenAI API key (alternative provider) |
| `CF_ACCESS_TEAM_DOMAIN` | Yes* | Cloudflare Access team domain (required for admin UI) |
| `CF_ACCESS_AUD` | Yes* | Cloudflare Access application audience (required for admin UI) |
| `MOLTBOT_GATEWAY_TOKEN` | Yes | Gateway token for authentication (pass via `?token=` query param) |
| `DEV_MODE` | No | Set to `true` to skip CF Access auth + device pairing (local dev only) |
| `DEBUG_ROUTES` | No | Set to `true` to enable `/debug/*` routes |
| `SANDBOX_SLEEP_AFTER` | No | Container sleep timeout: `never` (default) or duration like `10m`, `1h` |
| `R2_ACCESS_KEY_ID` | No | R2 access key for persistent storage |
| `R2_SECRET_ACCESS_KEY` | No | R2 secret key for persistent storage |
| `CF_ACCOUNT_ID` | No | Cloudflare account ID (required for R2 storage) |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token |
| `TELEGRAM_DM_POLICY` | No | Telegram DM policy: `pairing` (default) or `open` |
| `DISCORD_BOT_TOKEN` | No | Discord bot token |
| `DISCORD_DM_POLICY` | No | Discord DM policy: `pairing` (default) or `open` |
| `SLACK_BOT_TOKEN` | No | Slack bot token |
| `SLACK_APP_TOKEN` | No | Slack app token |
| `CDP_SECRET` | No | Shared secret for CDP endpoint authentication (see [Browser Automation](#optional-browser-automation-cdp)) |
| `WORKER_URL` | No | Public URL of the worker (required for CDP) |
| `AUTO_SNAPSHOT` | No | Set to `false` to disable auto-snapshots (SuperMoltWorker) |
| `CONFLICT_AUTO_FIX` | No | Set to `true` to auto-fix detected conflicts (SuperMoltWorker) |
| `SUPER_MOLTWORKER_EVOLUTION_MODE` | No | Evolution mode: `confirm` (default), `auto`, or `test` (SuperMoltWorker) |
| `SUPER_MOLTWORKER_MAX_SNAPSHOTS` | No | Maximum snapshots to keep (default: 10) (SuperMoltWorker) |

## Security Considerations

### Authentication Layers

Moltbot in Cloudflare Sandbox uses multiple authentication layers:

1. **Cloudflare Access** - Protects admin routes (`/_admin/`, `/api/*`, `/debug/*`). Only authenticated users can manage devices.

2. **Gateway Token** - Required to access the Control UI. Pass via `?token=` query parameter. Keep this secret.

3. **Device Pairing** - Each device (browser, CLI, chat platform DM) must be explicitly approved via the admin UI before it can interact with the assistant. This is the default "pairing" DM policy.

## Troubleshooting

**`npm run dev` fails with an `Unauthorized` error:** You need to enable Cloudflare Containers in the [Containers dashboard](https://dash.cloudflare.com/?to=/:account/workers/containers)

**Gateway fails to start:** Check `npx wrangler secret list` and `npx wrangler tail`

**Config changes not working:** Edit the `# Build cache bust:` comment in `Dockerfile` and redeploy

**Slow first request:** Cold starts take 1-2 minutes. Subsequent requests are faster.

**R2 not mounting:** Check that all three R2 secrets are set (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `CF_ACCOUNT_ID`). Note: R2 mounting only works in production, not with `wrangler dev`.

**Access denied on admin routes:** Ensure `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` are set, and that your Cloudflare Access application is configured correctly.

**Devices not appearing in admin UI:** Device list commands take 10-15 seconds due to WebSocket connection overhead. Wait and refresh.

**WebSocket issues in local development:** `wrangler dev` has known limitations with WebSocket proxying through the sandbox. HTTP requests work but WebSocket connections may fail. Deploy to Cloudflare for full functionality.

## Links

- [Moltbot](https://molt.bot/)
- [Moltbot Docs](https://docs.molt.bot)
- [Cloudflare Sandbox Docs](https://developers.cloudflare.com/sandbox/)
- [Cloudflare Access Docs](https://developers.cloudflare.com/cloudflare-one/policies/access/)
