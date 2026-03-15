/**
 * CI Integration – Pipeline validation bridge for the workflow.
 *
 * Bridges the gap between local test execution and real CI/CD pipeline
 * validation. Supports:
 *  1. Generic CI command execution (run any CI-like command locally)
 *  2. GitHub Actions status polling (via GitHub REST API)
 *  3. GitLab CI status polling (via GitLab REST API)
 *  4. Local pre-push validation (lint + test + entropy scan)
 *
 * Design: non-blocking, timeout-safe, graceful degradation when CI is
 * unavailable. All methods return structured result objects.
 *
 * Integration: Called from index.js after the TEST stage completes,
 * and available as `/ci` slash command.
 */

'use strict';

const { execSync, spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

// ─── Constants ────────────────────────────────────────────────────────────────

const CI_POLL_INTERVAL_MS = 10_000;  // 10s between polls
const CI_POLL_TIMEOUT_MS  = 300_000; // 5min max wait
const CI_STATUS = {
  PENDING:  'pending',
  RUNNING:  'running',
  SUCCESS:  'success',
  FAILED:   'failed',
  CANCELLED:'cancelled',
  UNKNOWN:  'unknown',
};

// ─── CIIntegration ────────────────────────────────────────────────────────────

class CIIntegration {
  /**
   * @param {object} options
   * @param {string}  options.projectRoot  - Project root directory
   * @param {string}  [options.provider]   - 'github' | 'gitlab' | 'local' | 'auto'
   * @param {string}  [options.apiToken]   - API token for GitHub/GitLab
   * @param {string}  [options.repoSlug]   - 'owner/repo' for GitHub, 'group/project' for GitLab
   * @param {string}  [options.apiBaseUrl] - GitLab self-hosted base URL
   * @param {string}  [options.lintCommand]  - Lint command to run
   * @param {string}  [options.testCommand]  - Test command to run
   */
  constructor({
    projectRoot,
    provider    = 'auto',
    apiToken    = null,
    repoSlug    = null,
    apiBaseUrl  = 'https://gitlab.com',
    lintCommand = null,
    testCommand = null,
  } = {}) {
    this._root       = projectRoot;
    this._provider   = provider === 'auto' ? this._detectProvider() : provider;
    this._apiToken   = apiToken   || process.env.GITHUB_TOKEN || process.env.GITLAB_TOKEN || null;
    this._repoSlug   = repoSlug   || this._detectRepoSlug();
    this._apiBaseUrl = apiBaseUrl;
    this._lintCmd    = lintCommand;
    this._testCmd    = testCommand;
  }

  // ─── Provider Detection ───────────────────────────────────────────────────

  _detectProvider() {
    // Check environment variables set by CI runners
    if (process.env.GITHUB_ACTIONS)  return 'github';
    if (process.env.GITLAB_CI)       return 'gitlab';
    if (process.env.CIRCLECI)        return 'circleci';
    if (process.env.TRAVIS)          return 'travis';
    // Check remote URL
    try {
      const remote = execSync('git remote get-url origin', {
        cwd: this._root, encoding: 'utf-8', stdio: ['pipe','pipe','pipe'],
      }).trim();
      if (remote.includes('github.com'))  return 'github';
      if (remote.includes('gitlab.com') || remote.includes('gitlab')) return 'gitlab';
    } catch (_) {}
    return 'local';
  }

  _detectRepoSlug() {
    try {
      const remote = execSync('git remote get-url origin', {
        cwd: this._root, encoding: 'utf-8', stdio: ['pipe','pipe','pipe'],
      }).trim();
      // https://github.com/owner/repo.git  or  git@github.com:owner/repo.git
      const match = remote.match(/[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
      return match ? match[1] : null;
    } catch (_) {
      return null;
    }
  }

  // ─── Local Pre-Push Validation ────────────────────────────────────────────

  /**
   * Runs a full local CI simulation: lint → test → entropy scan.
   * This is the "local pipeline" that runs before pushing to remote CI.
   *
   * @param {object} [options]
   * @param {boolean} [options.skipLint]    - Skip lint step
   * @param {boolean} [options.skipTest]    - Skip test step
   * @param {boolean} [options.skipEntropy] - Skip entropy scan step
   * @returns {Promise<CIRunResult>}
   */
  async runLocalPipeline({ skipLint = false, skipTest = false, skipEntropy = false } = {}) {
    console.log(`\n[CIIntegration] 🚀 Running local CI pipeline...`);
    const startedAt = Date.now();
    const steps = [];

    // Step 1: Lint
    if (!skipLint && this._lintCmd) {
      const lintResult = this._runStep('lint', this._lintCmd);
      steps.push(lintResult);
      if (!lintResult.passed) {
        return this._buildResult('failed', steps, startedAt, 'Lint failed – pipeline aborted');
      }
    }

    // Step 2: Test
    if (!skipTest && this._testCmd) {
      const testResult = this._runStep('test', this._testCmd);
      steps.push(testResult);
      if (!testResult.passed) {
        return this._buildResult('failed', steps, startedAt, 'Tests failed – pipeline aborted');
      }
    }

    // Step 3: Entropy scan (non-blocking – warnings only)
    if (!skipEntropy) {
      try {
        const { EntropyGC } = require('./entropy-gc');
        const { PATHS } = require('./constants');
        const gc = new EntropyGC({ projectRoot: this._root, outputDir: PATHS.OUTPUT_DIR });
        const gcResult = await gc.run();
        steps.push({
          name:    'entropy',
          passed:  gcResult.details?.high === 0,
          output:  `${gcResult.violations} violation(s) in ${gcResult.filesScanned} files`,
          durationMs: 0,
        });
      } catch (err) {
        steps.push({ name: 'entropy', passed: true, output: `Skipped: ${err.message}`, durationMs: 0 });
      }
    }

    const allPassed = steps.every(s => s.passed);
    return this._buildResult(allPassed ? 'success' : 'failed', steps, startedAt);
  }

  _runStep(name, command) {
    const start = Date.now();
    console.log(`[CIIntegration]   ▶ ${name}: ${command}`);
    try {
      const output = execSync(command, {
        cwd: this._root,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120_000,
      });
      const durationMs = Date.now() - start;
      console.log(`[CIIntegration]   ✅ ${name} passed (${(durationMs / 1000).toFixed(1)}s)`);
      return { name, passed: true, output: output.slice(0, 500), durationMs };
    } catch (err) {
      const durationMs = Date.now() - start;
      const output = (err.stdout || '') + (err.stderr || '') || err.message;
      console.log(`[CIIntegration]   ❌ ${name} failed (${(durationMs / 1000).toFixed(1)}s)`);
      return { name, passed: false, output: output.slice(0, 500), durationMs };
    }
  }

  _buildResult(status, steps, startedAt, message = null) {
    const durationMs = Date.now() - startedAt;
    const result = {
      provider:  this._provider,
      status,
      steps,
      durationMs,
      message:   message || (status === 'success' ? 'All pipeline steps passed' : 'Pipeline failed'),
      timestamp: new Date().toISOString(),
    };
    console.log(`[CIIntegration] Pipeline ${status === 'success' ? '✅' : '❌'}: ${result.message} (${(durationMs / 1000).toFixed(1)}s)`);
    return result;
  }

  // ─── GitHub Actions Status Polling ───────────────────────────────────────

  /**
   * Polls GitHub Actions for the latest workflow run status on the current branch.
   * Requires GITHUB_TOKEN env var or apiToken constructor option.
   *
   * @param {object} [options]
   * @param {string}  [options.branch]      - Branch to check (default: current branch)
   * @param {string}  [options.workflowName]- Workflow name filter
   * @param {boolean} [options.wait]        - Wait for completion (default: false)
   * @returns {Promise<CIPollResult>}
   */
  async pollGitHub({ branch = null, workflowName = null, wait = false } = {}) {
    if (!this._apiToken) {
      return { status: CI_STATUS.UNKNOWN, message: 'No GitHub token. Set GITHUB_TOKEN env var.' };
    }
    if (!this._repoSlug) {
      return { status: CI_STATUS.UNKNOWN, message: 'Could not detect repo slug from git remote.' };
    }

    const currentBranch = branch || this._getCurrentBranch();
    const baseUrl = `https://api.github.com/repos/${this._repoSlug}`;

    const poll = async () => {
      try {
        const url = `${baseUrl}/actions/runs?branch=${encodeURIComponent(currentBranch)}&per_page=5`;
        const response = await this._httpGet(url, {
          'Authorization': `Bearer ${this._apiToken}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        });
        const data = JSON.parse(response);
        const runs = (data.workflow_runs || []).filter(r =>
          !workflowName || r.name === workflowName
        );
        if (runs.length === 0) {
          return { status: CI_STATUS.UNKNOWN, message: 'No workflow runs found for this branch.' };
        }
        const latest = runs[0];
        const status = this._mapGitHubStatus(latest.status, latest.conclusion);
        return {
          status,
          runId:      latest.id,
          runUrl:     latest.html_url,
          name:       latest.name,
          branch:     latest.head_branch,
          commitSha:  latest.head_sha?.slice(0, 7),
          startedAt:  latest.created_at,
          updatedAt:  latest.updated_at,
          message:    `${latest.name} → ${status}`,
        };
      } catch (err) {
        return { status: CI_STATUS.UNKNOWN, message: `GitHub API error: ${err.message}` };
      }
    };

    if (!wait) return poll();
    return this._waitForCompletion(poll);
  }

  _mapGitHubStatus(status, conclusion) {
    if (status === 'completed') {
      if (conclusion === 'success')   return CI_STATUS.SUCCESS;
      if (conclusion === 'failure')   return CI_STATUS.FAILED;
      if (conclusion === 'cancelled') return CI_STATUS.CANCELLED;
      return CI_STATUS.FAILED;
    }
    if (status === 'in_progress' || status === 'queued') return CI_STATUS.RUNNING;
    return CI_STATUS.PENDING;
  }

  // ─── GitLab CI Status Polling ─────────────────────────────────────────────

  /**
   * Polls GitLab CI for the latest pipeline status on the current branch.
   * Requires GITLAB_TOKEN env var or apiToken constructor option.
   *
   * @param {object} [options]
   * @param {string}  [options.branch] - Branch to check (default: current branch)
   * @param {boolean} [options.wait]   - Wait for completion (default: false)
   * @returns {Promise<CIPollResult>}
   */
  async pollGitLab({ branch = null, wait = false } = {}) {
    if (!this._apiToken) {
      return { status: CI_STATUS.UNKNOWN, message: 'No GitLab token. Set GITLAB_TOKEN env var.' };
    }
    if (!this._repoSlug) {
      return { status: CI_STATUS.UNKNOWN, message: 'Could not detect repo slug from git remote.' };
    }

    const currentBranch = branch || this._getCurrentBranch();
    const encodedSlug   = encodeURIComponent(this._repoSlug);
    const baseUrl       = `${this._apiBaseUrl}/api/v4/projects/${encodedSlug}`;

    const poll = async () => {
      try {
        const url = `${baseUrl}/pipelines?ref=${encodeURIComponent(currentBranch)}&per_page=5&order_by=id&sort=desc`;
        const response = await this._httpGet(url, { 'PRIVATE-TOKEN': this._apiToken });
        const pipelines = JSON.parse(response);
        if (!pipelines.length) {
          return { status: CI_STATUS.UNKNOWN, message: 'No pipelines found for this branch.' };
        }
        const latest = pipelines[0];
        const status = this._mapGitLabStatus(latest.status);
        return {
          status,
          pipelineId: latest.id,
          pipelineUrl: latest.web_url,
          branch:     latest.ref,
          commitSha:  latest.sha?.slice(0, 7),
          startedAt:  latest.created_at,
          updatedAt:  latest.updated_at,
          message:    `Pipeline #${latest.id} → ${status}`,
        };
      } catch (err) {
        return { status: CI_STATUS.UNKNOWN, message: `GitLab API error: ${err.message}` };
      }
    };

    if (!wait) return poll();
    return this._waitForCompletion(poll);
  }

  _mapGitLabStatus(status) {
    const map = {
      'created':  CI_STATUS.PENDING,
      'waiting_for_resource': CI_STATUS.PENDING,
      'preparing': CI_STATUS.PENDING,
      'pending':  CI_STATUS.PENDING,
      'running':  CI_STATUS.RUNNING,
      'success':  CI_STATUS.SUCCESS,
      'failed':   CI_STATUS.FAILED,
      'canceled': CI_STATUS.CANCELLED,
      'skipped':  CI_STATUS.CANCELLED,
      'manual':   CI_STATUS.PENDING,
    };
    return map[status] || CI_STATUS.UNKNOWN;
  }

  // ─── Unified Poll ─────────────────────────────────────────────────────────

  /**
   * Polls the detected CI provider for the latest pipeline status.
   * Auto-detects provider from git remote or environment variables.
   *
   * @param {object} [options]
   * @param {boolean} [options.wait] - Wait for completion
   * @returns {Promise<CIPollResult>}
   */
  async poll(options = {}) {
    switch (this._provider) {
      case 'github': return this.pollGitHub(options);
      case 'gitlab': return this.pollGitLab(options);
      default:
        return { status: CI_STATUS.UNKNOWN, message: `Provider "${this._provider}" does not support remote polling. Use runLocalPipeline() instead.` };
    }
  }

  // ─── Wait Helper ──────────────────────────────────────────────────────────

  async _waitForCompletion(pollFn) {
    const deadline = Date.now() + CI_POLL_TIMEOUT_MS;
    let lastStatus = CI_STATUS.UNKNOWN;

    while (Date.now() < deadline) {
      const result = await pollFn();
      lastStatus = result.status;

      if ([CI_STATUS.SUCCESS, CI_STATUS.FAILED, CI_STATUS.CANCELLED].includes(result.status)) {
        return result;
      }

      console.log(`[CIIntegration] Pipeline ${result.status}... polling again in ${CI_POLL_INTERVAL_MS / 1000}s`);
      await new Promise(r => setTimeout(r, CI_POLL_INTERVAL_MS));
    }

    return { status: lastStatus, message: `Timed out after ${CI_POLL_TIMEOUT_MS / 1000}s waiting for CI` };
  }

  // ─── HTTP Helper ──────────────────────────────────────────────────────────

  _httpGet(url, headers = {}) {
    return new Promise((resolve, reject) => {
      const lib = url.startsWith('https') ? require('https') : require('http');
      const parsedUrl = new URL(url);
      const options = {
        hostname: parsedUrl.hostname,
        path:     parsedUrl.pathname + parsedUrl.search,
        method:   'GET',
        headers:  { 'User-Agent': 'WorkflowAgent/1.0', ...headers },
      };
      const req = lib.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          } else {
            resolve(data);
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(15_000, () => { req.destroy(); reject(new Error('Request timeout')); });
      req.end();
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  _getCurrentBranch() {
    try {
      return execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: this._root, encoding: 'utf-8', stdio: ['pipe','pipe','pipe'],
      }).trim();
    } catch (_) {
      return 'main';
    }
  }

  /** Returns a summary string for display in the observability dashboard. */
  getSummary(result) {
    if (!result) return 'CI: not run';
    const icon = result.status === CI_STATUS.SUCCESS ? '✅'
               : result.status === CI_STATUS.FAILED  ? '❌'
               : result.status === CI_STATUS.RUNNING  ? '🔄'
               : '⚠️ ';
    return `${icon} CI [${result.provider || this._provider}]: ${result.message}`;
  }
}

module.exports = { CIIntegration, CI_STATUS };
