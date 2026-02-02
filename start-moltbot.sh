#!/bin/bash
# Startup script for Moltbot in Cloudflare Sandbox
# This script:
# 1. Restores config from R2 backup if available
# 2. Configures moltbot from environment variables
# 3. Starts a background sync to backup config to R2
# 4. Starts the gateway

set -e

# ============================================================
# STARTUP STATUS TRACKING
# ============================================================
# Track startup issues for later diagnostics
STARTUP_WARNINGS=""
STARTUP_ERRORS=""

log_warning() {
    local msg="[WARN] $1"
    echo "$msg"
    STARTUP_WARNINGS="${STARTUP_WARNINGS}${msg}\n"
}

log_error() {
    local msg="[ERROR] $1"
    echo "$msg" >&2
    STARTUP_ERRORS="${STARTUP_ERRORS}${msg}\n"
}

log_info() {
    echo "[INFO] $1"
}

# Check if clawdbot gateway is already running - bail early if so
# Note: CLI is still named "clawdbot" until upstream renames it
if pgrep -f "clawdbot gateway" > /dev/null 2>&1; then
    log_info "Moltbot gateway is already running, exiting."
    exit 0
fi

# Paths (clawdbot paths are used internally - upstream hasn't renamed yet)
CONFIG_DIR="/root/.clawdbot"
CONFIG_FILE="$CONFIG_DIR/clawdbot.json"
TEMPLATE_DIR="/root/.clawdbot-templates"
TEMPLATE_FILE="$TEMPLATE_DIR/moltbot.json.template"
BACKUP_DIR="/data/moltbot"
STATUS_FILE="$CONFIG_DIR/.startup-status.json"

log_info "Config directory: $CONFIG_DIR"
log_info "Backup directory: $BACKUP_DIR"

# Create config directory
mkdir -p "$CONFIG_DIR"

# ============================================================
# RESTORE FROM R2 BACKUP
# ============================================================
# Check if R2 backup exists by looking for clawdbot.json
# The BACKUP_DIR may exist but be empty if R2 was just mounted
# Note: backup structure is $BACKUP_DIR/clawdbot/ and $BACKUP_DIR/skills/

# Helper function to parse ISO 8601 timestamp to epoch seconds
# Handles both full ISO format and date-only format
parse_timestamp_to_epoch() {
    local ts="$1"
    local epoch=0

    # Skip if empty
    if [ -z "$ts" ]; then
        echo "0"
        return
    fi

    # Try different date parsing methods
    # Method 1: GNU date with -d option
    epoch=$(date -d "$ts" +%s 2>/dev/null) && { echo "$epoch"; return; }

    # Method 2: date with ISO format parsing (for busybox)
    # Extract just the date part if full ISO
    local date_part=$(echo "$ts" | cut -d'T' -f1)
    epoch=$(date -d "$date_part" +%s 2>/dev/null) && { echo "$epoch"; return; }

    # Method 3: Manual parsing for ISO 8601 format YYYY-MM-DDTHH:MM:SS
    if echo "$ts" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}'; then
        # At least we have a valid-looking date, compare lexicographically
        # This works because ISO 8601 is lexicographically sortable
        echo "1"  # Return non-zero to indicate it should be compared as string
        return
    fi

    echo "0"
}

# Helper function to check if R2 backup is newer than local
should_restore_from_r2() {
    local R2_SYNC_FILE="$BACKUP_DIR/.last-sync"
    local LOCAL_SYNC_FILE="$CONFIG_DIR/.last-sync"

    # If no R2 sync timestamp, don't restore
    if [ ! -f "$R2_SYNC_FILE" ]; then
        log_info "No R2 sync timestamp found, skipping restore"
        return 1
    fi

    # If no local sync timestamp, restore from R2
    if [ ! -f "$LOCAL_SYNC_FILE" ]; then
        log_info "No local sync timestamp, will restore from R2"
        return 0
    fi

    # Read timestamps (ISO 8601 format expected)
    R2_TIME=$(cat "$R2_SYNC_FILE" 2>/dev/null | tr -d '\n\r')
    LOCAL_TIME=$(cat "$LOCAL_SYNC_FILE" 2>/dev/null | tr -d '\n\r')

    log_info "R2 last sync: $R2_TIME"
    log_info "Local last sync: $LOCAL_TIME"

    # Validate timestamp format (should start with YYYY-MM-DD)
    if ! echo "$R2_TIME" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}'; then
        log_warning "R2 timestamp format invalid: $R2_TIME"
        return 1
    fi

    if ! echo "$LOCAL_TIME" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}'; then
        log_warning "Local timestamp format invalid: $LOCAL_TIME - will restore from R2"
        return 0
    fi

    # Try epoch-based comparison first
    R2_EPOCH=$(parse_timestamp_to_epoch "$R2_TIME")
    LOCAL_EPOCH=$(parse_timestamp_to_epoch "$LOCAL_TIME")

    if [ "$R2_EPOCH" -gt 1 ] && [ "$LOCAL_EPOCH" -gt 1 ]; then
        # Both parsed successfully, compare epochs
        if [ "$R2_EPOCH" -gt "$LOCAL_EPOCH" ]; then
            log_info "R2 backup is newer (epoch comparison), will restore"
            return 0
        else
            log_info "Local data is newer or same (epoch comparison), skipping restore"
            return 1
        fi
    fi

    # Fallback: lexicographic comparison (works for ISO 8601)
    if [ "$R2_TIME" \> "$LOCAL_TIME" ]; then
        log_info "R2 backup is newer (string comparison), will restore"
        return 0
    else
        log_info "Local data is newer or same (string comparison), skipping restore"
        return 1
    fi
}

R2_RESTORE_SUCCESS=false
if [ -f "$BACKUP_DIR/clawdbot/clawdbot.json" ]; then
    if should_restore_from_r2; then
        log_info "Restoring from R2 backup at $BACKUP_DIR/clawdbot..."
        if cp -a "$BACKUP_DIR/clawdbot/." "$CONFIG_DIR/"; then
            # Copy the sync timestamp to local so we know what version we have
            cp -f "$BACKUP_DIR/.last-sync" "$CONFIG_DIR/.last-sync" 2>/dev/null || true
            log_info "Restored config from R2 backup"
            R2_RESTORE_SUCCESS=true
        else
            log_error "Failed to restore config from R2 backup"
        fi
    fi
elif [ -f "$BACKUP_DIR/clawdbot.json" ]; then
    # Legacy backup format (flat structure)
    if should_restore_from_r2; then
        log_info "Restoring from legacy R2 backup at $BACKUP_DIR..."
        if cp -a "$BACKUP_DIR/." "$CONFIG_DIR/"; then
            cp -f "$BACKUP_DIR/.last-sync" "$CONFIG_DIR/.last-sync" 2>/dev/null || true
            log_info "Restored config from legacy R2 backup"
            R2_RESTORE_SUCCESS=true
        else
            log_error "Failed to restore config from legacy R2 backup"
        fi
    fi
elif [ -d "$BACKUP_DIR" ]; then
    log_info "R2 mounted at $BACKUP_DIR but no backup data found yet"
else
    log_warning "R2 not mounted, starting fresh - data will not persist"
fi

# Restore skills from R2 backup if available (only if R2 is newer)
SKILLS_DIR="/root/clawd/skills"
if [ -d "$BACKUP_DIR/skills" ] && [ "$(ls -A $BACKUP_DIR/skills 2>/dev/null)" ]; then
    if should_restore_from_r2; then
        log_info "Restoring skills from $BACKUP_DIR/skills..."
        mkdir -p "$SKILLS_DIR"
        if cp -a "$BACKUP_DIR/skills/." "$SKILLS_DIR/"; then
            log_info "Restored skills from R2 backup"
        else
            log_warning "Failed to restore skills from R2 backup"
        fi
    fi
fi

# If config file still doesn't exist, create from template
if [ ! -f "$CONFIG_FILE" ]; then
    log_info "No existing config found, initializing from template..."
    if [ -f "$TEMPLATE_FILE" ]; then
        if cp "$TEMPLATE_FILE" "$CONFIG_FILE"; then
            log_info "Created config from template"
        else
            log_error "Failed to copy template config"
        fi
    else
        # Create minimal config if template doesn't exist
        log_info "No template found, creating minimal config"
        cat > "$CONFIG_FILE" << 'EOFCONFIG'
{
  "agents": {
    "defaults": {
      "workspace": "/root/clawd"
    }
  },
  "gateway": {
    "port": 18789,
    "mode": "local"
  }
}
EOFCONFIG
    fi
else
    log_info "Using existing config"
fi

# ============================================================
# UPDATE CONFIG FROM ENVIRONMENT VARIABLES
# ============================================================
CONFIG_UPDATE_SUCCESS=false
node << 'EOFNODE' && CONFIG_UPDATE_SUCCESS=true
const fs = require('fs');

const configPath = '/root/.clawdbot/clawdbot.json';
const statusPath = '/root/.clawdbot/.config-update-status.json';
console.log('[CONFIG] Updating config at:', configPath);

let config = {};
let configLoadError = null;

try {
    const content = fs.readFileSync(configPath, 'utf8');
    config = JSON.parse(content);
    console.log('[CONFIG] Loaded existing config');
} catch (e) {
    configLoadError = e.message;
    console.warn('[CONFIG] Could not load existing config:', e.message);
    console.log('[CONFIG] Starting with empty config');
}

// Ensure nested objects exist
config.agents = config.agents || {};
config.agents.defaults = config.agents.defaults || {};
config.agents.defaults.model = config.agents.defaults.model || {};
config.gateway = config.gateway || {};
config.channels = config.channels || {};

// Clean up any broken anthropic provider config from previous runs
// (older versions didn't include required 'name' field)
if (config.models?.providers?.anthropic?.models) {
    const hasInvalidModels = config.models.providers.anthropic.models.some(m => !m.name);
    if (hasInvalidModels) {
        console.log('Removing broken anthropic provider config (missing model names)');
        delete config.models.providers.anthropic;
    }
}



// Gateway configuration
config.gateway.port = 18789;
config.gateway.mode = 'local';
config.gateway.trustedProxies = ['10.1.0.0'];

// Set gateway token if provided
if (process.env.CLAWDBOT_GATEWAY_TOKEN) {
    config.gateway.auth = config.gateway.auth || {};
    config.gateway.auth.token = process.env.CLAWDBOT_GATEWAY_TOKEN;
    config.gateway.auth.mode = 'token';
}

// Allow insecure auth for dev mode
if (process.env.CLAWDBOT_DEV_MODE === 'true') {
    config.gateway.controlUi = config.gateway.controlUi || {};
    config.gateway.controlUi.allowInsecureAuth = true;
}

// Telegram configuration
if (process.env.TELEGRAM_BOT_TOKEN) {
    config.channels.telegram = config.channels.telegram || {};
    config.channels.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN;
    config.channels.telegram.enabled = true;
    config.channels.telegram.dmPolicy = process.env.TELEGRAM_DM_POLICY || 'pairing';
    // Remove legacy 'dm' key that clawdbot doesn't recognize
    delete config.channels.telegram.dm;
}

// Discord configuration
if (process.env.DISCORD_BOT_TOKEN) {
    config.channels.discord = config.channels.discord || {};
    config.channels.discord.token = process.env.DISCORD_BOT_TOKEN;
    config.channels.discord.enabled = true;
    config.channels.discord.dmPolicy = process.env.DISCORD_DM_POLICY || 'pairing';
    // Remove legacy 'dm' key that clawdbot doesn't recognize
    delete config.channels.discord.dm;
}

// Slack configuration
if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    config.channels.slack = config.channels.slack || {};
    config.channels.slack.botToken = process.env.SLACK_BOT_TOKEN;
    config.channels.slack.appToken = process.env.SLACK_APP_TOKEN;
    config.channels.slack.enabled = true;
}

// Base URL override (e.g., for Cloudflare AI Gateway)
// Usage: Set AI_GATEWAY_BASE_URL or ANTHROPIC_BASE_URL to your endpoint like:
//   https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/anthropic
//   https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/openai
const baseUrl = process.env.AI_GATEWAY_BASE_URL || process.env.ANTHROPIC_BASE_URL || '';
const isOpenAI = baseUrl.endsWith('/openai');

if (isOpenAI) {
    // Create custom openai provider config with baseUrl override
    // Omit apiKey so moltbot falls back to OPENAI_API_KEY env var
    console.log('Configuring OpenAI provider with base URL:', baseUrl);
    config.models = config.models || {};
    config.models.providers = config.models.providers || {};
    config.models.providers.openai = {
        baseUrl: baseUrl,
        api: 'openai-responses',
        models: [
            { id: 'gpt-5.2', name: 'GPT-5.2', contextWindow: 200000 },
            { id: 'gpt-5', name: 'GPT-5', contextWindow: 200000 },
            { id: 'gpt-4.5-preview', name: 'GPT-4.5 Preview', contextWindow: 128000 },
        ]
    };
    // Add models to the allowlist so they appear in /models
    config.agents.defaults.models = config.agents.defaults.models || {};
    config.agents.defaults.models['openai/gpt-5.2'] = { alias: 'GPT-5.2' };
    config.agents.defaults.models['openai/gpt-5'] = { alias: 'GPT-5' };
    config.agents.defaults.models['openai/gpt-4.5-preview'] = { alias: 'GPT-4.5' };
    config.agents.defaults.model.primary = 'openai/gpt-5.2';
} else if (baseUrl) {
    console.log('Configuring Anthropic provider with base URL:', baseUrl);
    config.models = config.models || {};
    config.models.providers = config.models.providers || {};
    const providerConfig = {
        baseUrl: baseUrl,
        api: 'anthropic-messages',
        models: [
            { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5', contextWindow: 200000 },
            { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', contextWindow: 200000 },
            { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', contextWindow: 200000 },
        ]
    };
    // Include API key in provider config if set (required when using custom baseUrl)
    // Priority: CLAUDE_CODE_OAUTH_TOKEN > ANTHROPIC_API_KEY
    const apiKey = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
        providerConfig.apiKey = apiKey;
        console.log('[CONFIG] Using API key:', apiKey.startsWith('sk-ant-oat') ? 'OAuth token' : 'API key');
    }
    config.models.providers.anthropic = providerConfig;
    // Add models to the allowlist so they appear in /models
    config.agents.defaults.models = config.agents.defaults.models || {};
    config.agents.defaults.models['anthropic/claude-opus-4-5-20251101'] = { alias: 'Opus 4.5' };
    config.agents.defaults.models['anthropic/claude-sonnet-4-5-20250929'] = { alias: 'Sonnet 4.5' };
    config.agents.defaults.models['anthropic/claude-haiku-4-5-20251001'] = { alias: 'Haiku 4.5' };
    config.agents.defaults.model.primary = 'anthropic/claude-opus-4-5-20251101';
} else {
    // Default to Anthropic without custom base URL (uses built-in pi-ai catalog)
    config.agents.defaults.model.primary = 'anthropic/claude-opus-4-5';
}

// Write updated config
try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log('[CONFIG] Configuration updated successfully');

    // Write status file for diagnostics
    const status = {
        success: true,
        timestamp: new Date().toISOString(),
        configLoadError: configLoadError,
        hasApiKey: !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY),
        apiKeyType: process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'oauth' : (process.env.ANTHROPIC_API_KEY ? 'api-key' : 'none'),
        hasGatewayToken: !!(process.env.CLAWDBOT_GATEWAY_TOKEN),
        hasTelegram: !!(process.env.TELEGRAM_BOT_TOKEN),
        hasDiscord: !!(process.env.DISCORD_BOT_TOKEN),
        hasSlack: !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN),
        baseUrl: process.env.AI_GATEWAY_BASE_URL || process.env.ANTHROPIC_BASE_URL || 'default',
    };
    fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
} catch (writeErr) {
    console.error('[CONFIG] Failed to write config:', writeErr.message);
    // Write failure status
    try {
        const status = {
            success: false,
            timestamp: new Date().toISOString(),
            error: writeErr.message,
        };
        fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
    } catch {}
    process.exit(1);
}
EOFNODE

if [ "$CONFIG_UPDATE_SUCCESS" != "true" ]; then
    log_error "Config update failed - gateway may not start correctly"
fi

# ============================================================
# SUPERMOLTWORKER: CONFLICT DETECTION
# ============================================================
# Detect and optionally auto-fix configuration conflicts
# Set CONFLICT_AUTO_FIX=true to automatically fix detected conflicts

if [ -f "$CONFIG_FILE" ]; then
    echo "Running conflict detection..."
    if [ "$CONFLICT_AUTO_FIX" = "true" ]; then
        node /usr/local/bin/conflict-detector.js --auto-fix || echo "Warning: Conflict detection failed (non-fatal)"
    else
        node /usr/local/bin/conflict-detector.js || echo "Warning: Conflict detection failed (non-fatal)"
    fi
fi

# ============================================================
# SUPERMOLTWORKER: CREATE STARTUP SNAPSHOT
# ============================================================
# Create an automatic snapshot before starting the gateway
# This allows recovery if something goes wrong during this session
# Set AUTO_SNAPSHOT=false to disable this behavior

if [ "$AUTO_SNAPSHOT" != "false" ] && [ -d "$BACKUP_DIR" ]; then
    echo "Creating pre-startup snapshot..."
    if node /usr/local/bin/snapshot-creator.js --trigger auto --description "Auto snapshot at container startup"; then
        echo "Startup snapshot created successfully"
    else
        echo "Warning: Failed to create startup snapshot (non-fatal)"
    fi
else
    if [ "$AUTO_SNAPSHOT" = "false" ]; then
        echo "Auto snapshot disabled by AUTO_SNAPSHOT=false"
    else
        echo "Skipping snapshot (R2 not mounted)"
    fi
fi

# ============================================================
# WRITE STARTUP STATUS
# ============================================================
# Record startup status for diagnostics
cat > "$STATUS_FILE" << EOFSTATUS
{
  "startupTime": "$(date -Iseconds)",
  "r2Mounted": $([ -d "$BACKUP_DIR" ] && echo "true" || echo "false"),
  "r2RestoreSuccess": $R2_RESTORE_SUCCESS,
  "configUpdateSuccess": $CONFIG_UPDATE_SUCCESS,
  "warnings": "$STARTUP_WARNINGS",
  "errors": "$STARTUP_ERRORS"
}
EOFSTATUS

# Log any accumulated warnings/errors
if [ -n "$STARTUP_WARNINGS" ]; then
    log_warning "Startup completed with warnings"
fi
if [ -n "$STARTUP_ERRORS" ]; then
    log_error "Startup completed with errors - gateway may not function correctly"
fi

# ============================================================
# START GATEWAY
# ============================================================
# Note: R2 backup sync is handled by the Worker's cron trigger
log_info "Starting Moltbot Gateway..."
log_info "Gateway will be available on port 18789"

# Clean up stale lock files
rm -f /tmp/clawdbot-gateway.lock 2>/dev/null || true
rm -f "$CONFIG_DIR/gateway.lock" 2>/dev/null || true

BIND_MODE="lan"
log_info "Dev mode: ${CLAWDBOT_DEV_MODE:-false}, Bind mode: $BIND_MODE"

if [ -n "$CLAWDBOT_GATEWAY_TOKEN" ]; then
    log_info "Starting gateway with token auth..."
    exec clawdbot gateway --port 18789 --verbose --allow-unconfigured --bind "$BIND_MODE" --token "$CLAWDBOT_GATEWAY_TOKEN"
else
    log_warning "No gateway token set - using device pairing mode"
    exec clawdbot gateway --port 18789 --verbose --allow-unconfigured --bind "$BIND_MODE"
fi
