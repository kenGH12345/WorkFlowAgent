/**
 * Observability – Runtime metrics collection for the workflow.
 *
 * Tracks per-stage timing, LLM call counts, estimated token usage,
 * error counts, and test results. Writes a structured JSON report to
 * output/run-metrics.json at the end of each session.
 *
 * Cross-session history: appends each session record to
 * output/metrics-history.jsonl (one JSON object per line) for trend analysis.
 * Use Observability.loadHistory() to read and analyse historical data.
 *
 * Design: zero-dependency, zero-side-effect on existing code.
 * Integration: Orchestrator calls obs.stageStart/stageEnd around each
 * _runStage call, and obs.recordLlmCall inside the wrappedLlm closure.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

class Observability {
  /**
   * @param {string} outputDir  - Directory to write run-metrics.json
   * @param {string} projectId  - Project identifier
   */
  constructor(outputDir, projectId) {
    this._outputDir  = outputDir;
    this._projectId  = projectId;
    this._sessionId  = `${projectId}-${Date.now()}`;
    this._startedAt  = Date.now();

    /** @type {Map<string, {start:number, end?:number, status?:string}>} */
    this._stages = new Map();

    /** @type {{role:string, estimatedTokens:number, ts:number}[]} */
    this._llmCalls = [];

    /** @type {{stage:string, message:string, ts:number}[]} */
    this._errors = [];

    /** @type {{passed:number, failed:number, skipped:number, rounds:number}|null} */
    this._testResult = null;

    /** @type {{violations:number, filesScanned:number, reportPath:string|null}|null} */
    this._entropyResult = null;

    /** @type {{status:string, provider:string, steps:object[], durationMs:number}|null} */
    this._ciResult = null;

    /** @type {{symbolCount:number, fileCount:number, edgeCount:number}|null} */
    this._codeGraphResult = null;
  }

  // ─── Stage Tracking ───────────────────────────────────────────────────────

  /** Mark the start of a workflow stage. */
  stageStart(stageName) {
    this._stages.set(stageName, { start: Date.now() });
  }

  /** Mark the end of a workflow stage with a status. */
  stageEnd(stageName, status = 'ok') {
    const entry = this._stages.get(stageName) || { start: Date.now() };
    entry.end    = Date.now();
    entry.status = status;
    entry.durationMs = entry.end - entry.start;
    this._stages.set(stageName, entry);
  }

  // ─── LLM Call Tracking ────────────────────────────────────────────────────

  /**
   * Record a single LLM call.
   * @param {string} role            - Agent role (analyst / architect / developer / tester)
   * @param {number} estimatedTokens - Token estimate from buildAgentPrompt
   */
  recordLlmCall(role, estimatedTokens = 0) {
    this._llmCalls.push({ role, estimatedTokens, ts: Date.now() });
  }

  // ─── Error Tracking ───────────────────────────────────────────────────────

  /** Record a workflow error. */
  recordError(stage, message) {
    this._errors.push({ stage, message, ts: Date.now() });
  }

  // ─── Test Result ──────────────────────────────────────────────────────────

  /** Record the final test execution result. */
  recordTestResult({ passed = 0, failed = 0, skipped = 0, rounds = 1 } = {}) {
    this._testResult = { passed, failed, skipped, rounds };
  }

  // ─── Entropy Result ───────────────────────────────────────────────────────

  /** Record the entropy GC scan result. */
  recordEntropyResult({ violations = 0, filesScanned = 0, reportPath = null } = {}) {
    this._entropyResult = { violations, filesScanned, reportPath };
  }

  /** Record the CI pipeline result. */
  recordCIResult({ status = 'unknown', provider = 'local', steps = [], durationMs = 0 } = {}) {
    this._ciResult = { status, provider, steps, durationMs };
  }

  /** Record the code graph build result. */
  recordCodeGraphResult({ symbolCount = 0, fileCount = 0, edgeCount = 0 } = {}) {
    this._codeGraphResult = { symbolCount, fileCount, edgeCount };
  }

  // ─── Report Generation ────────────────────────────────────────────────────

  /**
   * Builds the metrics object and writes it to output/run-metrics.json.
   * Safe to call multiple times (overwrites previous report for this session).
   * @returns {object} The metrics object
   */
  flush() {
    const totalMs      = Date.now() - this._startedAt;
    const totalTokens  = this._llmCalls.reduce((s, c) => s + c.estimatedTokens, 0);
    const callsByRole  = {};
    for (const c of this._llmCalls) {
      callsByRole[c.role] = (callsByRole[c.role] || 0) + 1;
    }

    const stagesArr = [];
    for (const [name, entry] of this._stages) {
      stagesArr.push({ name, ...entry });
    }

    const metrics = {
      sessionId:      this._sessionId,
      projectId:      this._projectId,
      startedAt:      new Date(this._startedAt).toISOString(),
      finishedAt:     new Date().toISOString(),
      totalDurationMs: totalMs,
      stages:         stagesArr,
      llm: {
        totalCalls:    this._llmCalls.length,
        totalTokensEst: totalTokens,
        callsByRole,
      },
      errors: {
        count:   this._errors.length,
        details: this._errors,
      },
      testResult:      this._testResult,
      entropyResult:   this._entropyResult,
      ciResult:        this._ciResult,
      codeGraphResult: this._codeGraphResult,
    };

    try {
      if (!fs.existsSync(this._outputDir)) {
        fs.mkdirSync(this._outputDir, { recursive: true });
      }
      // Overwrite latest session snapshot
      const outPath = path.join(this._outputDir, 'run-metrics.json');
      fs.writeFileSync(outPath, JSON.stringify(metrics, null, 2), 'utf-8');

      // Append to cross-session history (JSONL format)
      // ── Defect #6 fix: atomic append to metrics-history.jsonl ────────────────
      // Previously used appendFileSync() directly. If the process crashed mid-write,
      // a partial JSON line would be written, causing JSON.parse() to throw in
      // loadHistory() and silently returning [] (all history lost).
      // Fix: write the new line to a .tmp file first, then read-append-write the
      // full history file atomically via writeFileSync (overwrite). This ensures
      // the file is always a valid sequence of complete JSON lines.
      const historyPath = path.join(this._outputDir, 'metrics-history.jsonl');
      const historyLine = JSON.stringify({
        sessionId:       metrics.sessionId,
        projectId:       metrics.projectId,
        startedAt:       metrics.startedAt,
        totalDurationMs: metrics.totalDurationMs,
        llmCalls:        metrics.llm.totalCalls,
        tokensEst:       metrics.llm.totalTokensEst,
        errorCount:      metrics.errors.count,
        testPassed:      metrics.testResult?.passed ?? null,
        testFailed:      metrics.testResult?.failed ?? null,
        entropyViolations: metrics.entropyResult?.violations ?? null,
        ciStatus:        metrics.ciResult?.status ?? null,
        codeGraphSymbols: metrics.codeGraphResult?.symbolCount ?? null,
      }) + '\n';
      // Read existing history, append new line, write atomically
      const existingHistory = fs.existsSync(historyPath)
        ? fs.readFileSync(historyPath, 'utf-8')
        : '';
      const historyTmpPath = historyPath + '.tmp';
      fs.writeFileSync(historyTmpPath, existingHistory + historyLine, 'utf-8');
      fs.renameSync(historyTmpPath, historyPath);
    } catch (err) {
      console.warn(`[Observability] Failed to write metrics: ${err.message}`);
    }

    return metrics;
  }

  // ─── Cross-Session History Analysis ──────────────────────────────────────

  /**
   * Loads and parses the cross-session history from metrics-history.jsonl.
   * @returns {object[]} Array of session records (newest first)
   */
  static loadHistory(outputDir) {
    const historyPath = path.join(outputDir, 'metrics-history.jsonl');
    if (!fs.existsSync(historyPath)) return [];
    try {
      const lines = fs.readFileSync(historyPath, 'utf-8')
        .split('\n').filter(Boolean);
      return lines.map(l => JSON.parse(l)).reverse(); // newest first
    } catch (_) {
      return [];
    }
  }

  /**
   * Computes trend statistics from cross-session history.
   * @param {object[]} history - From loadHistory()
   * @returns {TrendStats}
   */
  static computeTrends(history) {
    if (history.length === 0) return null;

    const durations  = history.map(h => h.totalDurationMs).filter(v => v != null);
    const tokens     = history.map(h => h.tokensEst).filter(v => v != null);
    const errors     = history.map(h => h.errorCount).filter(v => v != null);
    const entropy    = history.map(h => h.entropyViolations).filter(v => v != null);

    const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
    const trend = (arr) => {
      if (arr.length < 2) return 'stable';
      const recent = arr.slice(0, Math.min(3, arr.length));
      const older  = arr.slice(Math.min(3, arr.length));
      if (older.length === 0) return 'stable';
      const recentAvg = avg(recent);
      const olderAvg  = avg(older);
      if (recentAvg > olderAvg * 1.2) return 'increasing';
      if (recentAvg < olderAvg * 0.8) return 'decreasing';
      return 'stable';
    };

    return {
      sessionCount:    history.length,
      avgDurationMs:   avg(durations),
      avgTokensEst:    avg(tokens),
      avgErrorCount:   avg(errors),
      avgEntropyViolations: avg(entropy),
      durationTrend:   trend(durations),
      tokenTrend:      trend(tokens),
      errorTrend:      trend(errors),
      entropyTrend:    trend(entropy),
      // ── P1-3 fix: guard against division by zero ─────────────────────────────
      // When all sessions have ciStatus=null (no CI configured), the denominator
      // is 0, producing NaN. NaN||null returns null, which is indistinguishable
      // from "CI configured but 0% success rate". Now we explicitly check the
      // denominator and return null only when there is truly no CI data.
      ciSuccessRate: (() => {
        const ciSessions = history.filter(h => h.ciStatus != null);
        if (ciSessions.length === 0) return null; // No CI data at all
        return ciSessions.filter(h => h.ciStatus === 'success').length / ciSessions.length;
      })(),
      lastSession:     history[0]?.startedAt,
    };
  }

  /**
   * Prints a human-readable dashboard to stdout.
   * Call after flush() to display the session summary.
   */
  printDashboard() {
    const m = this.flush();
    const bar = '─'.repeat(58);
    console.log(`\n${bar}`);
    console.log(`  📊 WORKFLOW OBSERVABILITY DASHBOARD`);
    console.log(`  Session : ${m.sessionId}`);
    console.log(`  Duration: ${(m.totalDurationMs / 1000).toFixed(1)}s`);
    console.log(bar);

    // Stage timings
    console.log(`  Stages:`);
    for (const s of m.stages) {
      const icon   = s.status === 'ok' ? '✅' : s.status === 'error' ? '❌' : '⚠️ ';
      const dur    = s.durationMs != null ? `${(s.durationMs / 1000).toFixed(1)}s` : '–';
      console.log(`    ${icon} ${s.name.padEnd(14)} ${dur}`);
    }

    // LLM usage
    console.log(`  LLM Calls: ${m.llm.totalCalls} total | ~${m.llm.totalTokensEst.toLocaleString()} tokens est.`);
    for (const [role, cnt] of Object.entries(m.llm.callsByRole)) {
      console.log(`    • ${role}: ${cnt} call(s)`);
    }

    // Errors
    if (m.errors.count > 0) {
      console.log(`  ⚠️  Errors: ${m.errors.count}`);
      for (const e of m.errors.details.slice(0, 3)) {
        console.log(`    [${e.stage}] ${e.message.slice(0, 80)}`);
      }
    }

    // Test result
    if (m.testResult) {
      const t = m.testResult;
      const icon = t.failed === 0 ? '✅' : '❌';
      console.log(`  ${icon} Tests: ${t.passed} passed / ${t.failed} failed / ${t.skipped} skipped (${t.rounds} round(s))`);
    }

    // Entropy
    if (m.entropyResult) {
      const e = m.entropyResult;
      const icon = e.violations === 0 ? '✅' : '⚠️ ';
      console.log(`  ${icon} Entropy GC: ${e.violations} violation(s) in ${e.filesScanned} files scanned`);
      if (e.reportPath) console.log(`    Report: ${e.reportPath}`);
    }

    // CI result
    if (m.ciResult) {
      const c    = m.ciResult;
      const icon = c.status === 'success' ? '✅' : c.status === 'failed' ? '❌' : '🔄';
      console.log(`  ${icon} CI [${c.provider}]: ${c.status} (${(c.durationMs / 1000).toFixed(1)}s)`);
    }

    // Code graph
    if (m.codeGraphResult) {
      const g = m.codeGraphResult;
      console.log(`  📊 Code Graph: ${g.symbolCount} symbols | ${g.edgeCount} call edges | ${g.fileCount} files`);
    }

    console.log(bar);
    console.log(`  Full metrics: output/run-metrics.json`);
    console.log(`  History:      output/metrics-history.jsonl`);
    console.log(`${bar}\n`);

    // Cross-session trend summary (if history exists)
    this._printTrendSummary();
  }

  /**
   * Derives adaptive strategy parameters from cross-session history.
   * Used by the Orchestrator to dynamically tune retry counts, review rounds, etc.
   *
   * Strategy rules:
   *  - maxFixRounds:    increases if recent test failure rate is high
   *  - maxReviewRounds: increases if recent error count trend is increasing
   *  - skipEntropyOnClean: true if last N sessions had 0 entropy violations
   *
   * @param {string} outputDir - Directory containing metrics-history.jsonl
   * @param {object} [defaults] - Default strategy values to fall back to
   * @returns {{ maxFixRounds: number, maxReviewRounds: number, skipEntropyOnClean: boolean, source: string }}
   */
  static deriveStrategy(outputDir, defaults = {}) {
    const defaultStrategy = {
      maxFixRounds:       defaults.maxFixRounds       ?? 2,
      maxReviewRounds:    defaults.maxReviewRounds    ?? 2,
      skipEntropyOnClean: defaults.skipEntropyOnClean ?? false,
      source: 'defaults',
    };

    const history = Observability.loadHistory(outputDir);
    // Need at least 3 sessions to derive meaningful strategy
    if (history.length < 3) return defaultStrategy;

    // ── Project isolation: only use history from the SAME project ────────────
    // Previously, all sessions from ALL projects were mixed together.
    // This caused cross-project pollution: project A's 3 consecutive passes
    // would reduce maxFixRounds to 1, leaving project B (a brand-new project
    // with inevitable bugs) with only 1 fix attempt.
    // Fix: filter history to the current projectId (passed via defaults.projectId).
    // Fall back to global history only if no project-specific history exists.
    const projectId = defaults.projectId || null;
    let filteredHistory = history;
    if (projectId) {
      const projectHistory = history.filter(h => h.projectId === projectId);
      if (projectHistory.length >= 3) {
        filteredHistory = projectHistory;
        console.log(`[Observability] 📊 Adaptive strategy: using ${projectHistory.length} session(s) for project "${projectId}" (isolated from global history).`);
      } else {
        console.log(`[Observability] 📊 Adaptive strategy: only ${projectHistory.length} session(s) for project "${projectId}" – using global history (${history.length} sessions) as fallback.`);
      }
    }

    if (filteredHistory.length < 3) return defaultStrategy;

    const recent = filteredHistory.slice(0, Math.min(5, filteredHistory.length));
    const trends = Observability.computeTrends(filteredHistory);

    // ── Rule 1: maxFixRounds ─────────────────────────────────────────────────
    // If recent sessions had test failures (testFailed > 0), increase fix rounds.
    const recentTestFailures = recent.filter(h => (h.testFailed ?? 0) > 0).length;
    const testFailRate = recentTestFailures / recent.length;
    let maxFixRounds = defaultStrategy.maxFixRounds;
    if (testFailRate >= 0.6) {
      maxFixRounds = Math.min(defaultStrategy.maxFixRounds + 2, 5); // cap at 5
    } else if (testFailRate >= 0.4) {
      maxFixRounds = Math.min(defaultStrategy.maxFixRounds + 1, 4);
    } else if (testFailRate === 0 && recent.length >= 3) {
      // Consistently passing – reduce fix rounds to save time
      maxFixRounds = Math.max(defaultStrategy.maxFixRounds - 1, 1);
    }

    // ── Rule 2: maxReviewRounds ──────────────────────────────────────────────
    // If error count is trending up, increase review rounds.
    let maxReviewRounds = defaultStrategy.maxReviewRounds;
    if (trends && trends.errorTrend === 'increasing') {
      maxReviewRounds = Math.min(defaultStrategy.maxReviewRounds + 1, 4);
    } else if (trends && trends.errorTrend === 'decreasing' && trends.avgErrorCount === 0) {
      maxReviewRounds = Math.max(defaultStrategy.maxReviewRounds - 1, 1);
    }

    // ── Rule 3: skipEntropyOnClean ───────────────────────────────────────────
    // If last 3 sessions all had 0 entropy violations, skip the post-test scan.
    // ── Improvement #2 fix: periodic forced scan ─────────────────────────────
    // Previously: once 3 consecutive clean sessions were seen, entropy was skipped
    // PERMANENTLY. If the 4th session introduced a large file or circular dep,
    // it would never be detected.
    // Fix: skip entropy only if the last 3 sessions are clean AND the total
    // session count is NOT a multiple of 5. Every 5th session forces a full scan
    // regardless of history, providing a periodic safety net.
    const recentEntropyData = recent.slice(0, 3).filter(h => h.entropyViolations != null);
    const allRecentClean = recentEntropyData.length >= 3 &&
      recentEntropyData.every(h => h.entropyViolations === 0);
    // Force a scan every 5 sessions (session count is 1-based: 5, 10, 15, ...)
    const isForcedScanSession = filteredHistory.length % 5 === 0;
    const skipEntropyOnClean = allRecentClean && !isForcedScanSession;
    if (allRecentClean && isForcedScanSession) {
      console.log(`[Observability] 📊 Adaptive strategy: entropy scan FORCED (session ${filteredHistory.length} is a multiple of 5 – periodic safety check).`);
    }

    const changed = maxFixRounds !== defaultStrategy.maxFixRounds ||
                    maxReviewRounds !== defaultStrategy.maxReviewRounds ||
                    skipEntropyOnClean !== defaultStrategy.skipEntropyOnClean;

    return {
      maxFixRounds,
      maxReviewRounds,
      skipEntropyOnClean,
      source: changed ? `history(${filteredHistory.length} sessions${projectId ? `, project:${projectId}` : ''})` : 'defaults',
      _debug: {
        testFailRate: Math.round(testFailRate * 100) + '%',
        errorTrend:   trends?.errorTrend ?? 'unknown',
        entropyClean: skipEntropyOnClean,
        sessionCount: filteredHistory.length,
        projectIsolated: projectId ? filteredHistory.length !== history.length : false,
      },
    };
  }

  _printTrendSummary() {
    try {
      const history = Observability.loadHistory(this._outputDir);
      if (history.length < 2) return; // Need at least 2 sessions for trends

      const trends = Observability.computeTrends(history);
      if (!trends) return;

      const bar = '─'.repeat(58);
      console.log(`  📈 TREND ANALYSIS (last ${trends.sessionCount} sessions)`);
      console.log(bar);

      const trendIcon = (t) => t === 'increasing' ? '📈' : t === 'decreasing' ? '📉' : '➡️ ';
      console.log(`  Avg Duration : ${(trends.avgDurationMs / 1000).toFixed(1)}s  ${trendIcon(trends.durationTrend)} ${trends.durationTrend}`);
      console.log(`  Avg Tokens   : ~${trends.avgTokensEst.toLocaleString()}  ${trendIcon(trends.tokenTrend)} ${trends.tokenTrend}`);
      console.log(`  Avg Errors   : ${trends.avgErrorCount}  ${trendIcon(trends.errorTrend)} ${trends.errorTrend}`);
      if (trends.avgEntropyViolations != null) {
        console.log(`  Avg Entropy  : ${trends.avgEntropyViolations} violations  ${trendIcon(trends.entropyTrend)} ${trends.entropyTrend}`);
      }
      if (trends.ciSuccessRate != null) {
        console.log(`  CI Success   : ${(trends.ciSuccessRate * 100).toFixed(0)}%`);
      }
      console.log(`${bar}\n`);
    } catch (_) {}
  }
}

module.exports = { Observability };
