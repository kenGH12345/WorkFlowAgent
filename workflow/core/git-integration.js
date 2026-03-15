/**
 * Git Integration – Cross-session state transfer via Git
 *
 * Inspired by the "long-running agent" pattern described in Anthropic's research:
 *   - Each coding session ends with a descriptive git commit (state snapshot)
 *   - Each new session starts by reading git log to understand previous work
 *   - Git serves as the primary cross-session state transfer mechanism
 *   - Descriptive commit messages allow agents to quickly orient themselves
 *
 * Key capabilities:
 *  1. commitProgress()  – Commit current work with a structured message
 *  2. getRecentLog()    – Read recent commits for session orientation
 *  3. getSessionSummary() – Generate a human-readable session summary from git log
 *  4. isGitRepo()       – Check if the current directory is a git repository
 *  5. initRepo()        – Initialize a git repo if one doesn't exist
 */

'use strict';

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

// ─── Git Integration ──────────────────────────────────────────────────────────

class GitIntegration {
  /**
   * @param {string} [repoPath] - Path to the git repository root (default: cwd)
   */
  constructor(repoPath = null) {
    this.repoPath = repoPath || process.cwd();
  }

  // ─── Repository State ─────────────────────────────────────────────────────────

  /**
   * Checks if the given path is inside a git repository.
   *
   * @returns {boolean}
   */
  isGitRepo() {
    try {
      this._exec('git rev-parse --is-inside-work-tree');
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Initializes a new git repository and creates an initial commit.
   * Safe to call even if a repo already exists (no-op in that case).
   *
   * @param {string} [message] - Initial commit message
   * @returns {{ initialized: boolean, message: string }}
   */
  initRepo(message = 'chore: initial project setup by workflow init agent') {
    if (this.isGitRepo()) {
      return { initialized: false, message: 'Git repository already exists' };
    }

    try {
      this._exec('git init');
      this._exec('git add -A');
      this._exec(`git commit -m "${message}"`);
      console.log(`[GitIntegration] Repository initialized with initial commit`);
      return { initialized: true, message: 'Repository initialized successfully' };
    } catch (err) {
      console.warn(`[GitIntegration] Could not initialize repository: ${err.message}`);
      return { initialized: false, message: err.message };
    }
  }

  // ─── Commit ───────────────────────────────────────────────────────────────────

  /**
   * Stages all changes and creates a structured commit.
   *
   * Commit message format (conventional commits):
   *   <type>(<scope>): <summary>
   *
   *   Session: <sessionId>
   *   Feature: <featureId>
   *   Verified: <verificationNote>
   *
   * @param {object} options
   * @param {string}  options.summary         - Short summary (< 72 chars)
   * @param {string}  [options.type]          - Commit type: feat|fix|chore|refactor|test|docs
   * @param {string}  [options.scope]         - Scope (e.g. feature ID or module name)
   * @param {string}  [options.featureId]     - Feature ID being implemented
   * @param {string}  [options.sessionId]     - Current session identifier
   * @param {string}  [options.verificationNote] - How the change was tested
   * @param {string[]} [options.files]        - Specific files to stage (default: all)
   * @returns {{ success: boolean, commitHash: string|null, message: string }}
   */
  commitProgress({
    summary,
    type = 'feat',
    scope = null,
    featureId = null,
    sessionId = null,
    verificationNote = null,
    files = null,
  }) {
    if (!summary || summary.trim().length === 0) {
      throw new Error('[GitIntegration] Commit summary is required');
    }

    try {
      // Stage files
      if (files && files.length > 0) {
        for (const f of files) {
          this._exec(`git add "${f}"`);
        }
      } else {
        this._exec('git add -A');
      }

      // Check if there's anything to commit
      const status = this._exec('git status --porcelain');
      if (!status.trim()) {
        console.log('[GitIntegration] Nothing to commit – working tree clean');
        return { success: true, commitHash: null, message: 'Nothing to commit' };
      }

      // Build commit message
      const scopePart = scope ? `(${scope})` : '';
      const header = `${type}${scopePart}: ${summary.trim()}`;

      const bodyLines = [];
      if (sessionId)        bodyLines.push(`Session: ${sessionId}`);
      if (featureId)        bodyLines.push(`Feature: ${featureId}`);
      if (verificationNote) bodyLines.push(`Verified: ${verificationNote.trim()}`);
      bodyLines.push(`Timestamp: ${new Date().toISOString()}`);

      const fullMessage = bodyLines.length > 0
        ? `${header}\n\n${bodyLines.join('\n')}`
        : header;

      // Write message to temp file to avoid shell escaping issues
      const tmpMsgFile = path.join(this.repoPath, '.git', 'WORKFLOW_COMMIT_MSG');
      fs.writeFileSync(tmpMsgFile, fullMessage, 'utf-8');

      this._exec(`git commit -F "${tmpMsgFile}"`);

      // Clean up temp file
      try { fs.unlinkSync(tmpMsgFile); } catch (_) {}

      const commitHash = this._exec('git rev-parse --short HEAD').trim();
      console.log(`[GitIntegration] Committed: ${commitHash} – ${header}`);
      return { success: true, commitHash, message: fullMessage };

    } catch (err) {
      console.warn(`[GitIntegration] Commit failed: ${err.message}`);
      return { success: false, commitHash: null, message: err.message };
    }
  }

  // ─── Log Reading ──────────────────────────────────────────────────────────────

  /**
   * Returns recent git log entries for session orientation.
   * This is the primary mechanism for a new agent session to understand
   * what was done in previous sessions.
   *
   * @param {object} [options]
   * @param {number}  [options.limit=20]       - Number of commits to return
   * @param {boolean} [options.oneline=false]  - Return one-line format
   * @param {string}  [options.since]          - Only commits after this date (ISO string)
   * @returns {GitLogEntry[]}
   */
  getRecentLog({ limit = 20, oneline = false, since = null } = {}) {
    try {
      if (!this.isGitRepo()) return [];

      let cmd;
      if (oneline) {
        cmd = `git log --oneline -${limit}`;
        if (since) cmd += ` --since="${since}"`;
        const output = this._exec(cmd);
        return output.trim().split('\n').filter(Boolean).map(line => {
          const [hash, ...rest] = line.split(' ');
          return { hash, message: rest.join(' '), oneline: true };
        });
      }

      // Structured format: hash|author|date|subject|body
      cmd = `git log -${limit} --pretty=format:"%H|%an|%ai|%s|%b"`;
      if (since) cmd += ` --since="${since}"`;
      const output = this._exec(cmd);

      return output.trim().split('\n').filter(Boolean).map(line => {
        const [hash, author, date, subject, ...bodyParts] = line.split('|');
        const body = bodyParts.join('|').trim();

        // Parse structured body fields
        const parsed = { featureId: null, sessionId: null, verifiedBy: null };
        if (body) {
          const featureMatch = body.match(/Feature:\s*(.+)/);
          const sessionMatch = body.match(/Session:\s*(.+)/);
          const verifiedMatch = body.match(/Verified:\s*(.+)/);
          if (featureMatch) parsed.featureId = featureMatch[1].trim();
          if (sessionMatch) parsed.sessionId = sessionMatch[1].trim();
          if (verifiedMatch) parsed.verifiedBy = verifiedMatch[1].trim();
        }

        return { hash, author, date, subject, body, ...parsed };
      });
    } catch (err) {
      console.warn(`[GitIntegration] Could not read git log: ${err.message}`);
      return [];
    }
  }

  /**
   * Generates a human-readable session summary from recent git history.
   * Designed to be injected into the Session Start Checklist prompt so agents
   * can quickly understand what was accomplished in previous sessions.
   *
   * @param {object} [options]
   * @param {number}  [options.limit=10]  - Number of recent commits to summarise
   * @returns {string} - Formatted summary text
   */
  getSessionSummary({ limit = 10 } = {}) {
    if (!this.isGitRepo()) {
      return '## Recent Git History\n\nNo git repository found. Run `git init` to initialize.';
    }

    const entries = this.getRecentLog({ limit });
    if (entries.length === 0) {
      return '## Recent Git History\n\nNo commits yet.';
    }

    const lines = [
      `## Recent Git History (last ${entries.length} commits)`,
      '',
      '> Read this to understand what was done in previous sessions.',
      '',
    ];

    for (const entry of entries) {
      const date = entry.date ? entry.date.slice(0, 16).replace('T', ' ') : '';
      lines.push(`- \`${entry.hash?.slice(0, 7) || '?'}\` ${entry.subject || entry.message} _(${date})_`);
      if (entry.featureId) lines.push(`  - Feature: ${entry.featureId}`);
      if (entry.verifiedBy) lines.push(`  - Verified: ${entry.verifiedBy.slice(0, 80)}`);
    }

    return lines.join('\n');
  }

  /**
   * Returns the current git status (staged, unstaged, untracked files).
   *
   * @returns {{ clean: boolean, staged: string[], unstaged: string[], untracked: string[] }}
   */
  getStatus() {
    try {
      if (!this.isGitRepo()) return { clean: true, staged: [], unstaged: [], untracked: [] };

      const output = this._exec('git status --porcelain');
      const staged = [], unstaged = [], untracked = [];

      for (const line of output.split('\n').filter(Boolean)) {
        const xy = line.slice(0, 2);
        const file = line.slice(3);
        if (xy[0] !== ' ' && xy[0] !== '?') staged.push(file);
        if (xy[1] !== ' ' && xy[1] !== '?') unstaged.push(file);
        if (xy === '??') untracked.push(file);
      }

      return { clean: output.trim().length === 0, staged, unstaged, untracked };
    } catch (err) {
      return { clean: true, staged: [], unstaged: [], untracked: [] };
    }
  }

  /**
   * Returns the current branch name.
   *
   * @returns {string}
   */
  getCurrentBranch() {
    try {
      return this._exec('git rev-parse --abbrev-ref HEAD').trim();
    } catch (_) {
      return 'unknown';
    }
  }

  /**
   * Returns the short hash of the latest commit.
   *
   * @returns {string|null}
   */
  getLatestCommitHash() {
    try {
      return this._exec('git rev-parse --short HEAD').trim();
    } catch (_) {
      return null;
    }
  }

  // ─── Rollback ─────────────────────────────────────────────────────────────────

  /**
   * Rolls back uncommitted changes (git checkout -- .).
   * Use this when the environment is broken and needs to be restored.
   *
   * @param {string[]} [files] - Specific files to rollback (default: all)
   * @returns {{ success: boolean, message: string }}
   */
  rollbackUncommitted(files = null) {
    try {
      if (files && files.length > 0) {
        for (const f of files) {
          this._exec(`git checkout -- "${f}"`);
        }
      } else {
        this._exec('git checkout -- .');
        this._exec('git clean -fd');
      }
      console.log('[GitIntegration] Rolled back uncommitted changes');
      return { success: true, message: 'Uncommitted changes rolled back' };
    } catch (err) {
      return { success: false, message: err.message };
    }
  }

  // ─── Branch Management ────────────────────────────────────────────────────────

  /**
   * Lists all local branches.
   *
   * @returns {string[]} branch names
   */
  listBranches() {
    try {
      const output = this._exec('git branch --format=%(refname:short)');
      return output.trim().split('\n').filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  /**
   * Creates and checks out a new branch from the current HEAD (or a specified base).
   * If the branch already exists, checks it out without recreating.
   *
   * @param {string} branchName - Name of the new branch (e.g. 'feat/user-auth')
   * @param {string} [baseBranch] - Base branch to branch off from (default: current branch)
   * @returns {{ success: boolean, branch: string, message: string }}
   */
  createBranch(branchName, baseBranch = null) {
    if (!branchName || !branchName.trim()) {
      return { success: false, branch: null, message: 'Branch name is required' };
    }

    const sanitized = branchName.trim().replace(/\s+/g, '-');

    try {
      const existing = this.listBranches();
      if (existing.includes(sanitized)) {
        this._exec(`git checkout "${sanitized}"`);
        console.log(`[GitIntegration] Checked out existing branch: ${sanitized}`);
        return { success: true, branch: sanitized, message: `Checked out existing branch: ${sanitized}` };
      }

      if (baseBranch) {
        // Ensure base branch exists locally (fetch if needed)
        try {
          this._exec(`git checkout "${baseBranch}"`);
        } catch (_) {
          this._exec(`git fetch origin "${baseBranch}":"${baseBranch}"`);
          this._exec(`git checkout "${baseBranch}"`);
        }
      }

      this._exec(`git checkout -b "${sanitized}"`);
      console.log(`[GitIntegration] Created and checked out branch: ${sanitized}`);
      return { success: true, branch: sanitized, message: `Branch created: ${sanitized}` };
    } catch (err) {
      console.warn(`[GitIntegration] createBranch failed: ${err.message}`);
      return { success: false, branch: null, message: err.message };
    }
  }

  /**
   * Pushes the current branch (or a named branch) to the remote.
   * Sets upstream tracking automatically.
   *
   * @param {string} [branchName] - Branch to push (default: current branch)
   * @param {string} [remote='origin'] - Remote name
   * @returns {{ success: boolean, branch: string, message: string }}
   */
  pushBranch(branchName = null, remote = 'origin') {
    try {
      const branch = branchName || this.getCurrentBranch();
      this._exec(`git push --set-upstream "${remote}" "${branch}"`);
      console.log(`[GitIntegration] Pushed branch: ${branch} → ${remote}`);
      return { success: true, branch, message: `Pushed ${branch} to ${remote}` };
    } catch (err) {
      console.warn(`[GitIntegration] pushBranch failed: ${err.message}`);
      return { success: false, branch: null, message: err.message };
    }
  }

  /**
   * Merges a source branch into the current branch (or a target branch).
   * Uses --no-ff to always create a merge commit for traceability.
   *
   * @param {string} sourceBranch - Branch to merge from
   * @param {string} [targetBranch] - Branch to merge into (default: current branch)
   * @param {string} [message] - Custom merge commit message
   * @returns {{ success: boolean, commitHash: string|null, message: string }}
   */
  mergeBranch(sourceBranch, targetBranch = null, message = null) {
    try {
      if (targetBranch) {
        this._exec(`git checkout "${targetBranch}"`);
      }
      const current = this.getCurrentBranch();
      const mergeMsg = message || `Merge branch '${sourceBranch}' into ${current}`;
      this._exec(`git merge --no-ff "${sourceBranch}" -m "${mergeMsg}"`);
      const commitHash = this.getLatestCommitHash();
      console.log(`[GitIntegration] Merged ${sourceBranch} → ${current}: ${commitHash}`);
      return { success: true, commitHash, message: `Merged ${sourceBranch} into ${current}` };
    } catch (err) {
      console.warn(`[GitIntegration] mergeBranch failed: ${err.message}`);
      return { success: false, commitHash: null, message: err.message };
    }
  }

  /**
   * Deletes a local branch (and optionally the remote branch).
   *
   * @param {string} branchName - Branch to delete
   * @param {boolean} [deleteRemote=false] - Also delete the remote branch
   * @param {string} [remote='origin'] - Remote name
   * @returns {{ success: boolean, message: string }}
   */
  deleteBranch(branchName, deleteRemote = false, remote = 'origin') {
    try {
      this._exec(`git branch -d "${branchName}"`);
      console.log(`[GitIntegration] Deleted local branch: ${branchName}`);

      if (deleteRemote) {
        try {
          this._exec(`git push "${remote}" --delete "${branchName}"`);
          console.log(`[GitIntegration] Deleted remote branch: ${remote}/${branchName}`);
        } catch (remoteErr) {
          console.warn(`[GitIntegration] Could not delete remote branch: ${remoteErr.message}`);
        }
      }

      return { success: true, message: `Deleted branch: ${branchName}` };
    } catch (err) {
      // Try force delete if normal delete fails (e.g. unmerged branch)
      try {
        this._exec(`git branch -D "${branchName}"`);
        console.log(`[GitIntegration] Force-deleted local branch: ${branchName}`);
        return { success: true, message: `Force-deleted branch: ${branchName}` };
      } catch (forceErr) {
        return { success: false, message: forceErr.message };
      }
    }
  }

  // ─── Pull Request Workflow ────────────────────────────────────────────────────

  /**
   * Creates a Pull Request description file and optionally invokes the GitHub CLI
   * (gh pr create) or GitLab CLI (glab mr create) if available.
   *
   * The PR metadata is always written to output/pr-description.md so it can be
   * used manually or by CI pipelines even when no CLI is available.
   *
   * @param {object} options
   * @param {string}   options.title          - PR title
   * @param {string}   options.body           - PR description (markdown)
   * @param {string}   [options.baseBranch='main'] - Target branch for the PR
   * @param {string}   [options.headBranch]   - Source branch (default: current branch)
   * @param {string[]} [options.labels]       - Labels to apply
   * @param {string[]} [options.reviewers]    - Reviewer usernames
   * @param {boolean}  [options.draft=false]  - Create as draft PR
   * @param {string}   [options.outputDir]    - Where to write pr-description.md
   * @returns {{ success: boolean, prUrl: string|null, prFile: string, message: string }}
   */
  createPR({
    title,
    body,
    baseBranch = 'main',
    headBranch = null,
    labels = [],
    reviewers = [],
    draft = false,
    outputDir = null,
  }) {
    if (!title || !title.trim()) {
      return { success: false, prUrl: null, prFile: null, message: 'PR title is required' };
    }

    const head = headBranch || this.getCurrentBranch();
    const resolvedOutputDir = outputDir || path.join(this.repoPath, 'workflow', 'output');

    // ── 1. Write PR description file (always) ────────────────────────────────
    const prFile = path.join(resolvedOutputDir, 'pr-description.md');
    const prContent = this._buildPRDescription({ title, body, baseBranch, head, labels, reviewers, draft });

    try {
      if (!fs.existsSync(resolvedOutputDir)) {
        fs.mkdirSync(resolvedOutputDir, { recursive: true });
      }
      fs.writeFileSync(prFile, prContent, 'utf-8');
      console.log(`[GitIntegration] PR description written to: ${prFile}`);
    } catch (writeErr) {
      console.warn(`[GitIntegration] Could not write PR description: ${writeErr.message}`);
    }

    // ── 2. Try GitHub CLI (gh) ────────────────────────────────────────────────
    const ghResult = this._tryGitHubCLI({ title, body, baseBranch, head, labels, reviewers, draft });
    if (ghResult.success) {
      return { success: true, prUrl: ghResult.prUrl, prFile, message: ghResult.message };
    }

    // ── 3. Try GitLab CLI (glab) ──────────────────────────────────────────────
    const glabResult = this._tryGitLabCLI({ title, body, baseBranch, head, labels, reviewers, draft });
    if (glabResult.success) {
      return { success: true, prUrl: glabResult.prUrl, prFile, message: glabResult.message };
    }

    // ── 4. Fallback: PR description file only ────────────────────────────────
    console.log(`[GitIntegration] No Git CLI available. PR description saved to: ${prFile}`);
    console.log(`[GitIntegration] To create the PR manually:`);
    console.log(`  GitHub: gh pr create --base "${baseBranch}" --head "${head}" --title "${title}"`);
    console.log(`  GitLab: glab mr create --source-branch "${head}" --target-branch "${baseBranch}" --title "${title}"`);

    return {
      success: true,
      prUrl: null,
      prFile,
      message: `PR description saved (no CLI available). File: ${prFile}`,
    };
  }

  /**
   * Builds the full PR description markdown content.
   *
   * @private
   */
  _buildPRDescription({ title, body, baseBranch, head, labels, reviewers, draft }) {
    const lines = [
      `# ${title}`,
      '',
      `**Branch:** \`${head}\` → \`${baseBranch}\``,
      draft ? '**Status:** 🚧 Draft' : '**Status:** Ready for Review',
      '',
    ];

    if (labels.length > 0) {
      lines.push(`**Labels:** ${labels.map(l => `\`${l}\``).join(', ')}`);
      lines.push('');
    }

    if (reviewers.length > 0) {
      lines.push(`**Reviewers:** ${reviewers.map(r => `@${r}`).join(', ')}`);
      lines.push('');
    }

    lines.push('---', '');

    if (body) {
      lines.push(body);
    } else {
      // Auto-generate body from recent git log
      try {
        const log = this.getRecentLog({ limit: 10 });
        if (log.length > 0) {
          lines.push('## Changes', '');
          for (const entry of log) {
            lines.push(`- ${entry.subject || entry.message}`);
          }
        }
      } catch (_) {}
    }

    lines.push('', '---');
    lines.push(`*Generated by WorkFlowAgent at ${new Date().toISOString()}*`);

    return lines.join('\n');
  }

  /**
   * Attempts to create a PR using the GitHub CLI (gh).
   *
   * @private
   * @returns {{ success: boolean, prUrl: string|null, message: string }}
   */
  _tryGitHubCLI({ title, body, baseBranch, head, labels, reviewers, draft }) {
    try {
      // Check if gh is available
      this._exec('gh --version');
    } catch (_) {
      return { success: false, prUrl: null, message: 'gh CLI not available' };
    }

    try {
      const args = [
        `gh pr create`,
        `--base "${baseBranch}"`,
        `--head "${head}"`,
        `--title "${title.replace(/"/g, '\\"')}"`,
      ];

      if (body) {
        // Write body to temp file to avoid shell escaping issues
        const tmpBody = path.join(this.repoPath, '.git', 'PR_BODY_TMP');
        fs.writeFileSync(tmpBody, body, 'utf-8');
        args.push(`--body-file "${tmpBody}"`);
      }

      if (draft) args.push('--draft');
      if (labels.length > 0) args.push(`--label "${labels.join(',')}"`);
      if (reviewers.length > 0) args.push(`--reviewer "${reviewers.join(',')}"`);

      const output = this._exec(args.join(' '));
      const prUrl = output.trim().split('\n').pop(); // gh outputs the PR URL as last line

      // Clean up temp body file
      try { fs.unlinkSync(path.join(this.repoPath, '.git', 'PR_BODY_TMP')); } catch (_) {}

      console.log(`[GitIntegration] ✅ GitHub PR created: ${prUrl}`);
      return { success: true, prUrl, message: `GitHub PR created: ${prUrl}` };
    } catch (err) {
      console.warn(`[GitIntegration] gh pr create failed: ${err.message}`);
      return { success: false, prUrl: null, message: err.message };
    }
  }

  /**
   * Attempts to create an MR using the GitLab CLI (glab).
   *
   * @private
   * @returns {{ success: boolean, prUrl: string|null, message: string }}
   */
  _tryGitLabCLI({ title, body, baseBranch, head, labels, reviewers, draft }) {
    try {
      this._exec('glab --version');
    } catch (_) {
      return { success: false, prUrl: null, message: 'glab CLI not available' };
    }

    try {
      const args = [
        `glab mr create`,
        `--source-branch "${head}"`,
        `--target-branch "${baseBranch}"`,
        `--title "${title.replace(/"/g, '\\"')}"`,
        '--yes', // skip interactive prompts
      ];

      if (body) {
        const tmpBody = path.join(this.repoPath, '.git', 'MR_BODY_TMP');
        fs.writeFileSync(tmpBody, body, 'utf-8');
        args.push(`--description "$(cat '${tmpBody}')"`);
      }

      if (draft) args.push('--draft');
      if (labels.length > 0) args.push(`--label "${labels.join(',')}"`);
      if (reviewers.length > 0) args.push(`--reviewer "${reviewers.join(',')}"`);

      const output = this._exec(args.join(' '));
      const mrUrl = output.trim().split('\n').find(l => l.startsWith('http')) || null;

      try { fs.unlinkSync(path.join(this.repoPath, '.git', 'MR_BODY_TMP')); } catch (_) {}

      console.log(`[GitIntegration] ✅ GitLab MR created: ${mrUrl}`);
      return { success: true, prUrl: mrUrl, message: `GitLab MR created: ${mrUrl}` };
    } catch (err) {
      console.warn(`[GitIntegration] glab mr create failed: ${err.message}`);
      return { success: false, prUrl: null, message: err.message };
    }
  }

  /**
   * Generates a workflow-standard branch name from a requirement or task title.
   * Format: feat/<date>-<slug>  (e.g. feat/20260315-user-auth-api)
   *
   * @param {string} title - Requirement or task title
   * @param {string} [type='feat'] - Branch type prefix: feat|fix|chore|refactor
   * @returns {string} sanitized branch name
   */
  generateBranchName(title, type = 'feat') {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 40)
      .replace(/-+$/, '');
    return `${type}/${date}-${slug}`;
  }

  // ─── Internal Helpers ─────────────────────────────────────────────────────────

  /**
   * Executes a git command synchronously in the repo directory.
   *
   * @param {string} cmd
   * @returns {string} stdout
   * @throws {Error} if the command fails
   */
  _exec(cmd) {
    return execSync(cmd, {
      cwd: this.repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
}

module.exports = { GitIntegration };
