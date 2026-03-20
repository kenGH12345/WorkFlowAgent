/**
 * CIStatusAdapter – Injects CI/CD pipeline status into agent context.
 *
 * Wraps the existing CIIntegration class (ci-integration.js) and exposes
 * the last pipeline run status as structured data that can be injected into
 * DEVELOPER and TESTER stage prompts.
 *
 * Supported CI providers (via CIIntegration):
 *   - 'github'  – GitHub Actions (requires GITHUB_TOKEN)
 *   - 'gitlab'  – GitLab CI (requires GITLAB_TOKEN)
 *   - 'local'   – Local pipeline simulation (lint + test + entropy)
 *
 * Usage:
 *   const adapter = new CIStatusAdapter({ projectRoot: '/path/to/project' });
 *   await adapter.connect();
 *   const status = await adapter.getLastPipelineStatus();
 *   const block = adapter.formatStatusBlock(status);
 */

'use strict';

const { MCPAdapter } = require('./base');

class CIStatusAdapter extends MCPAdapter {
  /**
   * @param {object} config
   * @param {string}  config.projectRoot  - Project root directory
   * @param {string}  [config.provider]   - 'github' | 'gitlab' | 'local' | 'auto'
   * @param {string}  [config.apiToken]   - API token (or use GITHUB_TOKEN / GITLAB_TOKEN env)
   * @param {string}  [config.repoSlug]   - 'owner/repo' for GitHub, 'group/project' for GitLab
   * @param {string}  [config.apiBaseUrl] - GitLab self-hosted base URL
   * @param {number}  [config.timeout]    - HTTP timeout in ms (default: 15000)
   * @param {number}  [config.cacheTtlMs] - Cache TTL in ms (default: 120000 = 2min)
   */
  constructor(config = {}) {
    super('ci-status', config);
    this.projectRoot = config.projectRoot || process.cwd();
    this.timeout = config.timeout || 15000;
    this._cacheTtlMs = config.cacheTtlMs || 120000; // 2 min default
    /** @type {{ data: object, timestamp: number } | null} */
    this._cached = null;
    /** @type {import('../../core/ci-integration').CIIntegration | null} */
    this._ci = null;
  }

  async connect() {
    try {
      const { CIIntegration } = require('../../core/ci-integration');
      this._ci = new CIIntegration({
        projectRoot: this.projectRoot,
        provider:    this.config.provider || 'auto',
        apiToken:    this.config.apiToken || null,
        repoSlug:    this.config.repoSlug || null,
        apiBaseUrl:  this.config.apiBaseUrl || 'https://gitlab.com',
      });
      this._connected = true;
      console.log(`[MCPAdapter:ci-status] Connected (provider: ${this._ci._provider}, repo: ${this._ci._repoSlug || 'local'}).`);
    } catch (err) {
      console.warn(`[MCPAdapter:ci-status] Failed to connect: ${err.message}. CI status injection disabled.`);
      this._connected = false;
    }
  }

  /**
   * Fetches the last CI pipeline status from the detected provider.
   * Results are cached for `cacheTtlMs` to avoid repeated API calls within a single run.
   *
   * @param {object} [options]
   * @param {string}  [options.branch] - Branch to check (default: current branch)
   * @param {boolean} [options.noCache] - Skip cache
   * @returns {Promise<CIStatusResult>}
   */
  async getLastPipelineStatus(options = {}) {
    this._assertConnected();

    // Cache check
    if (!options.noCache && this._cached &&
        (Date.now() - this._cached.timestamp) < this._cacheTtlMs) {
      console.log(`[MCPAdapter:ci-status] Cache hit (age ${Math.round((Date.now() - this._cached.timestamp) / 1000)}s).`);
      return this._cached.data;
    }

    const provider = this._ci._provider;

    // For local provider, we don't poll remote — return a lightweight local status
    if (provider === 'local') {
      const result = this._buildLocalStatus();
      this._cached = { data: result, timestamp: Date.now() };
      return result;
    }

    // Remote poll (GitHub / GitLab)
    try {
      const pollResult = await this._ci.poll({ branch: options.branch, wait: false });
      const result = {
        provider,
        status:     pollResult.status || 'unknown',
        branch:     pollResult.branch || options.branch || 'unknown',
        commitSha:  pollResult.commitSha || '',
        runUrl:     pollResult.runUrl || pollResult.pipelineUrl || '',
        name:       pollResult.name || `Pipeline #${pollResult.pipelineId || '?'}`,
        startedAt:  pollResult.startedAt || '',
        updatedAt:  pollResult.updatedAt || '',
        message:    pollResult.message || '',
        // Detailed job/step info (GitHub only — requires additional API call)
        failedSteps: [],
        flakyTests:  [],
      };

      // For GitHub, attempt to fetch job details for failed runs
      if (provider === 'github' && pollResult.status === 'failed' && pollResult.runId) {
        try {
          const jobs = await this._fetchGitHubJobs(pollResult.runId);
          result.failedSteps = jobs.filter(j => j.conclusion === 'failure').map(j => ({
            name: j.name,
            conclusion: j.conclusion,
            startedAt: j.started_at,
            completedAt: j.completed_at,
          }));
        } catch (_) { /* non-fatal */ }
      }

      this._cached = { data: result, timestamp: Date.now() };
      return result;
    } catch (err) {
      console.warn(`[MCPAdapter:ci-status] Poll failed: ${err.message}`);
      return {
        provider,
        status: 'unknown',
        message: `CI poll failed: ${err.message}`,
        failedSteps: [],
        flakyTests: [],
      };
    }
  }

  /**
   * Formats a CI status result into a Markdown block for prompt injection.
   * Returns empty string if status is 'unknown' or unavailable.
   *
   * @param {CIStatusResult} status
   * @returns {string}
   */
  formatStatusBlock(status) {
    if (!status || status.status === 'unknown') return '';

    const icon = status.status === 'success' ? '✅'
               : status.status === 'failed'  ? '❌'
               : status.status === 'running'  ? '🔄'
               : status.status === 'pending'  ? '⏳'
               : '⚠️';

    const lines = [
      `## 🔄 CI Pipeline Status (Last Run)`,
      `> The following CI/CD status was fetched from the **${status.provider}** pipeline.`,
      `> **Use this to avoid repeating known failures** and to understand the current build health.`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| Status | ${icon} **${status.status.toUpperCase()}** |`,
    ];

    if (status.branch) lines.push(`| Branch | \`${status.branch}\` |`);
    if (status.commitSha) lines.push(`| Commit | \`${status.commitSha}\` |`);
    if (status.name) lines.push(`| Pipeline | ${status.name} |`);
    if (status.updatedAt) lines.push(`| Updated | ${status.updatedAt} |`);
    if (status.runUrl) lines.push(`| URL | ${status.runUrl} |`);

    // Failed steps detail
    if (status.failedSteps && status.failedSteps.length > 0) {
      lines.push(``);
      lines.push(`### ❌ Failed Steps`);
      for (const step of status.failedSteps) {
        lines.push(`- **${step.name}** — \`${step.conclusion}\``);
      }
      lines.push(``);
      lines.push(`> ⚠️ **Action**: Address the failures listed above in your implementation. These are real CI failures from the last pipeline run.`);
    }

    // Flaky tests
    if (status.flakyTests && status.flakyTests.length > 0) {
      lines.push(``);
      lines.push(`### 🔀 Flaky Tests (Intermittent Failures)`);
      for (const test of status.flakyTests) {
        lines.push(`- \`${test.name}\` — failed ${test.failCount}/${test.totalRuns} runs (${Math.round(test.failCount / test.totalRuns * 100)}% flaky rate)`);
      }
    }

    return lines.join('\n');
  }

  // ── MCPAdapter interface ──────────────────────────────────────────────────

  async query(queryStr, params = {}) {
    this._assertConnected();
    const status = await this.getLastPipelineStatus(params);
    return status;
  }

  async notify(event, payload) {
    // CI status is read-only; no-op for notifications
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Builds a lightweight local CI status from git and local test results.
   */
  _buildLocalStatus() {
    const fs = require('fs');
    const path = require('path');

    let lastTestResult = 'unknown';
    try {
      // Check if there's a recent test execution report in the output directory
      const { PATHS } = require('../../core/constants');
      const outputDir = PATHS.OUTPUT_DIR;
      const reportPath = path.join(outputDir, 'test-report.md');
      if (fs.existsSync(reportPath)) {
        const stat = fs.statSync(reportPath);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs < 3600000) { // within 1 hour
          const content = fs.readFileSync(reportPath, 'utf-8').slice(0, 2000);
          if (content.includes('PASS') || content.includes('✅')) lastTestResult = 'success';
          else if (content.includes('FAIL') || content.includes('❌')) lastTestResult = 'failed';
        }
      }
    } catch (_) { /* non-fatal */ }

    return {
      provider: 'local',
      status: lastTestResult,
      branch: this._getCurrentBranch(),
      commitSha: this._getHeadSha(),
      message: `Local CI: last test ${lastTestResult}`,
      failedSteps: [],
      flakyTests: [],
    };
  }

  /**
   * Fetches job details for a GitHub Actions workflow run.
   * @param {number} runId
   * @returns {Promise<Array>}
   */
  async _fetchGitHubJobs(runId) {
    const token = this.config.apiToken || process.env.GITHUB_TOKEN;
    const slug = this._ci._repoSlug;
    if (!token || !slug) return [];

    const url = `https://api.github.com/repos/${slug}/actions/runs/${runId}/jobs?per_page=30`;
    const data = await this._ci._httpGet(url, {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    });
    const parsed = JSON.parse(data);
    return parsed.jobs || [];
  }

  _getCurrentBranch() {
    try {
      const { execSync } = require('child_process');
      return execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: this.projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch (_) {
      return 'unknown';
    }
  }

  _getHeadSha() {
    try {
      const { execSync } = require('child_process');
      return execSync('git rev-parse --short HEAD', {
        cwd: this.projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch (_) {
      return '';
    }
  }

  _assertConnected() {
    if (!this._connected) throw new Error(`[MCPAdapter:ci-status] Not connected. Call connect() first.`);
  }
}

module.exports = { CIStatusAdapter };
