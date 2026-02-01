/**
 * SuperMoltWorker Health API
 *
 * REST API for health checks and self-repair operations.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { quickHealthCheck, fullHealthCheck, repairHealthIssues, getCriticalAlerts } from '../gateway/health-check';
import { detectConflicts, autoFixConflicts } from '../gateway/conflict-detector';
import { notifyHealthWarning, notifyConflictDetected } from '../gateway/notification';

const healthApi = new Hono<AppEnv>();

/**
 * GET /api/admin/health - Full health check
 */
healthApi.get('/', async (c) => {
  const sandbox = c.get('sandbox');
  const report = await fullHealthCheck(sandbox, c.env);

  // Send notification if unhealthy
  if (report.overall === 'unhealthy') {
    notifyHealthWarning(report);
  }

  return c.json({
    success: true,
    ...report,
  });
});

/**
 * GET /api/admin/health/alerts - Get critical alerts that need user attention
 * This endpoint is lightweight and does not require sandbox access.
 */
healthApi.get('/alerts', (c) => {
  const alerts = getCriticalAlerts(c.env);

  return c.json({
    success: true,
    hasAlerts: alerts.length > 0,
    alertCount: alerts.length,
    alerts,
  });
});

/**
 * GET /api/admin/health/quick - Quick health check
 */
healthApi.get('/quick', async (c) => {
  const sandbox = c.get('sandbox');
  const result = await quickHealthCheck(sandbox, c.env);

  return c.json({
    success: true,
    ...result,
  });
});

/**
 * POST /api/admin/health/repair - Attempt to repair health issues
 */
healthApi.post('/repair', async (c) => {
  const sandbox = c.get('sandbox');

  // First run a full health check
  const report = await fullHealthCheck(sandbox, c.env);

  if (report.overall === 'healthy') {
    return c.json({
      success: true,
      message: 'No issues to repair',
      report,
    });
  }

  if (!report.autoRepairAvailable) {
    return c.json({
      success: false,
      message: 'No auto-repairable issues found',
      report,
    }, 400);
  }

  // Attempt repairs
  const repairResult = await repairHealthIssues(sandbox, c.env, report);

  // Run health check again to verify
  const newReport = await fullHealthCheck(sandbox, c.env);

  return c.json({
    success: repairResult.success,
    repair: repairResult,
    previousStatus: report.overall,
    currentStatus: newReport.overall,
    report: newReport,
  });
});

/**
 * GET /api/admin/conflicts - Run conflict detection
 */
healthApi.get('/conflicts', async (c) => {
  const sandbox = c.get('sandbox');
  const report = await detectConflicts(sandbox, c.env);

  // Send notification if conflicts found
  if (report.hasConflicts && report.summary.errors > 0) {
    notifyConflictDetected(report);
  }

  return c.json({
    success: true,
    ...report,
  });
});

/**
 * POST /api/admin/conflicts/auto-fix - Auto-fix detected conflicts
 */
healthApi.post('/conflicts/auto-fix', async (c) => {
  const sandbox = c.get('sandbox');

  // First run conflict detection
  const report = await detectConflicts(sandbox, c.env);

  if (!report.hasConflicts) {
    return c.json({
      success: true,
      message: 'No conflicts to fix',
      report,
    });
  }

  if (report.summary.autoFixable === 0) {
    return c.json({
      success: false,
      message: 'No auto-fixable conflicts found',
      report,
    }, 400);
  }

  // Attempt auto-fix
  const fixResult = await autoFixConflicts(sandbox, c.env, report);

  // Run conflict detection again to verify
  const newReport = await detectConflicts(sandbox, c.env);

  return c.json({
    success: fixResult.success,
    fix: fixResult,
    previousConflicts: report.summary.total,
    currentConflicts: newReport.summary.total,
    report: newReport,
  });
});

/**
 * GET /api/admin/health/summary - Get combined health and conflict summary
 */
healthApi.get('/summary', async (c) => {
  const sandbox = c.get('sandbox');

  // Run both checks in parallel
  const [healthReport, conflictReport] = await Promise.all([
    fullHealthCheck(sandbox, c.env),
    detectConflicts(sandbox, c.env),
  ]);

  // Determine overall system status
  let overallStatus: 'healthy' | 'degraded' | 'critical' = 'healthy';

  if (healthReport.overall === 'unhealthy' || conflictReport.summary.errors > 0) {
    overallStatus = 'critical';
  } else if (healthReport.overall === 'degraded' || conflictReport.summary.warnings > 0) {
    overallStatus = 'degraded';
  }

  return c.json({
    success: true,
    overallStatus,
    health: {
      status: healthReport.overall,
      issueCount: healthReport.issues.length,
      autoRepairAvailable: healthReport.autoRepairAvailable,
    },
    conflicts: {
      hasConflicts: conflictReport.hasConflicts,
      total: conflictReport.summary.total,
      errors: conflictReport.summary.errors,
      warnings: conflictReport.summary.warnings,
      autoFixable: conflictReport.summary.autoFixable,
    },
    recommendations: [
      ...healthReport.issues.map(i => i.suggestion),
      ...conflictReport.recommendations,
    ],
    timestamp: new Date().toISOString(),
  });
});

export { healthApi };
