/**
 * SuperMoltWorker Risk Analyzer
 *
 * Analyzes configuration changes to determine risk level.
 * Used by the evolution protection system to decide whether to
 * auto-approve, warn, or require explicit user confirmation.
 */

/**
 * Risk levels for configuration changes
 */
export type RiskLevel = 'safe' | 'medium' | 'high';

/**
 * Change detection result
 */
export interface ConfigChange {
  path: string;           // JSON path, e.g., "models.providers.anthropic.baseUrl"
  oldValue: unknown;
  newValue: unknown;
  changeType: 'add' | 'modify' | 'delete';
}

/**
 * Risk analysis result
 */
export interface RiskAnalysis {
  overallRisk: RiskLevel;
  changes: ConfigChange[];
  risks: {
    path: string;
    level: RiskLevel;
    reason: string;
  }[];
  summary: string;
  requiresConfirmation: boolean;
}

/**
 * Risk rules for different config paths
 */
interface RiskRule {
  pattern: RegExp;
  riskLevel: RiskLevel;
  reason: string;
}

/**
 * Risk rules configuration
 *
 * 🟢 Safe:
 *   - New skills
 *   - Workspace path changes
 *   - Agent defaults (non-model)
 *
 * 🟡 Medium:
 *   - Gateway settings
 *   - Channel configurations
 *   - Model defaults
 *
 * 🔴 High:
 *   - Provider configurations
 *   - Authentication settings
 *   - Deleting major sections
 */
const RISK_RULES: RiskRule[] = [
  // High risk - Authentication and providers
  {
    pattern: /^models\.providers\./,
    riskLevel: 'high',
    reason: 'Modifying AI provider configuration can break model access',
  },
  {
    pattern: /^gateway\.auth/,
    riskLevel: 'high',
    reason: 'Authentication changes can lock out users',
  },
  {
    pattern: /^gateway\.token/,
    riskLevel: 'high',
    reason: 'Token changes can lock out clients',
  },
  {
    pattern: /apiKey$/i,
    riskLevel: 'high',
    reason: 'API key changes can break external service access',
  },
  {
    pattern: /baseUrl$/i,
    riskLevel: 'high',
    reason: 'Endpoint changes can route requests to wrong servers',
  },

  // Medium risk - Gateway and channels
  {
    pattern: /^gateway\./,
    riskLevel: 'medium',
    reason: 'Gateway configuration affects all connections',
  },
  {
    pattern: /^channels\./,
    riskLevel: 'medium',
    reason: 'Channel changes affect messaging integrations',
  },
  {
    pattern: /^agents\.defaults\.model/,
    riskLevel: 'medium',
    reason: 'Default model changes affect AI behavior',
  },
  {
    pattern: /^agents\.defaults\.models/,
    riskLevel: 'medium',
    reason: 'Model allowlist changes affect available models',
  },

  // Safe - General settings
  {
    pattern: /^agents\.defaults\.workspace/,
    riskLevel: 'safe',
    reason: 'Workspace path change',
  },
  {
    pattern: /^agents\.defaults\./,
    riskLevel: 'safe',
    reason: 'Agent default setting change',
  },
];

/**
 * Get all keys from an object recursively with dot notation
 */
function getAllPaths(obj: unknown, prefix = ''): string[] {
  const paths: string[] = [];

  if (obj === null || typeof obj !== 'object') {
    return paths;
  }

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    paths.push(path);

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      paths.push(...getAllPaths(value, path));
    }
  }

  return paths;
}

/**
 * Get value at a path from an object
 */
function getValueAtPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current = obj as Record<string, unknown>;

  for (const part of parts) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = current[part] as Record<string, unknown>;
  }

  return current;
}

/**
 * Compare two configs and detect changes
 */
export function detectChanges(
  oldConfig: Record<string, unknown>,
  newConfig: Record<string, unknown>
): ConfigChange[] {
  const changes: ConfigChange[] = [];

  const oldPaths = new Set(getAllPaths(oldConfig));
  const newPaths = new Set(getAllPaths(newConfig));

  // Find added paths
  for (const path of newPaths) {
    if (!oldPaths.has(path)) {
      changes.push({
        path,
        oldValue: undefined,
        newValue: getValueAtPath(newConfig, path),
        changeType: 'add',
      });
    }
  }

  // Find removed paths
  for (const path of oldPaths) {
    if (!newPaths.has(path)) {
      changes.push({
        path,
        oldValue: getValueAtPath(oldConfig, path),
        newValue: undefined,
        changeType: 'delete',
      });
    }
  }

  // Find modified values
  for (const path of oldPaths) {
    if (newPaths.has(path)) {
      const oldValue = getValueAtPath(oldConfig, path);
      const newValue = getValueAtPath(newConfig, path);

      // Only compare leaf values
      if (typeof oldValue !== 'object' || typeof newValue !== 'object') {
        if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
          changes.push({
            path,
            oldValue,
            newValue,
            changeType: 'modify',
          });
        }
      }
    }
  }

  return changes;
}

/**
 * Determine risk level for a single path
 */
function getRiskForPath(path: string, changeType: ConfigChange['changeType']): {
  level: RiskLevel;
  reason: string;
} {
  // Deletions of major sections are always high risk
  if (changeType === 'delete') {
    const topLevel = path.split('.')[0];
    if (['models', 'gateway', 'channels', 'agents'].includes(topLevel) && !path.includes('.')) {
      return {
        level: 'high',
        reason: `Deleting entire ${topLevel} section`,
      };
    }
  }

  // Check against rules
  for (const rule of RISK_RULES) {
    if (rule.pattern.test(path)) {
      return {
        level: rule.riskLevel,
        reason: rule.reason,
      };
    }
  }

  // Default to safe for unmatched paths
  return {
    level: 'safe',
    reason: 'Standard configuration change',
  };
}

/**
 * Analyze risk of configuration changes
 */
export function analyzeRisk(
  oldConfig: Record<string, unknown>,
  newConfig: Record<string, unknown>
): RiskAnalysis {
  const changes = detectChanges(oldConfig, newConfig);

  if (changes.length === 0) {
    return {
      overallRisk: 'safe',
      changes: [],
      risks: [],
      summary: 'No changes detected',
      requiresConfirmation: false,
    };
  }

  const risks: RiskAnalysis['risks'] = [];
  let highRiskCount = 0;
  let mediumRiskCount = 0;

  for (const change of changes) {
    const { level, reason } = getRiskForPath(change.path, change.changeType);

    risks.push({
      path: change.path,
      level,
      reason,
    });

    if (level === 'high') highRiskCount++;
    if (level === 'medium') mediumRiskCount++;
  }

  // Determine overall risk
  let overallRisk: RiskLevel = 'safe';
  if (highRiskCount > 0) {
    overallRisk = 'high';
  } else if (mediumRiskCount > 0) {
    overallRisk = 'medium';
  }

  // Generate summary
  const parts: string[] = [];
  if (highRiskCount > 0) parts.push(`${highRiskCount} high-risk`);
  if (mediumRiskCount > 0) parts.push(`${mediumRiskCount} medium-risk`);
  const safeCount = changes.length - highRiskCount - mediumRiskCount;
  if (safeCount > 0) parts.push(`${safeCount} safe`);

  const summary = `${changes.length} change(s): ${parts.join(', ')}`;

  return {
    overallRisk,
    changes,
    risks,
    summary,
    requiresConfirmation: overallRisk === 'high' || overallRisk === 'medium',
  };
}

/**
 * Quick check if changes require confirmation
 */
export function requiresConfirmation(
  oldConfig: Record<string, unknown>,
  newConfig: Record<string, unknown>
): boolean {
  const changes = detectChanges(oldConfig, newConfig);

  for (const change of changes) {
    const { level } = getRiskForPath(change.path, change.changeType);
    if (level === 'high' || level === 'medium') {
      return true;
    }
  }

  return false;
}

/**
 * Get a human-readable description of a change
 */
export function describeChange(change: ConfigChange): string {
  const action = change.changeType === 'add' ? 'Added' :
                 change.changeType === 'delete' ? 'Removed' : 'Changed';

  if (change.changeType === 'modify') {
    // Truncate long values
    const oldStr = JSON.stringify(change.oldValue);
    const newStr = JSON.stringify(change.newValue);
    const old = oldStr.length > 50 ? oldStr.slice(0, 47) + '...' : oldStr;
    const newVal = newStr.length > 50 ? newStr.slice(0, 47) + '...' : newStr;
    return `${action} ${change.path}: ${old} -> ${newVal}`;
  }

  return `${action} ${change.path}`;
}

/**
 * Generate a diff-like string for changes
 */
export function generateDiffString(changes: ConfigChange[]): string {
  const lines: string[] = [];

  for (const change of changes) {
    switch (change.changeType) {
      case 'add':
        lines.push(`+ ${change.path}: ${JSON.stringify(change.newValue)}`);
        break;
      case 'delete':
        lines.push(`- ${change.path}: ${JSON.stringify(change.oldValue)}`);
        break;
      case 'modify':
        lines.push(`- ${change.path}: ${JSON.stringify(change.oldValue)}`);
        lines.push(`+ ${change.path}: ${JSON.stringify(change.newValue)}`);
        break;
    }
  }

  return lines.join('\n');
}
