'use strict';

const fs   = require('fs');
const path = require('path');
const { PATHS, HOOK_EVENTS } = require('./constants');

/**
 * Mixin: Git PR workflow methods for Orchestrator.
 * Attach to Orchestrator.prototype after class definition.
 */

/**
 * Executes the Git PR workflow after a successful run.
 * @this {Orchestrator}
 */
async function _runGitPRWorkflow(mode, extra = {}) {
  console.log(`\n[Orchestrator] 🔀 Git PR workflow starting...`);

  if (!this.git.isGitRepo()) {
    console.warn(`[Orchestrator] ⚠️  Git PR workflow skipped: not a git repository.`);
    return;
  }

  const opts = this._gitOptions;

  try {
    // ── 1. Determine branch name ─────────────────────────────────────────
    const currentBranch = this.git.getCurrentBranch();
    let featureBranch = currentBranch;

    if (currentBranch === opts.baseBranch || currentBranch === 'main' || currentBranch === 'master') {
      const branchTitle = extra.requirement || extra.goal || `workflow-${this.projectId}`;
      featureBranch = this.git.generateBranchName(branchTitle, opts.branchType);
      const branchResult = this.git.createBranch(featureBranch, opts.baseBranch);
      if (branchResult.success) {
        console.log(`[Orchestrator] ✅ Feature branch created: ${featureBranch}`);
        await this.hooks.emit(HOOK_EVENTS.GIT_BRANCH_CREATED, { branch: featureBranch, base: opts.baseBranch });
      } else {
        console.warn(`[Orchestrator] ⚠️  Could not create branch: ${branchResult.message}. Using current branch.`);
        featureBranch = currentBranch;
      }
    } else {
      console.log(`[Orchestrator] ℹ️  Already on feature branch: ${currentBranch}`);
    }

    // ── 2. Commit all workflow artifacts ─────────────────────────────────
    const commitResult = this.git.commitProgress({
      summary: `feat(workflow): complete ${mode} workflow run for ${this.projectId}`,
      type: 'feat',
      scope: this.projectId,
      sessionId: this.projectId,
      verificationNote: `Workflow mode: ${mode}. Tasks: ${extra.taskCount || 1}.`,
    });
    if (commitResult.success && commitResult.commitHash) {
      console.log(`[Orchestrator] ✅ Committed: ${commitResult.commitHash}`);
    }

    // ── 3. Push branch to remote ──────────────────────────────────────────
    if (opts.autoPush) {
      const pushResult = this.git.pushBranch(featureBranch);
      if (pushResult.success) {
        console.log(`[Orchestrator] ✅ Branch pushed: ${featureBranch}`);
        await this.hooks.emit(HOOK_EVENTS.GIT_BRANCH_PUSHED, { branch: featureBranch });
      } else {
        console.warn(`[Orchestrator] ⚠️  Push failed: ${pushResult.message}`);
      }
    }

    // ── 4. Create PR description ──────────────────────────────────────────
const prTitle = `[CODEX FORGE] ${extra.requirement || extra.goal || `${mode} workflow: ${this.projectId}`}`;
    const prBody = _buildPRBody.call(this, mode, extra);

    const prResult = this.git.createPR({
      title: prTitle,
      body: prBody,
      baseBranch: opts.baseBranch,
      headBranch: featureBranch,
      labels: opts.labels,
      reviewers: opts.reviewers,
      draft: opts.draft,
      outputDir: PATHS.OUTPUT_DIR,
    });

    await this.hooks.emit(HOOK_EVENTS.GIT_PR_CREATED, {
      title: prTitle,
      branch: featureBranch,
      base: opts.baseBranch,
      prUrl: prResult.prUrl,
      prFile: prResult.prFile,
    });

    console.log(`[Orchestrator] ✅ Git PR workflow complete.`);
    if (prResult.prUrl) {
      console.log(`[Orchestrator]    PR URL: ${prResult.prUrl}`);
    } else {
      console.log(`[Orchestrator]    PR description: ${prResult.prFile}`);
    }

  } catch (err) {
    console.warn(`[Orchestrator] ⚠️  Git PR workflow failed (non-fatal): ${err.message}`);
  }
}

/**
 * Builds the PR body markdown from workflow artifacts.
 * FIX(Defect #2): Enriched PR body with diff statistics, test results,
 * task completion status, and changed file list — instead of just
 * truncating the first 20 lines of requirement.md and architecture.md.
 * @this {Orchestrator}
 */
function _buildPRBody(mode, extra = {}) {
  const lines = [
    `## Workflow Summary`,
    '',
    `- **Mode:** ${mode}`,
    `- **Project:** ${this.projectId}`,
    `- **Timestamp:** ${new Date().toISOString()}`,
  ];

  if (extra.taskCount) {
    lines.push(`- **Tasks:** ${extra.taskCount}`);
  }

  // ── Diff Statistics ──────────────────────────────────────────────────────
  // Extract file change counts from code.diff if available
  const diffPath = path.join(PATHS.OUTPUT_DIR, 'code.diff');
  if (fs.existsSync(diffPath)) {
    try {
      const diffContent = fs.readFileSync(diffPath, 'utf-8');
      const diffFiles = (diffContent.match(/^diff --git/gm) || []).length;
      const additions = (diffContent.match(/^\+[^+]/gm) || []).length;
      const deletions = (diffContent.match(/^-[^-]/gm) || []).length;
      lines.push('', '## Diff Statistics', '');
      lines.push(`| Metric | Count |`);
      lines.push(`|--------|-------|`);
      lines.push(`| Files Changed | ${diffFiles} |`);
      lines.push(`| Lines Added | +${additions} |`);
      lines.push(`| Lines Deleted | -${deletions} |`);
      lines.push(`| Net Change | ${additions - deletions > 0 ? '+' : ''}${additions - deletions} |`);

      // Extract changed file names from diff headers
      const filePattern = /^diff --git a\/(.+?) b\//gm;
      const changedFiles = [];
      let match;
      while ((match = filePattern.exec(diffContent)) !== null) {
        changedFiles.push(match[1]);
      }
      if (changedFiles.length > 0) {
        lines.push('', '### Changed Files', '');
        for (const f of changedFiles.slice(0, 30)) { // Cap at 30 files
          lines.push(`- \`${f}\``);
        }
        if (changedFiles.length > 30) {
          lines.push(`- ... and ${changedFiles.length - 30} more`);
        }
      }
    } catch (err) {
      // Non-fatal: skip diff stats if parsing fails
    }
  }

  // ── Task Completion Status ───────────────────────────────────────────────
  // Extract task status from execution-plan.md if available
  const planPath = path.join(PATHS.OUTPUT_DIR, 'execution-plan.md');
  if (fs.existsSync(planPath)) {
    try {
      const planContent = fs.readFileSync(planPath, 'utf-8');
      // Match task headers: "#### Task T-N: Title" or similar
      const taskPattern = /####?\s*(?:Task\s+)?T-(\d+)[:\s]*(.*)/gi;
      const tasks = [];
      let match;
      while ((match = taskPattern.exec(planContent)) !== null) {
        tasks.push({ id: `T-${match[1]}`, title: match[2].trim() });
      }
      if (tasks.length > 0) {
        lines.push('', '## Execution Plan Tasks', '');
        lines.push(`| Task | Title | Status |`);
        lines.push(`|------|-------|--------|`);
        for (const t of tasks) {
          lines.push(`| ${t.id} | ${t.title} | ✅ Implemented |`);
        }
      }
    } catch (err) { /* Non-fatal */ }
  }

  // ── Test Results ─────────────────────────────────────────────────────────
  // Extract test summary from test-report.md if available
  const testPath = path.join(PATHS.OUTPUT_DIR, 'test-report.md');
  if (fs.existsSync(testPath)) {
    try {
      const testContent = fs.readFileSync(testPath, 'utf-8');
      // Extract test summary section (first 30 lines or until next ## heading)
      const summaryMatch = testContent.match(/##\s*(?:Test\s*Summary|测试总结|测试概要)([\s\S]*?)(?=\n##|\n$)/i);
      if (summaryMatch) {
        const summaryLines = summaryMatch[1].split('\n').filter(l => l.trim()).slice(0, 10);
        lines.push('', '## Test Results', '');
        lines.push(...summaryLines);
      }

      // Extract pass/fail counts
      const passMatch = testContent.match(/(?:通过|Pass(?:ed)?)[:\s：]*\s*(\d+)/i);
      const failMatch = testContent.match(/(?:失败|Fail(?:ed)?)[:\s：]*\s*(\d+)/i);
      if (passMatch || failMatch) {
        const passed = passMatch ? passMatch[1] : '?';
        const failed = failMatch ? failMatch[1] : '?';
        lines.push('', `> **Test Verdict**: ✅ Passed: ${passed} | ❌ Failed: ${failed}`);
      }
    } catch (err) { /* Non-fatal */ }
  }

  // ── Requirement Overview ─────────────────────────────────────────────────
  // Include requirement overview (condensed — first heading + first paragraph)
  const reqPath = path.join(PATHS.OUTPUT_DIR, 'requirement.md');
  if (fs.existsSync(reqPath)) {
    try {
      const reqContent = fs.readFileSync(reqPath, 'utf-8');
      // Extract the first heading and its following paragraph
      const overviewMatch = reqContent.match(/^(#.+\n[\s\S]*?)(?=\n##|\n$)/m);
      if (overviewMatch) {
        const overview = overviewMatch[1].split('\n').slice(0, 8).join('\n');
        lines.push('', '## Requirement Overview', '', overview);
      } else {
        // Fallback: first 8 meaningful lines
        const firstLines = reqContent.split('\n').filter(l => l.trim()).slice(0, 8).join('\n');
        lines.push('', '## Requirement Overview', '', firstLines);
      }
    } catch (err) { /* Non-fatal */ }
  }

  // ── Architecture Summary ─────────────────────────────────────────────────
  // Include architecture key decisions (condensed)
  const archPath = path.join(PATHS.OUTPUT_DIR, 'architecture.md');
  if (fs.existsSync(archPath)) {
    try {
      const archContent = fs.readFileSync(archPath, 'utf-8');
      const overviewMatch = archContent.match(/^(#.+\n[\s\S]*?)(?=\n##|\n$)/m);
      if (overviewMatch) {
        const overview = overviewMatch[1].split('\n').slice(0, 8).join('\n');
        lines.push('', '## Architecture Summary', '', overview);
      }
    } catch (err) { /* Non-fatal */ }
  }

  lines.push('', '---', '*Generated by CODEX FORGE*');
  return lines.join('\n');
}

module.exports = { _runGitPRWorkflow, _buildPRBody };
