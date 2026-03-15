'use strict';

/**
 * TestRunner – Executes real test commands and parses results.
 *
 * Responsibilities:
 *  - Run the project's actual test command (npm test, flutter test, pytest, etc.)
 *  - Capture stdout/stderr with a configurable timeout
 *  - Parse pass/fail counts from common test framework outputs
 *  - Return a structured result for the orchestrator to act on
 *
 * This is the "real verification" layer that closes the feedback loop:
 *   Agent writes code → TestRunner runs tests → failures trigger auto-fix → repeat
 */

const { execSync } = require('child_process');
const path = require('path');

/**
 * @typedef {object} TestRunResult
 * @property {boolean} passed       - true if all tests passed (exit code 0)
 * @property {number}  exitCode     - raw process exit code
 * @property {string}  stdout       - captured standard output
 * @property {string}  stderr       - captured standard error
 * @property {string}  output       - combined stdout + stderr
 * @property {number|null} totalTests  - parsed total test count (null if unparseable)
 * @property {number|null} failedTests - parsed failure count (null if unparseable)
 * @property {string[]} failureSummary - extracted failure messages (up to 10)
 * @property {number}  durationMs   - wall-clock time in milliseconds
 * @property {string}  command      - the command that was run
 */

class TestRunner {
  /**
   * @param {object} options
   * @param {string}  options.projectRoot  - Absolute path to the project root
   * @param {string}  options.testCommand  - Shell command to run (e.g. "npm test")
   * @param {number}  [options.timeoutMs]  - Max execution time in ms (default: 120000)
   * @param {boolean} [options.verbose]    - Print live output to console (default: true)
   */
  constructor({ projectRoot, testCommand, timeoutMs = 120_000, verbose = true }) {
    if (!projectRoot) throw new Error('[TestRunner] projectRoot is required');
    if (!testCommand) throw new Error('[TestRunner] testCommand is required');

    this.projectRoot = projectRoot;
    this.testCommand = testCommand;
    this.timeoutMs = timeoutMs;
    this.verbose = verbose;
  }

  /**
   * Runs the test command and returns a structured result.
   *
   * @returns {TestRunResult}
   */
  run() {
    const startMs = Date.now();
    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    if (this.verbose) {
      console.log(`\n[TestRunner] Running: ${this.testCommand}`);
      console.log(`[TestRunner] Working dir: ${this.projectRoot}`);
      console.log(`[TestRunner] Timeout: ${this.timeoutMs / 1000}s\n`);
    }

    try {
      const output = execSync(this.testCommand, {
        cwd: this.projectRoot,
        timeout: this.timeoutMs,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      stdout = output || '';
    } catch (err) {
      // execSync throws on non-zero exit code
      exitCode = err.status ?? 1;
      stdout = err.stdout || '';
      stderr = err.stderr || '';
    }

    const durationMs = Date.now() - startMs;
    const combined = [stdout, stderr].filter(Boolean).join('\n');

    if (this.verbose && combined) {
      console.log('[TestRunner] Output:\n' + combined.slice(0, 3000));
      if (combined.length > 3000) {
        console.log(`[TestRunner] ... (${combined.length - 3000} more chars truncated)`);
      }
    }

    const parsed = this._parseOutput(combined);
    const passed = exitCode === 0;

    if (this.verbose) {
      const icon = passed ? '✅' : '❌';
      console.log(`\n[TestRunner] ${icon} ${passed ? 'PASSED' : 'FAILED'} (exit ${exitCode}, ${durationMs}ms)`);
      if (parsed.totalTests !== null) {
        console.log(`[TestRunner] Tests: ${parsed.totalTests} total, ${parsed.failedTests ?? 0} failed`);
      }
    }

    return {
      passed,
      exitCode,
      stdout,
      stderr,
      output: combined,
      totalTests: parsed.totalTests,
      failedTests: parsed.failedTests,
      failureSummary: parsed.failureSummary,
      durationMs,
      command: this.testCommand,
    };
  }

  // ─── Output Parsers ───────────────────────────────────────────────────────────

  /**
   * Parses test output from common frameworks.
   * Supports: Jest, Mocha, pytest, Go test, Flutter test, JUnit-style.
   *
   * @param {string} output
   * @returns {{ totalTests: number|null, failedTests: number|null, failureSummary: string[] }}
   */
  _parseOutput(output) {
    const failureSummary = this._extractFailures(output);

    // ── Jest / Vitest ──
    // "Tests: 3 failed, 12 passed, 15 total"
    const jestMatch = output.match(/Tests:\s+(?:(\d+)\s+failed,\s*)?(?:\d+\s+passed,\s*)?(\d+)\s+total/i);
    if (jestMatch) {
      return {
        totalTests: parseInt(jestMatch[2], 10),
        failedTests: jestMatch[1] ? parseInt(jestMatch[1], 10) : 0,
        failureSummary,
      };
    }

    // ── Mocha ──
    // "12 passing" / "3 failing"
    const mochaPass = output.match(/(\d+)\s+passing/i);
    const mochaFail = output.match(/(\d+)\s+failing/i);
    if (mochaPass || mochaFail) {
      const passing = mochaPass ? parseInt(mochaPass[1], 10) : 0;
      const failing = mochaFail ? parseInt(mochaFail[1], 10) : 0;
      return {
        totalTests: passing + failing,
        failedTests: failing,
        failureSummary,
      };
    }

    // ── pytest ──
    // "5 passed, 2 failed in 1.23s" or "7 passed in 0.5s"
    const pytestMatch = output.match(/(\d+)\s+passed(?:,\s*(\d+)\s+failed)?/i);
    if (pytestMatch) {
      const passing = parseInt(pytestMatch[1], 10);
      const failing = pytestMatch[2] ? parseInt(pytestMatch[2], 10) : 0;
      return {
        totalTests: passing + failing,
        failedTests: failing,
        failureSummary,
      };
    }

    // ── Go test ──
    // "ok  	package/name	0.123s" or "FAIL	package/name	0.456s"
    const goOk = (output.match(/^ok\s+/gm) || []).length;
    const goFail = (output.match(/^FAIL\s+/gm) || []).length;
    if (goOk + goFail > 0) {
      return {
        totalTests: goOk + goFail,
        failedTests: goFail,
        failureSummary,
      };
    }

    // ── Flutter test ──
    // "+5: All tests passed!" or "+3 -1: Some tests failed."
    const flutterMatch = output.match(/\+(\d+)(?:\s+-(\d+))?:/);
    if (flutterMatch) {
      const passing = parseInt(flutterMatch[1], 10);
      const failing = flutterMatch[2] ? parseInt(flutterMatch[2], 10) : 0;
      return {
        totalTests: passing + failing,
        failedTests: failing,
        failureSummary,
      };
    }

    // ── Generic: look for "X tests passed" / "X tests failed" ──
    const genericFail = output.match(/(\d+)\s+(?:test[s]?\s+)?fail(?:ed|ure[s]?)/i);
    const genericPass = output.match(/(\d+)\s+(?:test[s]?\s+)?pass(?:ed)?/i);
    if (genericFail || genericPass) {
      const failing = genericFail ? parseInt(genericFail[1], 10) : 0;
      const passing = genericPass ? parseInt(genericPass[1], 10) : 0;
      return {
        totalTests: passing + failing || null,
        failedTests: failing,
        failureSummary,
      };
    }

    return { totalTests: null, failedTests: null, failureSummary };
  }

  /**
   * Extracts failure messages from test output.
   * Looks for common failure patterns across frameworks.
   *
   * @param {string} output
   * @returns {string[]} Up to 10 failure messages
   */
  _extractFailures(output) {
    const failures = [];
    const lines = output.split('\n');

    // Patterns that indicate a failure line
    const failPatterns = [
      /^\s*●\s+/,                    // Jest: "● test name"
      /^\s*\d+\)\s+/,                // Mocha: "1) test name"
      /^FAIL\b/,                     // Go test / generic
      /^\s*FAILED\s+/i,              // pytest / generic
      /AssertionError/i,             // Python / JS
      /Error:/,                      // Generic error
      /^\s*✗\s+/,                    // Some frameworks use ✗
      /^\s*×\s+/,                    // Some frameworks use ×
      /Expected.*but.*got/i,         // Assertion messages
    ];

    for (const line of lines) {
      if (failures.length >= 10) break;
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (failPatterns.some(p => p.test(line))) {
        failures.push(trimmed.slice(0, 200)); // cap line length
      }
    }

    return failures;
  }

  /**
   * Formats a TestRunResult into a Markdown summary block.
   * Used to inject test results into the fix prompt.
   *
   * @param {TestRunResult} result
   * @returns {string}
   */
  static formatResultAsMarkdown(result) {
    const status = result.passed ? '✅ PASSED' : '❌ FAILED';
    const lines = [
      `## Real Test Execution Result`,
      ``,
      `**Status**: ${status}`,
      `**Command**: \`${result.command}\``,
      `**Exit Code**: ${result.exitCode}`,
      `**Duration**: ${result.durationMs}ms`,
    ];

    if (result.totalTests !== null) {
      lines.push(`**Tests**: ${result.totalTests} total, ${result.failedTests ?? 0} failed`);
    }

    if (result.failureSummary.length > 0) {
      lines.push(``, `### Failure Summary`);
      result.failureSummary.forEach((f, i) => lines.push(`${i + 1}. \`${f}\``));
    }

    if (!result.passed && result.output) {
      const excerpt = result.output.slice(-2000); // last 2000 chars are most relevant
      lines.push(``, `### Test Output (last 2000 chars)`, `\`\`\``, excerpt, `\`\`\``);
    }

    return lines.join('\n');
  }
}

module.exports = { TestRunner };
