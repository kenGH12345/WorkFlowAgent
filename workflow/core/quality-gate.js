/**
 * Quality Gate – Automated run validation against quality thresholds
 *
 * Extracted from SelfReflectionEngine (A-1 architecture fix: God Object decomposition).
 * Encapsulates all quality gate evaluation logic: error count, test pass rate,
 * duration, LLM call count, and token waste ratio.
 *
 * Integration: receives a `recordIssue(opts)` callback from SelfReflectionEngine
 * so gate failures are still recorded as reflections.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { ReflectionType, ReflectionSeverity } = require('./self-reflection-types');

const DEFAULT_QUALITY_GATES = {
  maxErrorCount:       3,
  maxTokenWasteRatio:  0.35,
  minTestPassRate:     0.70,
  maxDurationMs:       600000,
  maxLlmCalls:         15,
  maxPluginSkipRatio:  0.80,
  minPluginSkipRatio:  0.10,
};

class QualityGate {
  /**
   * @param {object} options
   * @param {object}   [options.qualityGates] - Override default quality gate thresholds
   * @param {Function} options.recordIssue     - Callback: (opts) => ReflectionEntry
   */
  constructor(options = {}) {
    this._gates = { ...DEFAULT_QUALITY_GATES, ...options.qualityGates };
    this._recordIssue = options.recordIssue;
  }

  /**
   * Validates a completed workflow run against quality gates.
   *
   * @param {object} metrics - From Observability.flush()
   * @returns {{ passed: boolean, gates: Array<{ name: string, passed: boolean, actual: any, threshold: any, message: string }>, reflections: object[] }}
   */
  validate(metrics) {
    if (!metrics) return { passed: true, gates: [], reflections: [] };

    const gates = [];
    const reflections = [];
    const g = this._gates;

    // Gate 1: Error count
    const errorCount = metrics.errors?.count || 0;
    gates.push({
      name: 'maxErrorCount',
      passed: errorCount <= g.maxErrorCount,
      actual: errorCount,
      threshold: g.maxErrorCount,
      message: errorCount <= g.maxErrorCount
        ? `Errors within limit (${errorCount} ≤ ${g.maxErrorCount})`
        : `Error count exceeded (${errorCount} > ${g.maxErrorCount})`,
    });

    // Gate 2: Test pass rate
    if (metrics.testResult) {
      const { passed: tp = 0, failed: tf = 0 } = metrics.testResult;
      const total = tp + tf;
      const passRate = total > 0 ? tp / total : 1;
      gates.push({
        name: 'minTestPassRate',
        passed: passRate >= g.minTestPassRate,
        actual: `${(passRate * 100).toFixed(0)}%`,
        threshold: `${(g.minTestPassRate * 100).toFixed(0)}%`,
        message: passRate >= g.minTestPassRate
          ? `Test pass rate OK (${(passRate * 100).toFixed(0)}% ≥ ${(g.minTestPassRate * 100).toFixed(0)}%)`
          : `Test pass rate too low (${(passRate * 100).toFixed(0)}% < ${(g.minTestPassRate * 100).toFixed(0)}%)`,
      });
    }

    // Gate 3: Duration
    const duration = metrics.totalDurationMs || 0;
    gates.push({
      name: 'maxDurationMs',
      passed: duration <= g.maxDurationMs,
      actual: `${(duration / 1000).toFixed(1)}s`,
      threshold: `${(g.maxDurationMs / 1000).toFixed(1)}s`,
      message: duration <= g.maxDurationMs
        ? `Duration within limit (${(duration / 1000).toFixed(1)}s ≤ ${(g.maxDurationMs / 1000).toFixed(1)}s)`
        : `Duration exceeded (${(duration / 1000).toFixed(1)}s > ${(g.maxDurationMs / 1000).toFixed(1)}s)`,
    });

    // Gate 4: LLM call count (detect retry storms)
    const llmCalls = metrics.llm?.totalCalls || 0;
    gates.push({
      name: 'maxLlmCalls',
      passed: llmCalls <= g.maxLlmCalls,
      actual: llmCalls,
      threshold: g.maxLlmCalls,
      message: llmCalls <= g.maxLlmCalls
        ? `LLM calls within limit (${llmCalls} ≤ ${g.maxLlmCalls})`
        : `LLM call count high — possible retry storm (${llmCalls} > ${g.maxLlmCalls})`,
    });

    // Gate 5: Token waste ratio (if blockTelemetry available)
    if (metrics.blockTelemetry?.summary) {
      const { totalInjected = 0, totalDropped = 0 } = metrics.blockTelemetry.summary;
      const wasteRatio = totalInjected > 0 ? totalDropped / totalInjected : 0;
      gates.push({
        name: 'maxTokenWasteRatio',
        passed: wasteRatio <= g.maxTokenWasteRatio,
        actual: `${(wasteRatio * 100).toFixed(0)}%`,
        threshold: `${(g.maxTokenWasteRatio * 100).toFixed(0)}%`,
        message: wasteRatio <= g.maxTokenWasteRatio
          ? `Token waste acceptable (${(wasteRatio * 100).toFixed(0)}% ≤ ${(g.maxTokenWasteRatio * 100).toFixed(0)}%)`
          : `Token waste too high (${(wasteRatio * 100).toFixed(0)}% > ${(g.maxTokenWasteRatio * 100).toFixed(0)}%)`,
      });
    }

    // Gate 6: File size compliance (architecture-constraints.md)
    // Checks that workflow source files stay within their line-count budgets.
    // This is a WARNING-level gate — it does not block the workflow, but
    // generates a reflection so MAPE/Agent can address it.
    if (metrics.projectRoot) {
      const violations = QualityGate._checkFileSizeCompliance(metrics.projectRoot);
      const fileSizePassed = violations.length === 0;
      gates.push({
        name: 'fileSizeCompliance',
        passed: fileSizePassed,
        actual: fileSizePassed ? '0 violations' : `${violations.length} file(s) over limit`,
        threshold: '0 violations',
        message: fileSizePassed
          ? 'All files within architecture line-count limits'
          : `File size violations: ${violations.map(v => `${v.file} (${v.lines}/${v.limit})`).join(', ')}`,
      });
    }

    // Record reflections for failed gates
    const failedGates = gates.filter(gt => !gt.passed);
    for (const fg of failedGates) {
      reflections.push(this._recordIssue({
        type: ReflectionType.QUALITY_GATE_FAIL,
        severity: fg.name === 'maxErrorCount' || fg.name === 'minTestPassRate'
          ? ReflectionSeverity.HIGH
          : ReflectionSeverity.MEDIUM,
        title: `Quality gate breached: ${fg.name}`,
        description: fg.message,
        source: 'gating:validateRun',
        patternKey: `gate-fail:${fg.name}`,
        metrics: { actual: fg.actual, threshold: fg.threshold },
      }));
    }

    const passed = failedGates.length === 0;
    if (passed) {
      console.log(`[QualityGate] ✅ All ${gates.length} quality gates passed.`);
    } else {
      console.warn(`[QualityGate] ❌ ${failedGates.length} of ${gates.length} quality gates failed: [${failedGates.map(gt => gt.name).join(', ')}]`);
    }

    return { passed, gates, reflections };
  }

  // ─── File Size Compliance Check ───────────────────────────────────────

  /**
   * Scans workflow source files and checks line counts against
   * architecture-constraints.md limits.
   *
   * Rules (from architecture-constraints.md):
   *   - index.js: 600 lines
   *   - core/*.js: 400 lines
   *   - agents/*.js: 300 lines
   *   - commands/command-router.js: 100 lines
   *   - commands/commands-*.js: 500 lines
   *
   * @param {string} projectRoot — Project root directory
   * @returns {Array<{ file: string, lines: number, limit: number }>}
   */
  static _checkFileSizeCompliance(projectRoot) {
    const workflowDir = path.join(projectRoot, 'workflow');
    if (!fs.existsSync(workflowDir)) return [];

    const FILE_SIZE_RULES = [
      { pattern: /^index\.js$/,               limit: 600 },
      { pattern: /^core\/[^/]+\.js$/,         limit: 400 },
      { pattern: /^agents\/[^/]+\.js$/,       limit: 300 },
      { pattern: /^commands\/command-router\.js$/, limit: 100 },
      { pattern: /^commands\/commands-[^/]+\.js$/, limit: 500 },
    ];

    const violations = [];

    const scanDir = (dir, relBase) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.join(relBase, entry.name).replace(/\\/g, '/');
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          scanDir(fullPath, relPath);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
          for (const rule of FILE_SIZE_RULES) {
            if (rule.pattern.test(relPath)) {
              try {
                const content = fs.readFileSync(fullPath, 'utf-8');
                const lineCount = content.split('\n').length;
                if (lineCount > rule.limit) {
                  violations.push({ file: `workflow/${relPath}`, lines: lineCount, limit: rule.limit });
                }
              } catch (_) { /* non-fatal */ }
              break; // Only match first rule
            }
          }
        }
      }
    };

    scanDir(workflowDir, '');
    return violations;
  }
}

module.exports = { QualityGate, DEFAULT_QUALITY_GATES };
