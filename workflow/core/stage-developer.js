/**
 * Stage Runner: DEVELOPER
 *
 * Extracted from orchestrator-stages.js (P0 decomposition – ADR-33).
 * Contains: _runDeveloper
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { PATHS, HOOK_EVENTS } = require('./constants');
const { AgentRole, WorkflowState } = require('./types');
const { ExperienceType, ExperienceCategory } = require('./experience-store');
const { CodeReviewAgent } = require('./code-review-agent');
const { RollbackCoordinator } = require('./rollback-coordinator');
const { QualityGate } = require('./quality-gate');
const { translateMdFile } = require('./i18n-translator');
const { runEvoMapFeedback } = require('./stage-runner-utils');
const { _recordPromptABOutcome } = require('./stage-analyst');
const {
  buildDeveloperUpstreamCtx,
  buildDeveloperContextBlock,
  storeCodeContext,
  codeQualityHelper,
} = require('./orchestrator-stage-helpers');

// Forward reference: _runArchitect is needed for rollback. Lazy-loaded to avoid circular deps.
let _runArchitect = null;
function _getRunArchitect() {
  if (!_runArchitect) {
    _runArchitect = require('./stage-architect')._runArchitect;
  }
  return _runArchitect;
}

/**
 * Runs the CODE stage: code generation, code review, quality gate, and rollback.
 *
 * P1-2 fix: @this annotation for IDE IntelliSense and safe refactoring.
 *
 * @this {import('./orchestrator').Orchestrator}
 * @returns {Promise<string>} Path to the generated code.diff
 */
async function _runDeveloper() {
  console.log(`\n[Orchestrator] Stage: CODE (DeveloperAgent)`);
  const inputPath = this.bus.consume(AgentRole.DEVELOPER);

  // ── Read execution plan from PLAN stage ────────────────────────────────
  // The PLAN stage publishes the architecture.md path as the main artifact
  // and stores the execution-plan.md path in metadata.
  const planMeta = this.bus.getMeta(AgentRole.DEVELOPER);
  let executionPlanContent = '';
  if (planMeta && planMeta.executionPlanPath) {
    try {
      if (fs.existsSync(planMeta.executionPlanPath)) {
        executionPlanContent = fs.readFileSync(planMeta.executionPlanPath, 'utf-8');
        console.log(`[Orchestrator] 📋 Execution plan loaded (${executionPlanContent.length} chars) from ${planMeta.executionPlanPath}`);
      }
    } catch (planErr) {
      console.warn(`[Orchestrator] ⚠️  Could not read execution plan (non-fatal): ${planErr.message}`);
    }
  }

  const upstreamCtxForDevStr = buildDeveloperUpstreamCtx(this);

  // P0-1 fix: buildDeveloperUpstreamCtx returns a primitive string.
  // Wrap in an object so we can attach executionPlanBlock without silent failure.
  // (Previously: `upstreamCtxForDev.executionPlanBlock = ...` silently failed on primitive string.)
  const upstreamCtxForDev = { text: upstreamCtxForDevStr, executionPlanBlock: '' };
  if (executionPlanContent) {
    upstreamCtxForDev.executionPlanBlock = `\n## Execution Plan (from PLAN stage)\n${executionPlanContent.slice(0, 8000)}${executionPlanContent.length > 8000 ? '\n... (truncated)' : ''}`;
  }

  const archMeta = planMeta || this.bus.getMeta(AgentRole.DEVELOPER);
  if (archMeta && archMeta.reviewRounds > 0) {
    console.log(`[Orchestrator] ℹ️  Architecture was self-corrected in ${archMeta.reviewRounds} round(s) (${archMeta.failedItems} issue(s) fixed). Developer should review architecture.md carefully.`);
  }

  // A-3 fix: buildDeveloperContextBlock now returns { content, injectedExpIds } struct
  const devContextResult = await buildDeveloperContextBlock(this, upstreamCtxForDev);
  const devExpContext = devContextResult.content;
  const devInjectedExpIds = devContextResult.injectedExpIds || [];
  this.obs.recordExpUsage({ injected: devInjectedExpIds.length });

  const outputPath = await this.agents[AgentRole.DEVELOPER].run(inputPath, null, devExpContext);

  // ── Adapter Telemetry ─────────────────────────────────────────────────────
  if (this._adapterTelemetry && outputPath && fs.existsSync(outputPath)) {
    try {
      const devOutput = fs.readFileSync(outputPath, 'utf-8');
      this._adapterTelemetry.scanReferences(devOutput, 'DEVELOPER');
    } catch (_) { /* non-fatal */ }
  }

  // ── Code Quality injection ────────────────────────────────────────────────
  let codeQualityContext = '';
  try {
    const cqResult = await codeQualityHelper(this, {
      maxIssues: 15,
      label: 'Code Quality (CodeReview)',
    });
    if (cqResult && cqResult.block) {
      codeQualityContext = cqResult.block;
      if (cqResult.qualityGate && cqResult.qualityGate.status === 'ERROR') {
        this.stateMachine.recordRisk('medium',
          `[CodeQuality] Quality gate FAILED: ${(cqResult.qualityGate.conditions || []).filter(c => c.status !== 'OK').map(c => c.metric).join(', ')}`,
          false
        );
      }
    }
  } catch (err) {
    console.warn(`[Orchestrator] 📊 Code quality scan for CodeReview failed (non-fatal): ${err.message}`);
  }

  let qualityInjected = false;
  if (codeQualityContext && outputPath && fs.existsSync(outputPath)) {
    try {
      const CQ_SENTINEL_START = '# ── CQ_INJECT_9f3a7b2e_START ──';
      const CQ_SENTINEL_END   = '# ── CQ_INJECT_9f3a7b2e_END ──';
      const qualityHeader = `\n\n${CQ_SENTINEL_START}\n# Code Quality Metrics (auto-injected by CodeQuality MCP)\n# The following metrics are from real static analysis. Use them to\n# inform your review decisions, especially for PERF and STYLE items.\n# ${codeQualityContext.replace(/\n/g, '\n# ')}\n${CQ_SENTINEL_END}\n\n`;
      fs.appendFileSync(outputPath, qualityHeader, 'utf-8');
      qualityInjected = true;
    } catch (_) { /* non-fatal */ }
  }

  const requirementPath = path.join(PATHS.OUTPUT_DIR, 'requirements.md');
  const reviewer = new CodeReviewAgent(
    this._rawLlmCall,
    {
      maxRounds: 2,
      verbose: true,
      outputDir: PATHS.OUTPUT_DIR,
      investigationTools: this._buildInvestigationTools('Code'),
    }
  );
  const reviewResult = await reviewer.review(outputPath, requirementPath);

  // Clean up injected quality context
  if (qualityInjected && outputPath && fs.existsSync(outputPath)) {
    try {
      let diffContent = fs.readFileSync(outputPath, 'utf-8');
      const qualityStart = diffContent.indexOf('\n\n# ── CQ_INJECT_9f3a7b2e_START ──');
      if (qualityStart !== -1) {
        diffContent = diffContent.slice(0, qualityStart);
        fs.writeFileSync(outputPath, diffContent, 'utf-8');
      }
    } catch (_) { /* non-fatal */ }
  }

  const codeSubtaskCoordinator = new RollbackCoordinator(this);
  codeSubtaskCoordinator.cacheSubtaskResult(WorkflowState.CODE, 'CodeGeneration', { outputPath });
  codeSubtaskCoordinator.cacheSubtaskResult(WorkflowState.CODE, 'CodeReview', reviewResult);

  // ── P0-2: Module Boundary Violation Check ─────────────────────────────────
  // After code generation, verify that the developer's file changes respect the
  // module boundaries defined in the Module Map. This is "Trust but Verify":
  // the developer was told to stay within boundaries, now we check compliance.
  try {
    const analyseCtx = this.stageCtx?.get(WorkflowState.ANALYSE);
    const planCtx = this.stageCtx?.get(WorkflowState.PLAN);
    const moduleMap = analyseCtx?.meta?.moduleMap;
    const moduleGrouping = planCtx?.meta?.moduleGrouping;

    if (moduleMap && Array.isArray(moduleMap.modules) && moduleMap.modules.length > 0 && outputPath && fs.existsSync(outputPath)) {
      // Parse the developer's output to extract files mentioned/changed
      const devOutput = fs.readFileSync(outputPath, 'utf-8');
      // Extract file paths from common diff patterns: +++ b/path, --- a/path, or explicit file references
      const filePatterns = [
        /^[+]{3}\s+b\/(.+)$/gm,    // unified diff: +++ b/path
        /^[-]{3}\s+a\/(.+)$/gm,    // unified diff: --- a/path
        /^\+\+\+\s+(.+)$/gm,       // other diff formats
      ];
      const mentionedFiles = new Set();
      for (const pattern of filePatterns) {
        let m;
        while ((m = pattern.exec(devOutput)) !== null) {
          const filePath = m[1].trim().replace(/\\/g, '/');
          if (filePath && filePath !== '/dev/null' && !filePath.startsWith('null')) {
            mentionedFiles.add(filePath);
          }
        }
      }

      if (mentionedFiles.size > 0) {
        // Determine which module(s) the current task belongs to
        // Use all module boundaries combined for a comprehensive check
        const allBoundaries = moduleMap.modules.flatMap(m => m.boundaries || []);
        if (allBoundaries.length > 0) {
          const boundaryCheck = QualityGate.checkModuleBoundaryViolation(
            [...mentionedFiles],
            { moduleId: 'all-modules', boundaries: allBoundaries }
          );
          if (!boundaryCheck.clean) {
            console.warn(`[Orchestrator] ⚠️  ${boundaryCheck.summary}`);
            this.stateMachine.recordRisk('low',
              `[ModuleBoundary] ${boundaryCheck.violations.length} file(s) modified outside defined module boundaries: ${boundaryCheck.violations.slice(0, 3).join(', ')}`,
              false
            );
          } else {
            console.log(`[Orchestrator] ✅ Module boundary check passed: ${boundaryCheck.summary}`);
          }
        }
      }
    }
  } catch (boundaryErr) {
    console.warn(`[Orchestrator] ⚠️  Module boundary check failed (non-fatal): ${boundaryErr.message}`);
  }

  for (const note of reviewResult.riskNotes) {
    const severity = note.includes('(high)') ? 'high' : 'medium';
    this.stateMachine.recordRisk(severity, note, false);
  }
  this.stateMachine.flushRisks();

  const codeGate = new QualityGate({ experienceStore: this.experienceStore, maxRollbacks: 1 });
  const codeRollbackCountForGate = this._rollbackCounters?.get(WorkflowState.CODE) ?? 0;
  const codeDecision = codeGate.evaluate(reviewResult, WorkflowState.CODE, codeRollbackCountForGate);
  codeGate.recordExperience(codeDecision, WorkflowState.CODE, reviewResult, { skill: 'code-development', category: ExperienceCategory.STABLE_PATTERN });

  _recordPromptABOutcome('developer', codeDecision.pass, reviewResult.rounds ?? 0);

  if (codeDecision.pass) {
    console.log(`[Orchestrator] ✅ Code review passed. Reason: ${codeDecision.reason}`);
  } else if (codeDecision.rollback) {
    console.warn(`[Orchestrator] ⚠️  ${reviewResult.failed} high-severity code issue(s) remain. Attempting rollback to ARCHITECT stage.`);
    const failedNotes = reviewResult.riskNotes.slice(0, 3).join('; ');
    const failContent = `After ${reviewResult.rounds ?? 'N/A'} self-correction round(s), ${reviewResult.failed} high-severity issue(s) remained. Issues: ${failedNotes}`;
    if (!this.experienceStore.appendByTitle('Code review: high-severity issues unresolved after self-correction', failContent)) {
      this.experienceStore.record({
        type: ExperienceType.NEGATIVE,
        category: ExperienceCategory.PITFALL,
        title: 'Code review: high-severity issues unresolved after self-correction',
        content: failContent,
        skill: 'code-development',
        tags: ['code-review', 'failed', 'pitfall'],
      });
    }

    const codeRollbackCount = this._rollbackCounters?.get(WorkflowState.CODE) ?? 0;
    if (this._rollbackCounters) this._rollbackCounters.set(WorkflowState.CODE, codeRollbackCount + 1);
    if (this.stageCtx) {
      const existingCode = this.stageCtx.get(WorkflowState.CODE) || {};
      this.stageCtx.set(WorkflowState.CODE, {
        ...existingCode,
        meta: { ...(existingCode.meta || {}), _codeRollbackCount: codeRollbackCount + 1 },
      });
    }
    try {
      const coordinator = new RollbackCoordinator(this);
      const codeStrategy = coordinator.analyseRollbackStrategy(
        WorkflowState.CODE, `Code review failed: ${failedNotes}`, 'CodeReview'
      );

      if (codeStrategy.type === 'SUBTASK_RETRY' && codeStrategy.cachedResults) {
        console.log(`[Orchestrator] 🎯 Defect C: Subtask-level retry for CODE. ${codeStrategy.reason}`);

        const retryCodeReviewer = new CodeReviewAgent(
          this._rawLlmCall,
          {
            maxRounds: 2,
            verbose: true,
            outputDir: PATHS.OUTPUT_DIR,
            investigationTools: this._buildInvestigationTools('Code'),
          }
        );
        const reqPath = path.join(PATHS.OUTPUT_DIR, 'requirements.md');

        const retryNote = `\n\n// --- Code Review Retry (Attempt ${codeRollbackCount + 1}) ---\n// Previous review found these issues:\n// ${failedNotes.replace(/\n/g, '\n// ')}\n// Please address the above.`;
        fs.appendFileSync(outputPath, retryNote, 'utf-8');

        const retryReview = await retryCodeReviewer.review(outputPath, reqPath);

        const retryCodeGate = new QualityGate({ experienceStore: this.experienceStore, maxRollbacks: 1 });
        const retryCodeDecision = retryCodeGate.evaluate(retryReview, WorkflowState.CODE, codeRollbackCount + 1);

        if (retryCodeDecision.pass) {
          console.log(`[Orchestrator] ✅ Subtask-level retry succeeded: CodeReview passed on retry.`);
          coordinator.cacheSubtaskResult(WorkflowState.CODE, 'CodeReview', retryReview);

          const codeOutputCtx = storeCodeContext(this, outputPath, retryReview);
          this.bus.publish(AgentRole.DEVELOPER, AgentRole.TESTER, outputPath, {
            reviewRounds:   retryReview.rounds ?? 0,
            failedItems:    retryReview.failed ?? 0,
            riskNotes:      retryReview.riskNotes ?? [],
            contextSummary: codeOutputCtx.summary,
          });
          return outputPath;
        }

        console.log(`[Orchestrator] ⚠️  Subtask-level retry failed for CODE. Falling through to full-stage rollback.`);
        coordinator.invalidateSubtaskCache(WorkflowState.CODE);
      }

      // ── Full-stage rollback ──────────────────────────────────────────────
      await coordinator.rollback(WorkflowState.CODE, `Code review failed: ${failedNotes.slice(0, 200)}`);

      const archOutputPath = path.join(PATHS.OUTPUT_DIR, 'architecture.md');
      if (fs.existsSync(archOutputPath)) {
        const failureNote = `\n\n---\n## ⚠️ Code Review Failure (Retry ${codeRollbackCount + 1})\n\nThe previous code implementation failed review with these issues:\n${failedNotes}\n\nPlease revise the architecture to address these code-level concerns before the developer retries.`;
        fs.appendFileSync(archOutputPath, failureNote, 'utf-8');
        this.bus.publish(AgentRole.ANALYST, AgentRole.ARCHITECT, archOutputPath, {
          codeReviewFailed: true,
          failedNotes,
          rollbackRetry: codeRollbackCount + 1,
        });
      }
      if (this.stageCtx) {
        const existingCodeCtx = this.stageCtx.get(WorkflowState.CODE) || {};
        this.stageCtx.set(WorkflowState.CODE, {
          ...existingCodeCtx,
          summary: `Code review failed (retry ${codeRollbackCount + 1}): ${failedNotes.slice(0, 200)}. Rollback to ARCHITECT triggered.`,
          keyDecisions: [`Rollback to ARCHITECT triggered after ${reviewResult.failed} high-severity issue(s)`],
          artifacts: [outputPath],
          risks: reviewResult.riskNotes ?? [],
          meta: { ...(existingCodeCtx.meta || {}), _codeRollbackCount: codeRollbackCount + 1, rollbackTriggered: true },
        });
      }
      const archStageLabel = 'CODE→ARCHITECT(rollback-retry)';
      this.obs.stageStart(archStageLabel);
      let archRetry;
      try {
        archRetry = await _getRunArchitect().call(this);
        this.obs.stageEnd(archStageLabel, 'ok');
      } catch (archErr) {
        this.obs.stageEnd(archStageLabel, 'error');
        this.obs.recordError(archStageLabel, archErr.message);
        await this.hooks.emit(HOOK_EVENTS.WORKFLOW_ERROR, { error: archErr, state: 'CODE→ARCHITECT(rollback)' }).catch(() => {});
        throw archErr;
      }
      return archRetry;
    } catch (rollbackErr) {
      console.warn(`[Orchestrator] Code rollback failed (non-fatal): ${rollbackErr.message}. Proceeding with risks recorded.`);
      this.stateMachine.recordRisk('high', `[CodeReview] ${reviewResult.failed} high-severity issue(s) unresolved. Rollback failed: ${rollbackErr.message}`);
    }
  } else if (codeDecision.needsHumanReview) {
    console.warn(`[Orchestrator] ⚠️  Code rollback limit reached (max 1). Proceeding to TEST with ${reviewResult.failed} unresolved issue(s).`);
    this.stateMachine.recordRisk('high', `[CodeReview] ${reviewResult.failed} high-severity issue(s) unresolved after rollback limit reached.`);
  } else {
    console.log(`[Orchestrator] ℹ️  ${reviewResult.failed} minor code issue(s) remain. Proceeding automatically.`);
  }

  // ── Early Entropy GC ─────────────────────────────────────────────────────
  try {
    console.log(`\n[Orchestrator] 🔍 Early entropy scan (post-CODE stage)...`);
    const earlyGcResult = await this.entropyGC.run();
    if (earlyGcResult.violations > 0) {
      const highCount = earlyGcResult.details?.high ?? 0;
      const gcMsg = `[EntropyGC/early] ${earlyGcResult.violations} violation(s) detected after CODE stage (${highCount} high). See output/entropy-report.md.`;
      console.warn(`[Orchestrator] ⚠️  ${gcMsg}`);
      if (highCount > 0) {
        this.stateMachine.recordRisk('high', gcMsg);
      }
    } else {
      console.log(`[Orchestrator] ✅ Early entropy scan: no violations found.`);
    }
  } catch (err) {
    console.warn(`[Orchestrator] Early EntropyGC scan failed (non-fatal): ${err.message}`);
  }

  // ── EvoMap feedback loop ────────────────────────────────────────────────
  if (codeDecision.pass) {
    await runEvoMapFeedback(this, {
      injectedExpIds: devInjectedExpIds,
      errorContext: (reviewResult.riskNotes || []).join(' '),
      stageLabel: 'CODE',
    });
  }

  const codeOutputCtx = storeCodeContext(this, outputPath, reviewResult);

  this.bus.publish(AgentRole.DEVELOPER, AgentRole.TESTER, outputPath, {
    reviewRounds:   reviewResult.rounds ?? 0,
    failedItems:    reviewResult.failed ?? 0,
    riskNotes:      reviewResult.riskNotes ?? [],
    contextSummary: codeOutputCtx.summary,
  });

  translateMdFile(outputPath, this._rawLlmCall).catch(() => {});

  return outputPath;
}

module.exports = { _runDeveloper };
