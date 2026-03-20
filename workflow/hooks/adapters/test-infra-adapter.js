/**
 * TestInfraAdapter – Testing infrastructure enhancement via MCP.
 *
 * Provides:
 *   1. Coverage analysis   – Parses lcov.info / coverage-summary.json locally
 *   2. Coverage diff       – Compares current vs baseline coverage
 *   3. Flaky test tracking – Detects tests that intermittently fail
 *   4. Perf regression     – Detects duration regressions from test timing data
 *   5. Codecov API         – Optional: fetch coverage trends from codecov.io
 *
 * Usage:
 *   const adapter = new TestInfraAdapter({ projectRoot: '/path' });
 *   await adapter.connect();
 *   const coverage = await adapter.getCoverageReport();
 *   const flaky = adapter.getFlakyTests();
 *   const block = adapter.formatTestInfraBlock(coverage, flaky);
 */

'use strict';

const { MCPAdapter, HttpMixin } = require('./base');
const fs   = require('fs');
const path = require('path');

// ── Coverage thresholds ─────────────────────────────────────────────────────

const DEFAULT_THRESHOLDS = {
  lineCoverage: 80,       // Minimum line coverage %
  branchCoverage: 70,     // Minimum branch coverage %
  functionCoverage: 80,   // Minimum function coverage %
  regressionDelta: -5,    // Alert if coverage drops by more than 5%
};


class TestInfraAdapter extends MCPAdapter {
  /**
   * @param {object} config
   * @param {string}  [config.projectRoot]    - Project root directory
   * @param {object}  [config.thresholds]     - Coverage thresholds override
   * @param {string}  [config.codecovToken]   - Codecov API token (optional)
   * @param {string}  [config.codecovOwner]   - Codecov repo owner (optional)
   * @param {string}  [config.codecovRepo]    - Codecov repo name (optional)
   * @param {number}  [config.timeout]        - HTTP timeout ms (default: 10000)
   * @param {number}  [config.flakyThreshold] - Min fail count to flag as flaky (default: 2)
   * @param {string}  [config.baselinePath]   - Path to baseline coverage snapshot
   */
  constructor(config = {}) {
    super('test-infra', config);
    this.projectRoot = config.projectRoot || process.cwd();
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...config.thresholds };
    this.codecovToken = config.codecovToken || process.env.CODECOV_TOKEN || null;
    this.codecovOwner = config.codecovOwner || null;
    this.codecovRepo = config.codecovRepo || null;
    this.timeout = config.timeout || 10000;
    this.flakyThreshold = config.flakyThreshold || 2;
    this.baselinePath = config.baselinePath || path.join(this.projectRoot, 'output', '.coverage-baseline.json');

    /** @type {Array<{testName: string, results: Array<{pass: boolean, ts: number, durationMs: number}>}>} */
    this._testHistory = [];
    /** @type {Map<string, {pass: number, fail: number, durations: number[]}>} */
    this._testStats = new Map();
  }

  async connect() {
    // Load existing test history if available
    this._loadTestHistory();
    this._connected = true;
    console.log(`[MCPAdapter:test-infra] Connected (projectRoot: ${this.projectRoot}).`);
  }

  // ── Public API: Coverage ──────────────────────────────────────────────────

  /**
   * Reads and parses local coverage data.
   * Looks for coverage reports in common locations.
   *
   * @returns {Promise<CoverageReport>}
   */
  async getCoverageReport() {
    this._assertConnected();

    // Try multiple coverage formats
    let coverage = this._parseIstanbulSummary();
    if (!coverage) coverage = this._parseLcov();
    if (!coverage) coverage = this._parseClover();

    if (!coverage) {
      return { available: false, message: 'No coverage data found.' };
    }

    // Load baseline for diff
    const baseline = this._loadBaseline();
    const diff = baseline ? this._computeDiff(coverage, baseline) : null;

    // Check thresholds
    const violations = [];
    if (coverage.linePct < this.thresholds.lineCoverage) {
      violations.push(`Line coverage ${coverage.linePct.toFixed(1)}% < ${this.thresholds.lineCoverage}% threshold`);
    }
    if (coverage.branchPct !== null && coverage.branchPct < this.thresholds.branchCoverage) {
      violations.push(`Branch coverage ${coverage.branchPct.toFixed(1)}% < ${this.thresholds.branchCoverage}% threshold`);
    }
    if (coverage.functionPct !== null && coverage.functionPct < this.thresholds.functionCoverage) {
      violations.push(`Function coverage ${coverage.functionPct.toFixed(1)}% < ${this.thresholds.functionCoverage}% threshold`);
    }

    // Check regression
    if (diff && diff.lineDelta < this.thresholds.regressionDelta) {
      violations.push(`⚠️ Coverage REGRESSION: line coverage dropped by ${Math.abs(diff.lineDelta).toFixed(1)}pp`);
    }

    return {
      available: true,
      ...coverage,
      diff,
      violations,
      passesGate: violations.length === 0,
    };
  }

  /**
   * Saves current coverage as baseline for future comparisons.
   */
  saveBaseline(coverage) {
    if (!coverage || !coverage.available) return;
    try {
      const dir = path.dirname(this.baselinePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.baselinePath, JSON.stringify({
        linePct: coverage.linePct,
        branchPct: coverage.branchPct,
        functionPct: coverage.functionPct,
        totalLines: coverage.totalLines,
        ts: Date.now(),
      }), 'utf-8');
      console.log(`[MCPAdapter:test-infra] Baseline saved to ${this.baselinePath}`);
    } catch (err) {
      console.warn(`[MCPAdapter:test-infra] Failed to save baseline: ${err.message}`);
    }
  }

  // ── Public API: Flaky Tests ───────────────────────────────────────────────

  /**
   * Records test execution results for flaky detection.
   *
   * @param {Array<{testName: string, pass: boolean, durationMs: number}>} results
   */
  recordTestResults(results) {
    const ts = Date.now();
    for (const r of results) {
      if (!this._testStats.has(r.testName)) {
        this._testStats.set(r.testName, { pass: 0, fail: 0, durations: [] });
      }
      const stats = this._testStats.get(r.testName);
      r.pass ? stats.pass++ : stats.fail++;
      if (r.durationMs) stats.durations.push(r.durationMs);
    }
    this._saveTestHistory();
  }

  /**
   * Returns tests identified as flaky (intermittently failing).
   *
   * @returns {Array<{testName: string, passCount: number, failCount: number, flakyScore: number}>}
   */
  getFlakyTests() {
    const flaky = [];
    for (const [testName, stats] of this._testStats) {
      if (stats.fail >= this.flakyThreshold && stats.pass > 0) {
        const total = stats.pass + stats.fail;
        const flakyScore = Math.round((stats.fail / total) * 100);
        flaky.push({
          testName,
          passCount: stats.pass,
          failCount: stats.fail,
          flakyScore,
          totalRuns: total,
        });
      }
    }
    return flaky.sort((a, b) => b.flakyScore - a.flakyScore);
  }

  // ── Public API: Performance Regression ────────────────────────────────────

  /**
   * Detects tests whose duration has significantly increased.
   *
   * @param {number} [thresholdPct=50] - Alert if duration increased by more than this %
   * @returns {Array<{testName: string, avgDurationMs: number, lastDurationMs: number, regressionPct: number}>}
   */
  getPerformanceRegressions(thresholdPct = 50) {
    const regressions = [];
    for (const [testName, stats] of this._testStats) {
      if (stats.durations.length < 3) continue; // Need enough data
      const recent = stats.durations.slice(-1)[0];
      const baseline = stats.durations.slice(0, -1);
      const avg = baseline.reduce((a, b) => a + b, 0) / baseline.length;
      if (avg === 0) continue;
      const regressionPct = ((recent - avg) / avg) * 100;
      if (regressionPct > thresholdPct) {
        regressions.push({
          testName,
          avgDurationMs: Math.round(avg),
          lastDurationMs: recent,
          regressionPct: Math.round(regressionPct),
        });
      }
    }
    return regressions.sort((a, b) => b.regressionPct - a.regressionPct);
  }

  // ── Public API: Codecov Integration ───────────────────────────────────────

  /**
   * Fetches coverage trend from Codecov API (optional).
   *
   * @returns {Promise<{available: boolean, commits: Array<{sha: string, coverage: number}>}|null>}
   */
  async getCodecovTrend() {
    if (!this.codecovToken || !this.codecovOwner || !this.codecovRepo) return null;

    try {
      const url = `https://codecov.io/api/v2/github/${this.codecovOwner}/repos/${this.codecovRepo}/commits?page_size=10`;
      const raw = await this._httpGet(url, {
        headers: {
          'Authorization': `Bearer ${this.codecovToken}`,
          'Accept': 'application/json',
        },
        timeout: this.timeout,
      });
      const data = JSON.parse(raw);
      const commits = (data.results || []).map(c => ({
        sha: c.commitid?.slice(0, 7) || 'unknown',
        coverage: c.totals?.coverage || 0,
        ts: c.timestamp,
      }));
      return { available: true, commits };
    } catch (err) {
      console.warn(`[MCPAdapter:test-infra] Codecov fetch failed: ${err.message}`);
      return null;
    }
  }

  // ── Public API: Formatting ────────────────────────────────────────────────

  /**
   * Formats test infrastructure data as a Markdown block for prompt injection.
   */
  formatTestInfraBlock(coverageReport, flakyTests, perfRegressions) {
    const lines = [`## 🧪 Test Infrastructure Report`];

    // Coverage section
    if (coverageReport && coverageReport.available) {
      const gateIcon = coverageReport.passesGate ? '✅' : '❌';
      lines.push(`### Coverage ${gateIcon}`);
      lines.push(`| Metric | Value | Threshold | Status |`);
      lines.push(`|--------|-------|-----------|--------|`);

      const lineIcon = coverageReport.linePct >= this.thresholds.lineCoverage ? '✅' : '❌';
      lines.push(`| Lines | ${coverageReport.linePct.toFixed(1)}% | ${this.thresholds.lineCoverage}% | ${lineIcon} |`);

      if (coverageReport.branchPct !== null) {
        const brIcon = coverageReport.branchPct >= this.thresholds.branchCoverage ? '✅' : '❌';
        lines.push(`| Branches | ${coverageReport.branchPct.toFixed(1)}% | ${this.thresholds.branchCoverage}% | ${brIcon} |`);
      }
      if (coverageReport.functionPct !== null) {
        const fnIcon = coverageReport.functionPct >= this.thresholds.functionCoverage ? '✅' : '❌';
        lines.push(`| Functions | ${coverageReport.functionPct.toFixed(1)}% | ${this.thresholds.functionCoverage}% | ${fnIcon} |`);
      }

      // Diff from baseline
      if (coverageReport.diff) {
        const d = coverageReport.diff;
        const arrow = d.lineDelta >= 0 ? '📈' : '📉';
        lines.push(``, `> ${arrow} **Coverage delta**: ${d.lineDelta >= 0 ? '+' : ''}${d.lineDelta.toFixed(1)}pp vs baseline`);
      }

      if (coverageReport.violations.length > 0) {
        lines.push(``, `**Violations:**`);
        for (const v of coverageReport.violations) {
          lines.push(`- ⚠️ ${v}`);
        }
      }
      lines.push(``);
    }

    // Flaky tests section
    if (flakyTests && flakyTests.length > 0) {
      lines.push(`### 🔄 Flaky Tests (${flakyTests.length})`);
      lines.push(`> These tests intermittently fail. Consider stabilising them or marking as known-flaky.`);
      lines.push(`| Test | Pass | Fail | Flaky Score |`);
      lines.push(`|------|------|------|-------------|`);
      for (const ft of flakyTests.slice(0, 10)) {
        lines.push(`| \`${ft.testName.slice(0, 60)}\` | ${ft.passCount} | ${ft.failCount} | ${ft.flakyScore}% |`);
      }
      lines.push(``);
    }

    // Performance regressions section
    if (perfRegressions && perfRegressions.length > 0) {
      lines.push(`### ⏱️ Performance Regressions (${perfRegressions.length})`);
      lines.push(`> These tests are significantly slower than their historical average.`);
      lines.push(`| Test | Avg Duration | Last Duration | Regression |`);
      lines.push(`|------|-------------|--------------|------------|`);
      for (const pr of perfRegressions.slice(0, 10)) {
        lines.push(`| \`${pr.testName.slice(0, 60)}\` | ${pr.avgDurationMs}ms | ${pr.lastDurationMs}ms | +${pr.regressionPct}% |`);
      }
      lines.push(``);
    }

    if (lines.length <= 1) return ''; // No data
    return lines.join('\n');
  }

  // ── MCPAdapter interface ──────────────────────────────────────────────────

  async query(queryStr, params = {}) {
    this._assertConnected();
    if (queryStr === 'coverage') return this.getCoverageReport();
    if (queryStr === 'flaky') return this.getFlakyTests();
    if (queryStr === 'perf') return this.getPerformanceRegressions(params.thresholdPct);
    if (queryStr === 'codecov') return this.getCodecovTrend();
    return this.getCoverageReport();
  }

  async notify(event, payload) {
    if (event === 'test_results' && payload && Array.isArray(payload.results)) {
      this.recordTestResults(payload.results);
    }
  }

  // ── Private: Coverage parsers ─────────────────────────────────────────────

  _parseIstanbulSummary() {
    const candidates = [
      path.join(this.projectRoot, 'coverage', 'coverage-summary.json'),
      path.join(this.projectRoot, '.nyc_output', 'coverage-summary.json'),
    ];
    for (const p of candidates) {
      if (!fs.existsSync(p)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
        const total = data.total;
        if (!total) continue;
        return {
          linePct: total.lines?.pct ?? 0,
          branchPct: total.branches?.pct ?? null,
          functionPct: total.functions?.pct ?? null,
          statementPct: total.statements?.pct ?? null,
          totalLines: total.lines?.total ?? 0,
          coveredLines: total.lines?.covered ?? 0,
          source: 'istanbul',
        };
      } catch (_) {}
    }
    return null;
  }

  _parseLcov() {
    const candidates = [
      path.join(this.projectRoot, 'coverage', 'lcov.info'),
      path.join(this.projectRoot, 'lcov.info'),
    ];
    for (const p of candidates) {
      if (!fs.existsSync(p)) continue;
      try {
        const content = fs.readFileSync(p, 'utf-8');
        let linesFound = 0, linesHit = 0;
        let branchesFound = 0, branchesHit = 0;
        let functionsFound = 0, functionsHit = 0;

        for (const line of content.split('\n')) {
          if (line.startsWith('LF:')) linesFound += parseInt(line.slice(3)) || 0;
          if (line.startsWith('LH:')) linesHit += parseInt(line.slice(3)) || 0;
          if (line.startsWith('BRF:')) branchesFound += parseInt(line.slice(4)) || 0;
          if (line.startsWith('BRH:')) branchesHit += parseInt(line.slice(4)) || 0;
          if (line.startsWith('FNF:')) functionsFound += parseInt(line.slice(4)) || 0;
          if (line.startsWith('FNH:')) functionsHit += parseInt(line.slice(4)) || 0;
        }

        return {
          linePct: linesFound > 0 ? (linesHit / linesFound) * 100 : 0,
          branchPct: branchesFound > 0 ? (branchesHit / branchesFound) * 100 : null,
          functionPct: functionsFound > 0 ? (functionsHit / functionsFound) * 100 : null,
          statementPct: null,
          totalLines: linesFound,
          coveredLines: linesHit,
          source: 'lcov',
        };
      } catch (_) {}
    }
    return null;
  }

  _parseClover() {
    const p = path.join(this.projectRoot, 'coverage', 'clover.xml');
    if (!fs.existsSync(p)) return null;
    try {
      const content = fs.readFileSync(p, 'utf-8');
      // Simple regex extraction from Clover XML
      const stmtMatch = content.match(/statements="(\d+)"/);
      const covStmtMatch = content.match(/coveredstatements="(\d+)"/);
      if (!stmtMatch || !covStmtMatch) return null;
      const total = parseInt(stmtMatch[1]);
      const covered = parseInt(covStmtMatch[1]);
      return {
        linePct: total > 0 ? (covered / total) * 100 : 0,
        branchPct: null,
        functionPct: null,
        statementPct: total > 0 ? (covered / total) * 100 : null,
        totalLines: total,
        coveredLines: covered,
        source: 'clover',
      };
    } catch (_) { return null; }
  }

  // ── Private: Baseline management ──────────────────────────────────────────

  _loadBaseline() {
    try {
      if (!fs.existsSync(this.baselinePath)) return null;
      return JSON.parse(fs.readFileSync(this.baselinePath, 'utf-8'));
    } catch (_) { return null; }
  }

  _computeDiff(current, baseline) {
    return {
      lineDelta: (current.linePct || 0) - (baseline.linePct || 0),
      branchDelta: current.branchPct !== null && baseline.branchPct !== null
        ? current.branchPct - baseline.branchPct : null,
      functionDelta: current.functionPct !== null && baseline.functionPct !== null
        ? current.functionPct - baseline.functionPct : null,
    };
  }

  // ── Private: Test history persistence ─────────────────────────────────────

  _loadTestHistory() {
    try {
      const histPath = path.join(this.projectRoot, 'output', '.test-history.json');
      if (!fs.existsSync(histPath)) return;
      const data = JSON.parse(fs.readFileSync(histPath, 'utf-8'));
      if (data.stats && typeof data.stats === 'object') {
        for (const [name, stats] of Object.entries(data.stats)) {
          this._testStats.set(name, {
            pass: stats.pass || 0,
            fail: stats.fail || 0,
            durations: stats.durations || [],
          });
        }
      }
    } catch (_) {}
  }

  _saveTestHistory() {
    try {
      const histPath = path.join(this.projectRoot, 'output', '.test-history.json');
      const dir = path.dirname(histPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const stats = {};
      for (const [name, s] of this._testStats) {
        stats[name] = { pass: s.pass, fail: s.fail, durations: s.durations.slice(-20) };
      }
      fs.writeFileSync(histPath, JSON.stringify({ stats, ts: Date.now() }), 'utf-8');
    } catch (_) {}
  }
}

// Attach shared HTTP helpers (for Codecov API)
Object.assign(TestInfraAdapter.prototype, HttpMixin);

module.exports = { TestInfraAdapter, DEFAULT_THRESHOLDS };
