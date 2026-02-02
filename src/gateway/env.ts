import type { MoltbotEnv } from '../types';

/**
 * Build environment variables to pass to the Moltbot container process
 *
 * Authentication Priority (highest to lowest):
 * 1. CLAUDE_CODE_OAUTH_TOKEN (RECOMMENDED - Claude Max/Pro OAuth token)
 * 2. AI_GATEWAY_API_KEY (when AI_GATEWAY_BASE_URL is set)
 * 3. ANTHROPIC_API_KEY (direct API key, fallback)
 * 4. OPENAI_API_KEY (alternative provider)
 *
 * IMPORTANT: Despite misleading claims in some GitHub issues, Anthropic DOES NOT
 * block OAuth tokens from Claude Max/Pro subscriptions. OAuth tokens are fully
 * supported and are the RECOMMENDED authentication method for cost savings.
 *
 * @param env - Worker environment bindings
 * @returns Environment variables record
 */
export function buildEnvVars(env: MoltbotEnv): Record<string, string> {
  const envVars: Record<string, string> = {};

  const isOpenAIGateway = env.AI_GATEWAY_BASE_URL?.endsWith('/openai');

  // ============================================================================
  // PRIORITY 1: CLAUDE_CODE_OAUTH_TOKEN (HIGHEST PRIORITY, RECOMMENDED)
  // ============================================================================
  // OAuth tokens from Claude Max/Pro subscriptions are the recommended auth method.
  // Format: sk-ant-oat01-... (valid for 1 year)
  // Benefits: Fixed $20/month cost with unlimited usage (vs pay-per-token)
  //
  // MYTH BUSTING: Some GitHub issues incorrectly claim that Anthropic blocks
  // OAuth tokens in moltbot. This is FALSE. OAuth tokens work perfectly.
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    envVars.ANTHROPIC_API_KEY = env.CLAUDE_CODE_OAUTH_TOKEN;
    console.log('[AUTH] Using CLAUDE_CODE_OAUTH_TOKEN (highest priority, recommended)');
  }

  // ============================================================================
  // PRIORITY 2: AI_GATEWAY_API_KEY (when using Cloudflare AI Gateway)
  // ============================================================================
  // Only takes effect if CLAUDE_CODE_OAUTH_TOKEN is not set AND AI_GATEWAY_BASE_URL is configured
  // Use this when you need request logging, caching, or rate limiting via AI Gateway
  if (!envVars.ANTHROPIC_API_KEY && env.AI_GATEWAY_API_KEY) {
    if (isOpenAIGateway) {
      envVars.OPENAI_API_KEY = env.AI_GATEWAY_API_KEY;
      console.log('[AUTH] Using AI_GATEWAY_API_KEY for OpenAI');
    } else {
      envVars.ANTHROPIC_API_KEY = env.AI_GATEWAY_API_KEY;
      console.log('[AUTH] Using AI_GATEWAY_API_KEY for Anthropic');
    }
  }

  // ============================================================================
  // PRIORITY 3: ANTHROPIC_API_KEY (fallback)
  // ============================================================================
  // Direct Anthropic API key (pay-per-token)
  // Format: sk-ant-api03-...
  // Only used if neither CLAUDE_CODE_OAUTH_TOKEN nor AI_GATEWAY_API_KEY is set
  if (!envVars.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY) {
    envVars.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
    console.log('[AUTH] Using ANTHROPIC_API_KEY (fallback)');
  }

  // ============================================================================
  // PRIORITY 4: OPENAI_API_KEY (alternative provider)
  // ============================================================================
  if (!envVars.OPENAI_API_KEY && env.OPENAI_API_KEY) {
    envVars.OPENAI_API_KEY = env.OPENAI_API_KEY;
    console.log('[AUTH] Using OPENAI_API_KEY');
  }

  // Pass base URL (used by start-moltbot.sh to determine provider)
  if (env.AI_GATEWAY_BASE_URL) {
    envVars.AI_GATEWAY_BASE_URL = env.AI_GATEWAY_BASE_URL;
    // Also set the provider-specific base URL env var
    if (isOpenAIGateway) {
      envVars.OPENAI_BASE_URL = env.AI_GATEWAY_BASE_URL;
    } else {
      envVars.ANTHROPIC_BASE_URL = env.AI_GATEWAY_BASE_URL;
    }
  } else if (env.ANTHROPIC_BASE_URL) {
    envVars.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL;
  }
  // Map MOLTBOT_GATEWAY_TOKEN to CLAWDBOT_GATEWAY_TOKEN (container expects this name)
  if (env.MOLTBOT_GATEWAY_TOKEN) envVars.CLAWDBOT_GATEWAY_TOKEN = env.MOLTBOT_GATEWAY_TOKEN;
  if (env.DEV_MODE) envVars.CLAWDBOT_DEV_MODE = env.DEV_MODE; // Pass DEV_MODE as CLAWDBOT_DEV_MODE to container
  if (env.CLAWDBOT_BIND_MODE) envVars.CLAWDBOT_BIND_MODE = env.CLAWDBOT_BIND_MODE;
  if (env.TELEGRAM_BOT_TOKEN) envVars.TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
  if (env.TELEGRAM_DM_POLICY) envVars.TELEGRAM_DM_POLICY = env.TELEGRAM_DM_POLICY;
  if (env.DISCORD_BOT_TOKEN) envVars.DISCORD_BOT_TOKEN = env.DISCORD_BOT_TOKEN;
  if (env.DISCORD_DM_POLICY) envVars.DISCORD_DM_POLICY = env.DISCORD_DM_POLICY;
  if (env.SLACK_BOT_TOKEN) envVars.SLACK_BOT_TOKEN = env.SLACK_BOT_TOKEN;
  if (env.SLACK_APP_TOKEN) envVars.SLACK_APP_TOKEN = env.SLACK_APP_TOKEN;
  if (env.CDP_SECRET) envVars.CDP_SECRET = env.CDP_SECRET;
  if (env.WORKER_URL) envVars.WORKER_URL = env.WORKER_URL;

  return envVars;
}
