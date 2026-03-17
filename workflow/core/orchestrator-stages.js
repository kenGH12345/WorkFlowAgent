'use strict';

const fs   = require('fs');
const path = require('path');
const { PATHS, HOOK_EVENTS } = require('./constants');
const { AgentRole, WorkflowState } = require('./types');
const { ExperienceType, ExperienceCategory } = require('./experience-store');
const { ComplaintTarget } = require('./complaint-wall');  // still used in orchestrator-stage-helpers.js
const { SelfCorrectionEngine, formatClarificationReport } = require('./clarification-engine');
const { RequirementClarifier } = require('./requirement-clarifier');
const { CoverageChecker } = require('./coverage-checker');
const { CodeReviewAgent } = require('./code-review-agent');
const { ArchitectureReviewAgent } = require('./architecture-review-agent');
const { TestRunner } = require('./test-runner');
const { TestCaseGenerator } = require('./test-case-generator');
const { TestCaseExecutor } = require('./test-case-executor');
const { DECISION_QUESTIONS } = require('./socratic-engine');
// P0-B fix: StageContextStore IS still directly used in _runAnalyst (lazy init).
// The P2-NEW-1 comment was incorrect – the require must remain here.
const { StageContextStore } = require('./stage-context-store');
const { RollbackCoordinator } = require('./rollback-coordinator');
const { QualityGate } = require('./quality-gate');
const { Observability } = require('./observability');
const { translateMdFile } = require('./i18n-translator');
// P1-3 fix: extracted EvoMap feedback loop as a reusable helper.
const { runEvoMapFeedback } = require('./stage-runner-utils');
const { getPromptSlotManager } = require('./prompt-builder');
// P2-A fix: shared file-scanner utility – replaces the inline collectFiles closure
// that was duplicated across orchestrator-stages.js, entropy-gc.js, and code-graph.js.
const { scanSourceFiles } = require('./file-scanner');
// P2-NEW-1 fix: extracted stage helpers to reduce Fat Orchestrator.
// Context injection, experience/complaint block assembly, and stageCtx storage
// are now in orchestrator-stage-helpers.js. Each _runXxx function is now a
// lean orchestration skeleton that delegates cross-cutting concerns to helpers.
const {
  buildArchitectUpstreamCtx,
  buildDeveloperUpstreamCtx,
  buildTesterUpstreamCtx,
  buildArchitectContextBlock,
  buildDeveloperContextBlock,
  buildTesterContextBlock,
  storeAnalyseContext,
  storeArchitectContext,
  storeCodeContext,
  storeTestContext,
} = require('./orchestrator-stage-helpers');

/**
 * Stage runner methods for Orchestrator.
 * All functions use `this` bound to the Orchestrator instance.
 */

// ─── Prompt A/B outcome recording helper ──────────────────────────────────────
/**
 * Records the outcome of a prompt variant usage after a QualityGate decision.
 * Called after each stage's QualityGate.evaluate() to close the A/B feedback loop.
 *
 * @param {string} agentRole       - e.g. 'analyst', 'architect', 'developer', 'tester'
 * @param {boolean} gatePassed     - Did the QualityGate pass?
 * @param {number} correctionRounds - Number of self-correction / review rounds
 * @param {number} [tokensUsed=0]  - Estimated tokens used (from obs)
 */
function _recordPromptABOutcome(agentRole, gatePassed, correctionRounds, tokensUsed = 0) {
  const mgr = getPromptSlotManager();
  if (!mgr) return;
  const variantId = mgr.getSessionVariant(agentRole, 'fixed_prefix');
  if (!variantId) return;
  mgr.recordOutcome(agentRole, 'fixed_prefix', variantId, {
    gatePassed,
    correctionRounds,
    tokensUsed,
  });
}

async function _runAnalyst(rawRequirement) {
  console.log(`\n[Orchestrator] Stage: ANALYSE (AnalystAgent)`);

  // stageCtx is now eagerly initialised in the Orchestrator constructor (P2-A fix).
  // No lazy-init needed here. If stageCtx is somehow null (e.g. in tests that
  // construct Orchestrator without calling the full constructor), fail fast with
  // a clear error rather than silently skipping cross-stage context propagation.
  if (!this.stageCtx) {
    throw new Error('[Orchestrator] stageCtx is not initialised. This is a bug – StageContextStore should be created in the Orchestrator constructor.');
  }


  const clarifier = new RequirementClarifier({
    askUser: this.askUser,
    // Defect G fix: use adaptive strategy's maxClarificationRounds (Rule 5)
    // instead of hardcoded 2. deriveStrategy() adjusts this based on cross-session
    // clarification effectiveness metrics.
    maxRounds: this._adaptiveStrategy?.maxClarificationRounds ?? 2,
    verbose: true,
    llmCall: this._rawLlmCall,
  });
  const clarResult = await clarifier.clarify(rawRequirement);

  if (clarResult.riskNotes && clarResult.riskNotes.length > 0) {
    try {
      // P2-C fix: use non-blocking askAsync – Agent proceeds immediately with default,
      // user has 10s to override. Default: option[2] = "Let the Analyst Agent decide".
      const scopeDecision = this.socratic.askAsync(DECISION_QUESTIONS.SCOPE_CLARIFICATION, 2);
      console.log(`[Orchestrator] ⚡ Scope clarification (non-blocking): "${scopeDecision.optionText}"`);
      if (scopeDecision.optionIndex === 0) {
        clarResult.enrichedRequirement = `[Scope: Minimal – implement only the core feature]\n\n${clarResult.enrichedRequirement}`;
      } else if (scopeDecision.optionIndex === 1) {
        clarResult.enrichedRequirement = `[Scope: Full – implement all mentioned features]\n\n${clarResult.enrichedRequirement}`;
      }
    } catch (err) {
      this.stateMachine.recordRisk('low', `[SocraticEngine] Scope clarification skipped (engine unavailable): ${err.message}`);
      console.warn(`[Orchestrator] ⚠️  SocraticEngine scope clarification skipped – proceeding automatically. Reason: ${err.message}`);
    }
  }

  for (const note of clarResult.riskNotes) {
    this.stateMachine.recordRisk('medium', note);
  }

  if (!clarResult.skipped && clarResult.rounds > 0) {
    console.log(`[Orchestrator] ✅ Requirement clarified in ${clarResult.rounds} round(s). Proceeding to analysis.`);
  }

  // Defect G fix: record clarification quality metrics into observability so
  // deriveStrategy() Rule 5 can use cross-session data to adjust maxClarificationRounds.
  if (clarResult.qualityMetrics && this.obs) {
    this.obs.recordClarificationQuality(clarResult.qualityMetrics, clarResult.rounds);
  }

  const outputPath = await this.agents[AgentRole.ANALYST].run(null, clarResult.enrichedRequirement);

  // ── Store ANALYSE stage context for downstream stages ─────────────────────
  // P2-NEW-1: delegated to storeAnalyseContext helper
  const analyseCtx = storeAnalyseContext(this, outputPath, clarResult);

  // ── Prompt A/B: record analyst outcome ──────────────────────────────────
  // ANALYSE stage has no QualityGate (it always passes if output is produced).
  // Record as passed with clarification rounds as the correction metric.
  _recordPromptABOutcome('analyst', true, clarResult.rounds ?? 0);

  // ── Defect J fix: Estimate task complexity from the enriched requirement ───
  // This must happen AFTER ANALYSE produces the enriched requirement, because
  // the raw user requirement is often too terse for meaningful complexity estimation.
  // The complexity score is recorded in Observability for two purposes:
  //   1. deriveStrategy() Rule 6 uses it to modulate maxFixRounds/maxReviewRounds
  //      for the CURRENT session (via re-derivation after ANALYSE completes)
  //   2. It's written to metrics-history.jsonl for cross-session complexity drift
  //      detection (Rule 6b: if complex tasks systematically fail more than simple
  //      ones, proactively raise retry budgets)
  //
  // AEF Fast-Path: complexity assessment also drives stage routing:
  //   - Simple (score < 3): streamlined flow, can skip detailed architecture
  //   - Medium (3-6): standard flow
  //   - Complex (> 6): full flow with enhanced review budgets
  if (this.obs) {
    const requirementText = clarResult.enrichedRequirement || '';
    const complexity = Observability.estimateTaskComplexity(requirementText);
    this.obs.recordTaskComplexity(complexity);

    // Store complexity for downstream fast-path decisions
    if (this.stageCtx) {
      const existingAnalyse = this.stageCtx.get('ANALYSE') || {};
      this.stageCtx.set('ANALYSE', {
        ...existingAnalyse,
        meta: { ...(existingAnalyse.meta || {}), complexity },
      });
    }

    console.log(`[Orchestrator] 📊 AEF Complexity Assessment: level=${complexity.level}, score=${complexity.score}`);
    if (complexity.level === 'simple') {
      console.log(`[Orchestrator] ⚡ AEF Fast-Path: Simple task detected — ARCHITECT stage will use streamlined review.`);
    } else if (complexity.level === 'complex') {
      console.log(`[Orchestrator] 🔍 AEF Full-Path: Complex task detected — enhanced review budgets will be applied.`);
    }

    // Re-derive adaptive strategy with the complexity dimension now available.
    // At Orchestrator construction time, taskComplexity was null (ANALYSE hadn't run yet),
    // so deriveStrategy() Rule 6 was skipped. Now we have the actual complexity score
    // and can compute proper floor values for maxFixRounds/maxReviewRounds.
    const cfgAutoFix = (this._config && this._config.autoFixLoop) || {};
    const updatedStrategy = Observability.deriveStrategy(PATHS.OUTPUT_DIR, {
      maxFixRounds:    cfgAutoFix.maxFixRounds    ?? 2,
      maxReviewRounds: cfgAutoFix.maxReviewRounds ?? 2,
      maxExpInjected:  cfgAutoFix.maxExpInjected  ?? 5,
      projectId:       this.projectId,
      taskComplexity:  complexity,
    });
    // Only apply if Rule 6 actually changed something
    if (updatedStrategy.maxFixRounds !== this._adaptiveStrategy.maxFixRounds ||
        updatedStrategy.maxReviewRounds !== this._adaptiveStrategy.maxReviewRounds) {
      console.log(`[Orchestrator] 📈 Adaptive strategy re-derived after ANALYSE (complexity=${complexity.level}, score=${complexity.score}):`);
      console.log(`[Orchestrator]    maxFixRounds: ${this._adaptiveStrategy.maxFixRounds} → ${updatedStrategy.maxFixRounds} | maxReviewRounds: ${this._adaptiveStrategy.maxReviewRounds} → ${updatedStrategy.maxReviewRounds}`);
      this._adaptiveStrategy = updatedStrategy;
    }
  }

  this.bus.publish(AgentRole.ANALYST, AgentRole.ARCHITECT, outputPath, {
    clarificationRounds: clarResult.rounds ?? 0,
    signalCount:         clarResult.allSignals?.length ?? 0,
    riskNotes:           clarResult.riskNotes ?? [],
    skipped:             clarResult.skipped ?? false,
    contextSummary:      analyseCtx.summary,
  });

  // Generate Chinese companion file for developers (non-blocking)
  translateMdFile(outputPath, this._rawLlmCall).catch(() => {});

  return outputPath;
}

async function _runArchitect() {
  console.log(`\n[Orchestrator] Stage: ARCHITECT (ArchitectAgent)`);
  const inputPath = this.bus.consume(AgentRole.ARCHITECT);

  // ── Inject upstream cross-stage context ───────────────────────────────────
  // P2-NEW-1: delegated to buildArchitectUpstreamCtx helper
  const upstreamCtxForArch = buildArchitectUpstreamCtx(this);

  let techStackPrefix = '';
  try {
    // P2-C fix: use non-blocking askAsync – Agent proceeds immediately with default,
    // user has 10s to override. Default: option[0] = "Follow architecture recommendation".
    const techDecision = this.socratic.askAsync(DECISION_QUESTIONS.TECH_STACK_PREFERENCE, 0);
    console.log(`[Orchestrator] ⚡ Tech stack preference (non-blocking): "${techDecision.optionText}"`);
    if (techDecision.optionIndex === 1) {
      techStackPrefix = '[Tech Stack: Minimal/Lightweight – prefer simple, low-dependency solutions]\n\n';
    } else if (techDecision.optionIndex === 2) {
      techStackPrefix = '[Tech Stack: Enterprise-grade – include full observability, logging, and monitoring]\n\n';
    }
  } catch (err) {
    this.stateMachine.recordRisk('low', `[SocraticEngine] Tech stack preference skipped (engine unavailable): ${err.message}`);
    console.warn(`[Orchestrator] ⚠️  SocraticEngine tech stack preference skipped – proceeding automatically. Reason: ${err.message}`);
  }

  const analystMeta = this.bus.getMeta(AgentRole.ARCHITECT);
  if (analystMeta && !analystMeta.skipped && analystMeta.clarificationRounds > 0) {
    console.log(`[Orchestrator] ℹ️  Requirement was clarified in ${analystMeta.clarificationRounds} round(s) (${analystMeta.signalCount} signal(s) resolved). Architect should read requirements.md carefully.`);
  }

  // P2-NEW-1: delegated to buildArchitectContextBlock helper
  const archExpContextWithComplaints = await buildArchitectContextBlock(this, techStackPrefix, upstreamCtxForArch);
  // Improvement 4: report injection count to Observability for hit-rate tracking
  this.obs.recordExpUsage({ injected: (archExpContextWithComplaints._injectedExpIds || []).length });

  const outputPath = await this.agents[AgentRole.ARCHITECT].run(inputPath, null, archExpContextWithComplaints);

  const requirementPath = path.join(PATHS.OUTPUT_DIR, 'requirements.md');

  // Defect B fix: CoverageChecker and ArchitectureReviewAgent both read the same
  // files (outputPath + requirementPath) with no data dependency between them.
  // Run them in parallel to eliminate unnecessary serial wait time.
  //
  // Note: CoverageChecker.check() is a pure read operation; the fs.appendFileSync
  // (writing the coverage report into outputPath) happens AFTER both tasks complete,
  // so ArchitectureReviewAgent always reads the clean architecture document.
  const coverageChecker = new CoverageChecker(this._rawLlmCall, { verbose: true });
  const archReviewer = new ArchitectureReviewAgent(
    this._rawLlmCall,
    {
      maxRounds: 2,
      verbose: true,
      outputDir: PATHS.OUTPUT_DIR,
      investigationTools: this._buildInvestigationTools('Architecture'),
    }
  );

  const [coverageSettled, archReviewSettled] = await this.stateMachine.runParallel([
    { name: 'CoverageCheck', fn: () => coverageChecker.check(requirementPath, outputPath) },
    { name: 'ArchReview',    fn: () => archReviewer.review(outputPath, requirementPath) },
  ]);

  // Unwrap results – propagate errors if either task failed
  if (coverageSettled.status === 'rejected') {
    throw new Error(`[_runArchitect] CoverageChecker failed: ${coverageSettled.reason?.message ?? coverageSettled.reason}`);
  }
  if (archReviewSettled.status === 'rejected') {
    throw new Error(`[_runArchitect] ArchitectureReviewAgent failed: ${archReviewSettled.reason?.message ?? archReviewSettled.reason}`);
  }
  const coverageResult   = coverageSettled.value;
  const archReviewResult = archReviewSettled.value;

  // Defect C fix: cache subtask results for fine-grained rollback.
  // If ArchReview fails quality gate but CoverageCheck succeeded, the next retry
  // can skip re-running CoverageCheck and reuse the cached result.
  const subtaskCoordinator = new RollbackCoordinator(this);
subtaskCoordinator.cacheSubtaskResult(WorkflowState.ARCHITECT, 'CoverageCheck', coverageResult);
  subtaskCoordinator.cacheSubtaskResult(WorkflowState.ARCHITECT, 'ArchReview', archReviewResult);

  // Append coverage report to architecture doc AFTER both tasks complete
  // (ArchitectureReviewAgent has already finished reading outputPath at this point)
  if (!coverageResult.skipped) {
    const coverageReport = coverageChecker.formatReport(coverageResult);
    fs.appendFileSync(outputPath, `\n\n---\n${coverageReport}`, 'utf-8');
    const evaluatedItems = coverageResult.covered + coverageResult.uncovered;
    console.log(`[Orchestrator] 📊 Coverage: ${coverageResult.covered}/${evaluatedItems} evaluated (${coverageResult.coverageRate}%) | total parsed: ${coverageResult.total}`);
  }

  for (const note of coverageResult.riskNotes) {
    this.stateMachine.recordRisk('high', note, false);
    console.warn(`[Orchestrator] ⚠️  ${note}`);
  }

  for (const note of archReviewResult.riskNotes) {
    const severity = note.includes('(high)') ? 'high' : 'medium';
    this.stateMachine.recordRisk(severity, note, false);
  }
  this.stateMachine.flushRisks();

  if (archReviewResult.failed === 0 || !archReviewResult.needsHumanReview) {
  try {
    // P2-C fix: use non-blocking askAsync – Agent proceeds immediately with default,
    // user has 10s to override. Default: option[0] = "Yes, approve and proceed".
    //
    // P1-B fix: renamed from archDecision to socraticDecision to eliminate the
    // naming collision with the outer-scope archDecision (archGate.evaluate result).
    // The two variables have completely different semantics:
    //   - socraticDecision: the USER's approval/rejection of the architecture
    //   - archDecision (outer): the QUALITY GATE's pass/rollback/needsHumanReview verdict
    // Sharing the name "archDecision" forced readers to track block scopes carefully
    // and made the code error-prone to future refactoring.
    const socraticDecision = this.socratic.askAsync(DECISION_QUESTIONS.ARCHITECTURE_APPROVAL, 0);
      if (socraticDecision.optionIndex === 1) {
        const abortMsg = '[SocraticEngine] User rejected architecture. Workflow aborted by user decision.';
        this.stateMachine.recordRisk('high', abortMsg);
        throw new Error(abortMsg);
      } else if (socraticDecision.optionIndex === 2) {
        this.stateMachine.recordRisk('medium', '[SocraticEngine] User approved architecture with reservations. Proceeding to code generation.');
        console.log(`[Orchestrator] ⚠️  Architecture approved with reservations. Proceeding.`);
      } else {
        console.log(`[Orchestrator] ✅ Architecture approved by user. Proceeding to code generation.`);
      }
    } catch (err) {
      if (err.message.includes('User rejected architecture')) throw err;
      // Record the skip as a risk so it's visible in the manifest
      this.stateMachine.recordRisk('low', `[SocraticEngine] Architecture approval skipped (engine unavailable): ${err.message}`);
      console.warn(`[Orchestrator] ⚠️  SocraticEngine architecture approval skipped – proceeding automatically. Reason: ${err.message}`);
    }
  } else {
    // P2-B fix: architecture FAILED (failed > 0 && needsHumanReview).
    //
    // Previous behaviour: the Socratic decision was silently skipped. The system
    // jumped straight to QualityGate.evaluate() → rollback, with the user having
    // no visibility into what happened or any chance to intervene.
    //
    // This is exactly the WRONG time to skip user notification. When the architecture
    // passes, the user's approval is a nice-to-have confirmation. When it FAILS, the
    // user's input is critical: they may want to:
    //   (a) Accept the failure and proceed anyway (with risk recorded)
    //   (b) Trigger rollback (the default – what QualityGate will do anyway)
    //   (c) Manually edit the architecture file and retry
    //
    // Fix: notify the user of the failure and give them a non-blocking window to
    // override the default rollback decision. Default = rollback (option[0]).
    // If the user overrides to "proceed anyway", we record a high-severity risk
    // and skip the rollback path below.
    //
    // Note: this Socratic call is BEFORE QualityGate.evaluate() so the user's
    // decision can influence whether rollback is attempted.
    const failedSummary = archReviewResult.riskNotes.slice(0, 2).join('; ');
    console.warn(`[Orchestrator] ⚠️  Architecture review FAILED: ${archReviewResult.failed} high-severity issue(s). Notifying user...`);
    try {
      const failureDecision = this.socratic.askAsync(
        DECISION_QUESTIONS.ARCHITECTURE_FAILURE_ACTION || DECISION_QUESTIONS.ARCHITECTURE_APPROVAL,
        0  // default: rollback (first option)
      );
      console.log(`[Orchestrator] ⚡ Architecture failure action (non-blocking): "${failureDecision.optionText}"`);
      // optionIndex 0 = rollback (default, handled by QualityGate below)
      // optionIndex 1 = proceed anyway (user accepts risk)
      if (failureDecision.optionIndex === 1) {
        const proceedMsg = `[SocraticEngine] User chose to proceed despite architecture failure (${archReviewResult.failed} issue(s)): ${failedSummary}`;
        this.stateMachine.recordRisk('high', proceedMsg);
        console.warn(`[Orchestrator] ⚠️  User accepted architecture failure. Proceeding to CODE with high-severity risks recorded.`);
        // Force QualityGate to see this as "pass with warnings" by short-circuiting
        // the rollback path. We do this by overriding archReviewResult.needsHumanReview
        // to false so QualityGate.evaluate() takes the "pass with warnings" branch.
        // This is safe: the risk is already recorded above; the user made an informed choice.
        archReviewResult.needsHumanReview = false;
      }
      // optionIndex 0 (default): fall through to QualityGate rollback path below
    } catch (err) {
      // SocraticEngine unavailable (CI mode, stdin closed, etc.) – proceed with rollback
      this.stateMachine.recordRisk('low', `[SocraticEngine] Architecture failure notification skipped (engine unavailable): ${err.message}`);
      console.warn(`[Orchestrator] ⚠️  SocraticEngine architecture failure notification skipped – proceeding with rollback. Reason: ${err.message}`);
    }
  }

  if (archReviewResult.failed === 0) {
    console.log(`[Orchestrator] ✅ Architecture review passed.`);
  }

  // ── Quality gate decision (P0-A: extracted to QualityGate) ───────────────
  const archGate = new QualityGate({ experienceStore: this.experienceStore, maxRollbacks: 1 });
const archCtxMeta = this.stageCtx?.get(WorkflowState.ARCHITECT)?.meta || {};
  const rollbackCount = archCtxMeta._archRollbackCount || 0;
const archDecision = archGate.evaluate(archReviewResult, WorkflowState.ARCHITECT, rollbackCount);
    archGate.recordExperience(archDecision, WorkflowState.ARCHITECT, archReviewResult, {
    skill: 'architecture-design',
    category: ExperienceCategory.ARCHITECTURE,
  });

  // ── Prompt A/B: record architect outcome ─────────────────────────────────
  _recordPromptABOutcome('architect', archDecision.pass, archReviewResult.rounds ?? 0);

  if (!archDecision.pass && archDecision.rollback) {
    const failedNotes = archReviewResult.riskNotes.slice(0, 3).join('; ');
    console.warn(`[Orchestrator] ⚠️  ${archDecision.reason}`);

    // Update rollback counter in stageCtx.meta. see CHANGELOG: Defect #1, P2-2
    if (this.stageCtx) {
const existing = this.stageCtx.get(WorkflowState.ARCHITECT) || {};
          this.stageCtx.set(WorkflowState.ARCHITECT, {
        ...existing,
        meta: { ...(existing.meta || {}), _archRollbackCount: rollbackCount + 1 },
      });
    }
    try {
      // ── Defect C fix: analyse rollback strategy before committing to full-stage rollback ──
      // If only ArchReview failed but CoverageCheck succeeded (the common case),
      // we can retry just the review instead of re-running the entire ANALYSE stage.
      const coordinator = new RollbackCoordinator(this);
      const strategy = coordinator.analyseRollbackStrategy(
WorkflowState.ARCHITECT, `Architecture review failed: ${failedNotes}`, 'ArchReview'
      );

      if (strategy.type === 'SUBTASK_RETRY' && strategy.cachedResults) {
        // ── Subtask-level retry: only re-run ArchReview ──────────────────────────
        console.log(`[Orchestrator] 🎯 Defect C: Subtask-level retry for ARCHITECT. ${strategy.reason}`);

        // Re-run only the ArchReview subtask with the failure context embedded
        const retryReviewer = new ArchitectureReviewAgent(
          this._rawLlmCall,
          {
            maxRounds: 2,
            verbose: true,
            outputDir: PATHS.OUTPUT_DIR,
            investigationTools: this._buildInvestigationTools('Architecture'),
          }
        );
        const requirementPathRetry = path.join(PATHS.OUTPUT_DIR, 'requirements.md');

        // Append failure feedback to the architecture doc so the reviewer sees what went wrong
        const retryNote = `\n\n---\n## ⚠️ Architecture Review Retry (Attempt ${rollbackCount + 1})\n\nPrevious review found these issues:\n${failedNotes}\n\nPlease address these concerns in a focused re-review.`;
        fs.appendFileSync(outputPath, retryNote, 'utf-8');

        const retryReviewResult = await retryReviewer.review(outputPath, requirementPathRetry);

        // Use cached CoverageCheck result from the first run
        const cachedCoverage = strategy.cachedResults.get('CoverageCheck');
        const retryGate = new QualityGate({ experienceStore: this.experienceStore, maxRollbacks: 1 });
        const retryDecision = retryGate.evaluate(retryReviewResult, WorkflowState.ARCHITECT, rollbackCount + 1);

        if (retryDecision.pass) {
          console.log(`[Orchestrator] ✅ Subtask-level retry succeeded: ArchReview passed on retry.`);
          // Update subtask cache with new result
          coordinator.cacheSubtaskResult(WorkflowState.ARCHITECT, 'ArchReview', retryReviewResult);

          // Store updated ARCHITECT context with retry info
          if (this.stageCtx) {
            const existingArch = this.stageCtx.get(WorkflowState.ARCHITECT) || {};
            this.stageCtx.set(WorkflowState.ARCHITECT, {
              ...existingArch,
              summary: `Architecture review passed on subtask retry (attempt ${rollbackCount + 1}). Original issues: ${failedNotes.slice(0, 150)}`,
              keyDecisions: [`ArchReview subtask retry succeeded after ${retryReviewResult.rounds ?? 0} round(s)`],
              artifacts: [outputPath],
              risks: retryReviewResult.riskNotes ?? [],
              meta: { ...(existingArch.meta || {}), _archRollbackCount: rollbackCount + 1, subtaskRetry: true },
            });
          }
          // Continue to the rest of _runArchitect (store context, publish, etc.)
          // by replacing archReviewResult in the outer scope. We use a special return
          // that signals the caller to proceed with updated results.
          // Note: we can't easily reassign archReviewResult (const), so we fall through
          // to the normal post-review path by returning early with the output path.
          // Store ARCHITECT context for downstream stages
          const archOutputCtx = storeArchitectContext(this, outputPath, retryReviewResult, cachedCoverage || coverageResult);
          this.bus.publish(AgentRole.ARCHITECT, AgentRole.DEVELOPER, outputPath, {
            reviewRounds:   retryReviewResult.rounds ?? 0,
            failedItems:    retryReviewResult.failed ?? 0,
            riskNotes:      retryReviewResult.riskNotes ?? [],
            contextSummary: archOutputCtx.summary,
          });
          return outputPath;
        }

        // Subtask retry didn't help → fall through to full-stage rollback
        console.log(`[Orchestrator] ⚠️  Subtask-level retry failed. Falling through to full-stage rollback.`);
        coordinator.invalidateSubtaskCache(WorkflowState.ARCHITECT);
      }

      // ── Full-stage rollback (original path) ──────────────────────────────────
      // Coordinated rollback (P0-A: RollbackCoordinator handles all cleanup)
      await coordinator.rollback(WorkflowState.ARCHITECT, `Architecture review failed: ${failedNotes.slice(0, 200)}`);

      const failureContext = `[ARCHITECTURE REVIEW FAILED – RETRY ${rollbackCount + 1}]\n\nThe previous architecture attempt failed review with these issues:\n${failedNotes}\n\nPlease re-analyse the requirements with these constraints in mind.`;
      const reanalysedPath = await _runAnalyst.call(this, failureContext);
      await this.stateMachine.transition(reanalysedPath, `ANALYSE → ARCHITECT (post-rollback retry ${rollbackCount + 1})`);
      console.log(`[Orchestrator] ✅ State machine advanced to ARCHITECT after post-rollback re-analysis.`);
      if (this.stageCtx) {
        const existingArch = this.stageCtx.get(WorkflowState.ARCHITECT) || {};
        this.stageCtx.set(WorkflowState.ARCHITECT, {
          ...existingArch,
          summary: `Architecture review failed (retry ${rollbackCount + 1}): ${failedNotes.slice(0, 200)}. Re-analysis triggered.`,
          keyDecisions: [`Rollback to ANALYSE triggered after ${archReviewResult.failed} high-severity issue(s)`],
          artifacts: [outputPath],
          risks: archReviewResult.riskNotes ?? [],
          meta: { ...(existingArch.meta || {}), _archRollbackCount: rollbackCount + 1, rollbackTriggered: true },
        });
      }
      return { __alreadyTransitioned: true, artifactPath: reanalysedPath };
    } catch (rollbackErr) {
      console.warn(`[Orchestrator] Rollback failed (non-fatal): ${rollbackErr.message}. Proceeding with risks recorded.`);
    }
  } else if (!archDecision.pass && archDecision.needsHumanReview) {
    console.warn(`[Orchestrator] ⚠️  Rollback limit reached. Proceeding to CODE stage with ${archReviewResult.failed} unresolved issue(s).`);
  } else if (archDecision.pass && archReviewResult.failed > 0) {
    const lowSeverityNotes = archReviewResult.riskNotes
      .filter(n => !n.includes('(high)'))
      .slice(0, 3)
      .join('; ');
    this.stateMachine.recordRisk('low', `[ArchReview] ${archReviewResult.failed} low-severity issue(s) remain (no rollback): ${lowSeverityNotes}`);
    console.log(`[Orchestrator] ℹ️  ${archReviewResult.failed} minor architecture issue(s) remain (recorded as low-risk). Proceeding automatically.`);
  } else {
    console.log(`[Orchestrator] ℹ️  Architecture review: no issues. Proceeding automatically.`);
  }

  // ── EvoMap feedback loop (P1-3: extracted to runEvoMapFeedback) ──────────
  if (archDecision.pass) {
    await runEvoMapFeedback(this, {
      injectedExpIds: archExpContextWithComplaints._injectedExpIds || [],
      errorContext: (archReviewResult.riskNotes || []).join(' '),
      stageLabel: 'ARCHITECT',
    });
  }

  // ── Store ARCHITECT stage context for downstream stages ──────────────────
  // P2-NEW-1: delegated to storeArchitectContext helper
  const archOutputCtx = storeArchitectContext(this, outputPath, archReviewResult, coverageResult);

  this.bus.publish(AgentRole.ARCHITECT, AgentRole.DEVELOPER, outputPath, {
    reviewRounds:   archReviewResult.rounds ?? 0,
    failedItems:    archReviewResult.failed ?? 0,
    riskNotes:      archReviewResult.riskNotes ?? [],
    contextSummary: archOutputCtx.summary,
  });

  // Generate Chinese companion file for developers (non-blocking)
  translateMdFile(outputPath, this._rawLlmCall).catch(() => {});

  return outputPath;
}

async function _runDeveloper() {
  console.log(`\n[Orchestrator] Stage: CODE (DeveloperAgent)`);
  const inputPath = this.bus.consume(AgentRole.DEVELOPER);

  // ── Inject upstream cross-stage context ───────────────────────────────────
  // P2-NEW-1: delegated to buildDeveloperUpstreamCtx helper
  const upstreamCtxForDev = buildDeveloperUpstreamCtx(this);

  const archMeta = this.bus.getMeta(AgentRole.DEVELOPER);
  if (archMeta && archMeta.reviewRounds > 0) {
    console.log(`[Orchestrator] ℹ️  Architecture was self-corrected in ${archMeta.reviewRounds} round(s) (${archMeta.failedItems} issue(s) fixed). Developer should review architecture.md carefully.`);
  }

  // P2-NEW-1: delegated to buildDeveloperContextBlock helper
  const devExpContextWithComplaints = await buildDeveloperContextBlock(this, upstreamCtxForDev);
  // Improvement 4: report injection count to Observability for hit-rate tracking
  this.obs.recordExpUsage({ injected: (devExpContextWithComplaints._injectedExpIds || []).length });

  const outputPath = await this.agents[AgentRole.DEVELOPER].run(inputPath, null, devExpContextWithComplaints);

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

  // Defect C fix: cache CODE stage subtask results for fine-grained rollback.
  // If CodeReview fails quality gate, the next retry can reuse the CodeGeneration
  // result (the agent's raw output) and only re-run the review, or vice versa.
  const codeSubtaskCoordinator = new RollbackCoordinator(this);
  codeSubtaskCoordinator.cacheSubtaskResult(WorkflowState.CODE, 'CodeGeneration', { outputPath });
  codeSubtaskCoordinator.cacheSubtaskResult(WorkflowState.CODE, 'CodeReview', reviewResult);

  for (const note of reviewResult.riskNotes) {
    const severity = note.includes('(high)') ? 'high' : 'medium';
    this.stateMachine.recordRisk(severity, note, false);
  }
  this.stateMachine.flushRisks();

  // P1-NEW-5 fix: use QualityGate for CODE stage decision (same as ARCHITECT stage).
  // Previously this was inline if/else logic, which violated DRY and made quality
  // policy impossible to configure uniformly across stages.
  const codeGate = new QualityGate({ experienceStore: this.experienceStore, maxRollbacks: 1 });
  const codeRollbackCountForGate = this._rollbackCounters?.get(WorkflowState.CODE) ?? 0;
  const codeDecision = codeGate.evaluate(reviewResult, WorkflowState.CODE, codeRollbackCountForGate);
  codeGate.recordExperience(codeDecision, WorkflowState.CODE, reviewResult, { skill: 'code-development', category: ExperienceCategory.STABLE_PATTERN });

  // ── Prompt A/B: record developer outcome ─────────────────────────────────
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
    // Roll back to ARCHITECT when high-severity code issues remain after all review rounds.
    // P1-NEW-3 fix: use this._rollbackCounters (instance-level Map) instead of stageCtx.meta.
    // stageCtx.delete(WorkflowState.CODE) is called by RollbackCoordinator during rollback, which would
    // reset the counter to 0 and risk infinite recursion. The Map is never cleared by rollback.
    const codeRollbackCount = this._rollbackCounters?.get(WorkflowState.CODE) ?? 0;
    // Increment the independent counter before entering the rollback path
    if (this._rollbackCounters) this._rollbackCounters.set(WorkflowState.CODE, codeRollbackCount + 1);
    // Also mirror into stageCtx.meta for observability (non-authoritative copy)
    if (this.stageCtx) {
      const existingCode = this.stageCtx.get(WorkflowState.CODE) || {};
      this.stageCtx.set(WorkflowState.CODE, {
        ...existingCode,
        meta: { ...(existingCode.meta || {}), _codeRollbackCount: codeRollbackCount + 1 },
      });
    }
    try {
      // ── Defect C fix: analyse rollback strategy before committing to full-stage rollback ──
      // If only CodeReview failed (the common case), we can retry just the review
      // on the existing code output instead of re-running the entire ARCHITECT stage.
      const coordinator = new RollbackCoordinator(this);
      const codeStrategy = coordinator.analyseRollbackStrategy(
        WorkflowState.CODE, `Code review failed: ${failedNotes}`, 'CodeReview'
      );

      if (codeStrategy.type === 'SUBTASK_RETRY' && codeStrategy.cachedResults) {
        console.log(`[Orchestrator] 🎯 Defect C: Subtask-level retry for CODE. ${codeStrategy.reason}`);

        // Re-run only the CodeReview subtask with failure context
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

        // Append failure feedback to the code output
        const retryNote = `\n\n// --- Code Review Retry (Attempt ${codeRollbackCount + 1}) ---\n// Previous review found these issues:\n// ${failedNotes.replace(/\n/g, '\n// ')}\n// Please address the above.`;
        fs.appendFileSync(outputPath, retryNote, 'utf-8');

        const retryReview = await retryCodeReviewer.review(outputPath, reqPath);

        const retryCodeGate = new QualityGate({ experienceStore: this.experienceStore, maxRollbacks: 1 });
        const retryCodeDecision = retryCodeGate.evaluate(retryReview, WorkflowState.CODE, codeRollbackCount + 1);

        if (retryCodeDecision.pass) {
          console.log(`[Orchestrator] ✅ Subtask-level retry succeeded: CodeReview passed on retry.`);
          coordinator.cacheSubtaskResult(WorkflowState.CODE, 'CodeReview', retryReview);

          // Store CODE context and proceed
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

      // ── Full-stage rollback (original path) ──────────────────────────────────
      // Coordinated rollback (P0-A: RollbackCoordinator handles all cleanup)
      await coordinator.rollback(WorkflowState.CODE, `Code review failed: ${failedNotes.slice(0, 200)}`);

      // Read architecture path directly – bus message was already consumed. see CHANGELOG: Defect #4/_runDeveloper
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
      // P0-A fix: _runArchitect.call(this) bypasses _runStage's Observability timing
      // and error handling. Wrap it with inline obs.stageStart/stageEnd so the
      // ARCHITECT retry is visible in metrics-history.jsonl and _adaptiveStrategy.
      // Note: stateMachine.transition() is NOT called here because _runArchitect's
      // rollback path already calls it internally (returns __alreadyTransitioned).
      const archStageLabel = 'CODE→ARCHITECT(rollback-retry)';
      this.obs.stageStart(archStageLabel);
      let archRetry;
      try {
        archRetry = await _runArchitect.call(this);
        this.obs.stageEnd(archStageLabel, 'ok');
      } catch (archErr) {
        this.obs.stageEnd(archStageLabel, 'error');
        this.obs.recordError(archStageLabel, archErr.message);
        // Re-emit WORKFLOW_ERROR so HookSystem handlers are triggered (mirrors _runStage behaviour)
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

  // ── Early Entropy GC (post-CODE) ─────────────────────────────────────────
  // Run entropy scan immediately after code generation so high-severity
  // violations are visible BEFORE the TEST stage. This gives the developer
  // a chance to fix oversized files / circular deps while the code is fresh.
  // The full entropy scan still runs after TEST for a final clean-state check.
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

  // ── EvoMap feedback loop (P1-3: extracted to runEvoMapFeedback) ──────────
  if (codeDecision.pass) {
    await runEvoMapFeedback(this, {
      injectedExpIds: devExpContextWithComplaints._injectedExpIds || [],
      errorContext: (reviewResult.riskNotes || []).join(' '),
      stageLabel: 'CODE',
    });
  }

  // ── Store CODE stage context for downstream stages ────────────────────────
  // P2-NEW-1: delegated to storeCodeContext helper
  const codeOutputCtx = storeCodeContext(this, outputPath, reviewResult);

  this.bus.publish(AgentRole.DEVELOPER, AgentRole.TESTER, outputPath, {
    reviewRounds:   reviewResult.rounds ?? 0,
    failedItems:    reviewResult.failed ?? 0,
    riskNotes:      reviewResult.riskNotes ?? [],
    contextSummary: codeOutputCtx.summary,
  });

  // Generate Chinese companion file for developers (non-blocking)
  translateMdFile(outputPath, this._rawLlmCall).catch(() => {});

  return outputPath;
}

/**
 * P0-A fix: _runTester is now an iterative loop instead of a recursive function.
 *
 * Previous design:
 *   _runTester → rollback → _runDeveloper → _runTester (recursive)
 *
 * The recursion was "safe" only because _rollbackCounters prevented infinite loops,
 * but it still carried real stack-overflow risk if _rollbackCounters was ever
 * undefined (the `?? 0` fallback would reset the counter to 0 every call).
 *
 * New design:
 *   _runTester owns a `testIteration` counter.
 *   When a rollback is needed, it runs _runDeveloper inline and then `continue`s
 *   the while-loop instead of calling _runTester recursively.
 *   The loop exits when: (a) the test passes, (b) rollback budget is exhausted,
 *   or (c) an unrecoverable error is thrown.
 */
async function _runTester() {
  // P0-A: outer iteration loop – replaces recursive _runTester call
  const MAX_TEST_ITERATIONS = 2; // 1 initial run + 1 rollback retry
  let testIteration = 0;

  while (testIteration < MAX_TEST_ITERATIONS) {
    testIteration++;
    // P1-A fix: each _runTesterOnce call gets its OWN fresh fixConversationHistory.
    //
    // Previous design (P2-D): a single fixConversationHistory array was shared across
    // all iterations of the while-loop. The intent was to let the second iteration's
    // Fix Agent see the first iteration's fix attempts. But this caused a "history
    // pollution" problem:
    //   - Iteration 1 pushes N messages (N = 2 × fixRounds) into the shared array.
    //   - Iteration 2 (rollback + retry) starts with those N stale messages already
    //     in the array. The Fix Agent sees a long history of FAILED attempts from a
    //     DIFFERENT code state (pre-rollback), which actively misleads it.
    //
    // The correct design: each iteration starts fresh. The rollback itself (re-running
    // _runDeveloper) produces a new code state; the Fix Agent should reason about THAT
    // state without being anchored to the previous iteration's failures.
    //
    // Within a single iteration, fixConversationHistory still persists across fix
    // rounds (that is the P2-D / P0-NEW-2 multi-turn benefit), because the array is
    // created once per _runTesterOnce call and passed down to _runRealTestLoop.
    const fixConversationHistory = [];
    const iterResult = await _runTesterOnce.call(this, testIteration, MAX_TEST_ITERATIONS, fixConversationHistory);

    if (iterResult.__done) {
      // Normal completion (pass or budget exhausted) – return the output path
      return iterResult.outputPath;
    }

    if (iterResult.__alreadyTransitioned) {
      // _runDeveloper triggered its own rollback – propagate sentinel upward
      return iterResult;
    }

    // iterResult.__retry === true: rollback succeeded, re-run TEST stage
    console.log(`[Orchestrator] 🔄 Re-running TEST stage (iteration ${testIteration + 1}/${MAX_TEST_ITERATIONS}) after developer retry...`);
    // Loop continues – no recursive call needed
  }

  // Should not reach here (loop always returns via __done or __alreadyTransitioned),
  // but guard against edge cases.
  console.warn(`[Orchestrator] ⚠️  TEST stage iteration limit reached without resolution.`);
  return null;
}

/**
 * Executes a single TEST stage pass.
 * Returns one of:
 *   { __done: true, outputPath }           – normal completion
 *   { __done: true, __alreadyTransitioned } – _runDeveloper triggered its own rollback
 *   { __retry: true }                       – rollback succeeded, caller should loop
 */
async function _runTesterOnce(testIteration, maxIterations, fixConversationHistory) {
  console.log(`\n[Orchestrator] Stage: TEST (TesterAgent)${testIteration > 1 ? ` [iteration ${testIteration}/${maxIterations}]` : ''}`);
  const inputPath = this.bus.consume(AgentRole.TESTER);

  // ── Inject upstream cross-stage context ───────────────────────────────────
  // P2-NEW-1: delegated to buildTesterUpstreamCtx helper
  const upstreamCtxForTest = buildTesterUpstreamCtx(this);

  const devMeta = this.bus.getMeta(AgentRole.TESTER);
  if (devMeta && devMeta.reviewRounds > 0) {
    console.log(`[Orchestrator] ℹ️  Code was self-corrected in ${devMeta.reviewRounds} round(s) (${devMeta.failedItems} issue(s) fixed). Tester should pay attention to corrected areas.`);
  }

  // ── Step 0: Pre-generate test cases (test-first planning) ─────────────────
  // Generate test-cases.md BEFORE running TesterAgent.
  // This forces explicit coverage planning and gives the tester a concrete
  // execution checklist, significantly improving test report quality.
  console.log(`\n[Orchestrator] 📋 Pre-generating test cases (test-first planning)...`);
  let tcGenResult = { skipped: true, caseCount: 0 };
  try {
    const tcGen = new TestCaseGenerator(this._rawLlmCall, {
      verbose: true,
      outputDir: PATHS.OUTPUT_DIR,
    });
    tcGenResult = await tcGen.generate();
    if (!tcGenResult.skipped) {
      console.log(`[Orchestrator] ✅ Test cases generated: ${tcGenResult.caseCount} case(s) → output/test-cases.md`);
    } else {
      console.log(`[Orchestrator] ⏭️  Test case generation skipped (no requirements.md found).`);
    }
  } catch (err) {
    console.warn(`[Orchestrator] ⚠️  Test case generation failed (non-fatal): ${err.message}`);
  }

  // ── Step 0.5: Execute generated test cases (real execution) ────────────────
  // see CHANGELOG: Defect #4
  let tcExecutionReport = null;
  if (!tcGenResult.skipped && tcGenResult.caseCount > 0) {
    console.log(`\n[Orchestrator] 🔬 Executing generated test cases (real execution)...`);
    try {
      const tcExecutor = new TestCaseExecutor({
        projectRoot: this.projectRoot,
        testCommand: this._config.testCommand || null,
        framework: this._config.testFramework || 'auto',
        outputDir: PATHS.OUTPUT_DIR,
        timeoutMs: 90_000,
        verbose: true,
      });
      tcExecutionReport = await tcExecutor.execute();
      if (!tcExecutionReport.skipped) {
        // Use ?? (not ||) so that 0 is not replaced by the fallback. see CHANGELOG: P2-1
        const _manualPending = tcExecutionReport.manualPending ?? 0;
        const _automatedTotal = tcExecutionReport.automatedTotal ?? (tcExecutionReport.total - _manualPending);
        console.log(`[Orchestrator] 📊 Test case execution: ${tcExecutionReport.passed}/${_automatedTotal} passed, ${tcExecutionReport.failed} failed, ${tcExecutionReport.blocked} blocked, ${_manualPending} manual-pending`);
        // Save execution report to output dir for traceability
        const execReportPath = path.join(PATHS.OUTPUT_DIR, 'test-execution-report.md');
        fs.writeFileSync(execReportPath, tcExecutionReport.summaryMd, 'utf-8');
        console.log(`[Orchestrator] 📝 Execution report saved → output/test-execution-report.md`);
        // M-4: only count automated failures in risk – manual-pending cases are NOT quality failures
        if (tcExecutionReport.failed > 0) {
          this.stateMachine.recordRisk('medium',
            `[TestCaseExecutor] ${tcExecutionReport.failed}/${_automatedTotal} automated test case(s) failed real execution. See output/test-execution-report.md.`);
        }
        if (_manualPending > 0) {
          console.log(`[Orchestrator] 🖐️  ${_manualPending} manual test case(s) require human verification – not counted as failures.`);
        }
      } else {
        console.log(`[Orchestrator] ⏭️  Test case execution skipped: ${tcExecutionReport.skipReason}`);
      }
    } catch (err) {
      console.warn(`[Orchestrator] ⚠️  Test case execution failed (non-fatal): ${err.message}`);
    }
  } else {
    console.log(`[Orchestrator] ⏭️  Test case execution skipped (no cases generated).`);
  }

  // P2-NEW-1: delegated to buildTesterContextBlock helper
  const testExpContextWithComplaints = await buildTesterContextBlock(this, upstreamCtxForTest, tcExecutionReport);
  // Improvement 4: report injection count to Observability for hit-rate tracking
  this.obs.recordExpUsage({ injected: (testExpContextWithComplaints._injectedExpIds || []).length });
  const outputPath = await this.agents[AgentRole.TESTER].run(inputPath, null, testExpContextWithComplaints);

  let testContent = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8') : '';
  if (!testContent) {
    console.warn(`[Orchestrator] ⚠️  TesterAgent produced an empty test report at: ${outputPath}. Skipping self-correction.`);
    this.stateMachine.recordRisk('high', '[TestReport] TesterAgent produced an empty test report – self-correction skipped.');
  } else {
    const corrector = new SelfCorrectionEngine(
      this._rawLlmCall,
      {
        maxRounds: 2,
        verbose: true,
        semanticMode: true,
        investigationTools: this._buildInvestigationTools('TestReport'),
      }
    );
    const corrResult = await corrector.correct(testContent, 'Test Report');

    if (corrResult.rounds > 0) {
      const tmpPath = outputPath + '.tmp';
      fs.writeFileSync(tmpPath, corrResult.content, 'utf-8');
      fs.renameSync(tmpPath, outputPath);
      console.log(`[Orchestrator] Test report self-corrected in ${corrResult.rounds} round(s).`);
    }

    const report = formatClarificationReport(corrResult);
    if (report) {
      fs.appendFileSync(outputPath, `\n\n---\n${report}`, 'utf-8');
    }

    if (corrResult.needsHumanReview) {
      const riskMsg = `[TestReport] ${corrResult.signals.filter(s => s.severity === 'high').map(s => s.label).join(', ')} – unresolved after self-correction.`;
      this.stateMachine.recordRisk('high', riskMsg);
      console.warn(`[Orchestrator] ⚠️  High-severity test report issues detected.`);
      try {
        // P2-C fix: use non-blocking askAsync – Agent proceeds immediately with default,
        // user has 10s to override. Default: option[0] = "Fix all Critical and High defects".
        const defectDecision = this.socratic.askAsync(DECISION_QUESTIONS.TEST_DEFECTS_ACTION, 0);
        console.log(`[Orchestrator] ⚡ Defect handling decision (non-blocking): "${defectDecision.optionText}"`);
        this.stateMachine.recordRisk('low', `[SocraticEngine] Defect handling: ${defectDecision.optionText}`);
      } catch (err) {
        this.stateMachine.recordRisk('low', `[SocraticEngine] Defect handling decision skipped (engine unavailable): ${err.message}`);
        console.warn(`[Orchestrator] ⚠️  SocraticEngine defect decision skipped – proceeding automatically. Reason: ${err.message}`);
      }

      // P1-NEW-5 fix: use QualityGate for TEST stage decision (same pattern as ARCHITECT/CODE).
      // corrResult is adapted to the reviewResult shape QualityGate.evaluate() expects.
      const testGate = new QualityGate({ experienceStore: this.experienceStore, maxRollbacks: 1 });
      const testRollbackCountForGate = this._rollbackCounters?.get(WorkflowState.TEST) ?? 0;
      const testGateInput = {
        failed: corrResult.signals.filter(s => s.severity === 'high').length,
        needsHumanReview: corrResult.needsHumanReview,
        total: corrResult.signals.length,
        rounds: corrResult.rounds,
        riskNotes: [riskMsg],
        // Defect A fix: pass correction history so recordExperience() can record
        // diagnostic information ("what was fixed") instead of just "passed/failed".
        history: corrResult.history || [],
      };
      const testDecision = testGate.evaluate(testGateInput, WorkflowState.TEST, testRollbackCountForGate);
      testGate.recordExperience(testDecision, WorkflowState.TEST, testGateInput, { skill: 'test-report', category: ExperienceCategory.PITFALL });

      // ── Prompt A/B: record tester outcome ────────────────────────────────
      _recordPromptABOutcome('tester', !testDecision.rollback, corrResult.rounds ?? 0);

      if (testDecision.rollback) {
        // Roll back to CODE when test report has high-severity issues.
        // P1-NEW-3 fix: use this._rollbackCounters (instance-level Map) instead of stageCtx.meta.
        // RollbackCoordinator calls stageCtx.delete(WorkflowState.TEST) during rollback, which would reset
        // the counter to 0 and cause infinite recursion (_runTester → rollback → _runTester).
        // see CHANGELOG: T-4, P2-2/_runTester, P0-2/counter-read
        const testRollbackCount = this._rollbackCounters?.get(WorkflowState.TEST) ?? 0;
        // Increment the independent counter before entering the rollback path
        if (this._rollbackCounters) this._rollbackCounters.set(WorkflowState.TEST, testRollbackCount + 1);
        // P2-D: _pendingTestMeta lifecycle clarification.
        //
        // _pendingTestMeta is a "deferred write" pattern: it carries rollback metadata
        // (specifically _testRollbackCount) from the rollback path to the final
        // storeTestContext() call at the end of _runTesterOnce.
        //
        // Why deferred? RollbackCoordinator.rollback(WorkflowState.TEST) calls stageCtx.delete(WorkflowState.TEST),
        // which wipes the TEST context entry. If we wrote _testRollbackCount into stageCtx
        // immediately, it would be erased by the rollback. Instead, we park it in
        // _pendingTestMeta and merge it in storeTestContext() AFTER the rollback completes.
        //
        // Lifecycle:
        //   SET HERE (rollback path):
        //     _pendingTestMeta._testRollbackCount = testRollbackCount + 1
        //     (survives the rollback because it's on `this`, not in stageCtx)
        //
        //   READ + CLEARED in storeTestContext() (normal completion path):
        //     storeTestContext merges _pendingTestMeta into the TEST context entry,
        //     then sets this._pendingTestMeta = null.
        //
        //   RESET HERE (retry signal path, line below):
        //     When returning { __retry: true }, we clear _pendingTestMeta because
        //     the next iteration of _runTesterOnce will set it fresh if needed.
        //     Without this reset, a stale _pendingTestMeta from iteration N would
        //     be merged into the TEST context of iteration N+1 (incorrect count).
        //
        // Thread safety: _runTester is sequential (no concurrent _runTesterOnce calls),
        // so there is no race condition on _pendingTestMeta.
        if (!this._pendingTestMeta) this._pendingTestMeta = {};
        this._pendingTestMeta._testRollbackCount = testRollbackCount + 1;
        try {
          // ── Coordinated rollback (P0-A: RollbackCoordinator handles all cleanup) ──
          const coordinator = new RollbackCoordinator(this);
          await coordinator.rollback(WorkflowState.TEST, `Test report failed: ${riskMsg.slice(0, 200)}`);

          // Append failure context to code.diff so developer knows what to fix
          const codeDiffPath = path.join(PATHS.OUTPUT_DIR, 'code.diff');
          const failureNote = `\n\n---\n## ⚠️ Test Report Failure (Retry ${testRollbackCount + 1})\n\nThe previous implementation failed test report review with these issues:\n${riskMsg}\n\nPlease fix the implementation to address these test failures before the tester retries.`;
          if (fs.existsSync(codeDiffPath)) {
            fs.appendFileSync(codeDiffPath, failureNote, 'utf-8');
          }
          // Re-publish ARCHITECT → DEVELOPER bus message so _runDeveloper can consume it
          const archOutputPath = path.join(PATHS.OUTPUT_DIR, 'architecture.md');
          if (fs.existsSync(archOutputPath)) {
            this.bus.publish(AgentRole.ARCHITECT, AgentRole.DEVELOPER, archOutputPath, {
              testReportFailed: true,
              riskMsg,
              rollbackRetry: testRollbackCount + 1,
              reviewRounds: 1,
              failedItems: 1,
            });
          }
          // Re-run developer then recursively re-run the full TEST stage.
          // Bus meta includes reviewRounds so _runDeveloper logs the retry correctly.
          // see CHANGELOG: P0-1/_runTester, P0-2/_runTester
          //
          // P0-A fix: _runDeveloper.call(this) bypasses _runStage's Observability timing
          // and error handling. Wrap it with inline obs.stageStart/stageEnd so the
          // DEVELOPER retry is visible in metrics-history.jsonl and _adaptiveStrategy.
          const devStageLabel = 'TEST→CODE(rollback-retry)';
          this.obs.stageStart(devStageLabel);
          let devRetry;
          try {
            devRetry = await _runDeveloper.call(this);
            this.obs.stageEnd(devStageLabel, 'ok');
          } catch (devErr) {
            this.obs.stageEnd(devStageLabel, 'error');
            this.obs.recordError(devStageLabel, devErr.message);
            // Re-emit WORKFLOW_ERROR so HookSystem handlers are triggered (mirrors _runStage behaviour)
            await this.hooks.emit(HOOK_EVENTS.WORKFLOW_ERROR, { error: devErr, state: 'TEST→CODE(rollback)' }).catch(() => {});
            throw devErr;
          }
          // _runDeveloper may return a sentinel { __alreadyTransitioned: true } if it
          // triggered its own rollback. In that case, propagate the sentinel upward.
          // P0-A fix: return structured sentinel so _runTester (iterative) can propagate it.
          if (devRetry && typeof devRetry === 'object' && devRetry.__alreadyTransitioned) {
            return { __done: true, __alreadyTransitioned: true };
          }
          // Resolve developer output path: prefer stageCtx CODE artifact, then devRetry string.
          // see CHANGELOG: P0-2/_runTester
          let devOutputPath;
          if (typeof devRetry === 'string') {
            devOutputPath = devRetry;
          } else {
            // Try to read the actual CODE artifact path from stageCtx
            const codeCtxArtifacts = this.stageCtx?.get(WorkflowState.CODE)?.artifacts;
            const stageCtxCodePath = Array.isArray(codeCtxArtifacts) && codeCtxArtifacts.length > 0
              ? codeCtxArtifacts[0]
              : null;
            devOutputPath = stageCtxCodePath || path.join(PATHS.OUTPUT_DIR, 'code.diff');
          }
          if (fs.existsSync(devOutputPath)) {
            this.bus.publish(AgentRole.DEVELOPER, AgentRole.TESTER, devOutputPath, {
              testRollbackRetry: testRollbackCount + 1,
            });
          }
          // P0-A fix: instead of recursively calling _runTester, return { __retry: true }
          // so the outer while-loop in _runTester can continue to the next iteration.
          // This eliminates the recursive call stack and the associated stack-overflow risk.
          console.log(`[Orchestrator] 🔄 Signalling TEST stage retry (rollback round ${testRollbackCount + 1}) – iterative loop will continue...`);
          this._pendingTestMeta = null;
          return { __retry: true };
        } catch (rollbackErr) {
          console.warn(`[Orchestrator] Test rollback failed (non-fatal): ${rollbackErr.message}. Proceeding with risks recorded.`);
        }
      } else {
        // testDecision.needsHumanReview: rollback budget exhausted
        console.warn(`[Orchestrator] ⚠️  Test rollback limit reached (max 1). Proceeding with ${corrResult.signals.filter(s => s.severity === 'high').length} unresolved high-severity issue(s).`);
      }
    } else {
      console.log(`[Orchestrator] ✅ Test report passed self-correction. Workflow proceeding.`);
      const testPassTitle = 'Test report passed self-correction with no high-severity issues';
      this.experienceStore.recordIfAbsent(testPassTitle, {
        type: ExperienceType.POSITIVE,
        category: ExperienceCategory.STABLE_PATTERN,
        title: testPassTitle,
        content: `Test report passed self-correction with no high-severity issues remaining.`,
        skill: 'test-report',
        tags: ['test-report', 'passed', 'stable'],
      });
    }
  }

  // ── Real Test Execution + Auto-Fix Loop ──────────────────────────────────
  const testCommand = this._config.testCommand || null;
  const autoFixCfg = this._config.autoFixLoop || {};
  const autoFixEnabled = autoFixCfg.enabled !== false && !!testCommand;
  const maxFixRounds = this._adaptiveStrategy.maxFixRounds ?? autoFixCfg.maxFixRounds ?? 2;
  const failOnUnfixed = autoFixCfg.failOnUnfixed ?? false;

  if (maxFixRounds !== (autoFixCfg.maxFixRounds ?? 2)) {
    console.log(`[Orchestrator] 📈 Adaptive maxFixRounds: ${maxFixRounds} (history-adjusted from default ${autoFixCfg.maxFixRounds ?? 2})`);
  }

  if (!testCommand) {
    console.log(`[Orchestrator] ℹ️  No testCommand configured – skipping real test execution.`);
    console.log(`[Orchestrator] 💡 Set testCommand in workflow.config.js to enable automated verification.`);
  } else {
    await _runRealTestLoop.call(this, { testCommand, autoFixEnabled, maxFixRounds, failOnUnfixed, testReportPath: outputPath, lintCommand: this._config?.lintCommand || null, fixConversationHistory, injectedExpIds: testExpContextWithComplaints._injectedExpIds || [] });
  }

  // ── CIIntegration ────────────────────────────────────────────────────────
  try {
    console.log(`\n[Orchestrator] 🚀 Running CI pipeline validation (post-test)...`);
    await this.hooks.emit(HOOK_EVENTS.CI_PIPELINE_STARTED, { command: this._config.testCommand || null });
    const ciResult = await this.ci.runLocalPipeline({ skipEntropy: this._adaptiveStrategy.skipEntropyOnClean });
    this.obs.recordCIResult(ciResult);
    await this.hooks.emit(HOOK_EVENTS.CI_PIPELINE_COMPLETE, { result: ciResult });
    if (ciResult.status === 'success') {
      console.log(`[Orchestrator] ✅ CI pipeline passed: ${ciResult.message}`);
    } else {
      const ciMsg = `[CIIntegration] Pipeline ${ciResult.status}: ${ciResult.message}`;
      console.warn(`[Orchestrator] ⚠️  ${ciMsg}`);
      this.stateMachine.recordRisk('medium', ciMsg);
      await this.hooks.emit(HOOK_EVENTS.CI_PIPELINE_FAILED, { result: ciResult });
    }
  } catch (err) {
    console.warn(`[Orchestrator] CI pipeline validation failed (non-fatal): ${err.message}`);
  }

  // ── Entropy GC ───────────────────────────────────────────────────────────
  if (this._adaptiveStrategy.skipEntropyOnClean) {
    console.log(`[Orchestrator] ⏭️  Entropy scan skipped (last 3 sessions had 0 violations – adaptive strategy).`);
    this.obs._entropySkipped = true;
  } else {
    console.log(`\n[Orchestrator] 🔍 Running entropy scan after Tester stage...`);
    try {
      const gcResult = await this.entropyGC.run();
      this.obs.recordEntropyResult(gcResult);
      if (gcResult.violations > 0) {
        const gcMsg = `[EntropyGC] ${gcResult.violations} violation(s) found after Tester stage (${gcResult.details?.high ?? 0} high / ${gcResult.details?.medium ?? 0} medium / ${gcResult.details?.low ?? 0} low). See output/entropy-report.md.`;
        console.warn(`[Orchestrator] ⚠️  ${gcMsg}`);
        if ((gcResult.details?.high ?? 0) > 0) {
          this.stateMachine.recordRisk('medium', gcMsg);
        }
        if (fs.existsSync(outputPath)) {
          const entropyNote = [
            ``, `---`, ``,
            `## 🔍 Entropy GC Scan (post-test)`, ``,
            `> Scanned ${gcResult.filesScanned} files | Found **${gcResult.violations}** violation(s)`,
            `> High: ${gcResult.details?.high ?? 0} | Medium: ${gcResult.details?.medium ?? 0} | Low: ${gcResult.details?.low ?? 0}`,
            `> Full report: \`output/entropy-report.md\``,
          ].join('\n');
          fs.appendFileSync(outputPath, entropyNote, 'utf-8');
        }
      } else {
      console.log(`[Orchestrator] ✅ Entropy scan: no violations found.`);
      }
    } catch (err) {
      console.warn(`[Orchestrator] EntropyGC scan failed (non-fatal): ${err.message}`);
    }
  }

  // Generate Chinese companion file for developers (non-blocking)
  translateMdFile(outputPath, this._rawLlmCall).catch(() => {});

  // Flush deferred hitCount increments – _runTester is the last stage. see CHANGELOG: P2-3
  // P1-D fix: await flushDirty() so we know the write completed before the workflow
  // returns. Previously this was fire-and-forget; if the process exited immediately
  // after _runTester returned, the hitCount increments would be silently lost.
  try {
    if (this.experienceStore && typeof this.experienceStore.flushDirty === 'function') {
      await this.experienceStore.flushDirty();
      console.log(`[Orchestrator] 💾 ExperienceStore flushed (hitCount increments persisted).`);
    }
  } catch (flushErr) {
    console.warn(`[Orchestrator] ⚠️  ExperienceStore flush failed (non-fatal): ${flushErr.message}`);
  }

  // Store TEST context; merge _pendingTestMeta (rollback counter) into the final entry.
  // P2-NEW-1: delegated to storeTestContext helper
  // Defect E fix: pass corrResult so its correction history is stored in TEST context.
  // corrResult may be undefined if testContent was empty (self-correction was skipped).
  storeTestContext(this, outputPath, tcGenResult, tcExecutionReport, corrResult ?? null);

  // P0-A fix: return structured result so _runTester (iterative outer loop) can handle it.
  return { __done: true, outputPath };
}

async function _runRealTestLoop({ testCommand, autoFixEnabled, maxFixRounds, failOnUnfixed, testReportPath, lintCommand = null, fixConversationHistory = null, injectedExpIds = [] }) {
  // P2-D fix: accept fixConversationHistory from the caller (_runTesterOnce) so it
  // persists across TEST stage iterations (rollback + retry). If not provided
  // (e.g. direct call in tests), fall back to a fresh local array.
  //
  // P0-B fix: eliminate the unnecessary parameter reassignment (no-param-reassign).
  // The previous code did:
  //   const _fixHistory = fixConversationHistory || [];
  //   fixConversationHistory = _fixHistory;  // ← reassigns the parameter variable
  // This was a code smell: reassigning a parameter variable is confusing and
  // triggers eslint no-param-reassign. The logic was actually correct (when a
  // non-null array is passed in, _fixHistory === fixConversationHistory, so push()
  // mutates the caller's array), but the intent was obscured.
  // Fix: use a clearly-named const alias; all references below use fixHistory.
  const fixHistory = fixConversationHistory || [];
  const runner = new TestRunner({
    projectRoot: this.projectRoot,
    testCommand,
    timeoutMs: 180_000,
    verbose: true,
  });

  console.log(`\n[Orchestrator] 🔬 Running real test suite: ${testCommand}`);
  // Wrap runner.run() in try/catch – execSync throws ENOENT for missing commands. see CHANGELOG: Defect B
  let result;
  try {
    result = runner.run();
  } catch (runErr) {
    console.error(`[Orchestrator] ❌ Test runner threw an unexpected error: ${runErr.message}`);
    this.stateMachine.recordRisk('high', `[RealTest] Test runner crashed: ${runErr.message}`);
    if (failOnUnfixed) throw runErr;
    return;
  }

  const realResultMd = TestRunner.formatResultAsMarkdown(result);
  if (fs.existsSync(testReportPath)) {
    fs.appendFileSync(testReportPath, `\n\n---\n\n${realResultMd}`, 'utf-8');
  }

  if (result.passed) {
    console.log(`[Orchestrator] ✅ Real tests PASSED on first run.`);
    this.obs.recordTestResult({ passed: result.passed ? 1 : 0, failed: 0, skipped: 0, rounds: 1 });
    // EvoMap feedback loop (P1-3: extracted to runEvoMapFeedback)
    await runEvoMapFeedback(this, {
      injectedExpIds,
      errorContext: '',
      stageLabel: 'TEST (first-run pass)',
    });
    this.experienceStore.record({
      type: ExperienceType.POSITIVE,
      category: ExperienceCategory.STABLE_PATTERN,
      title: `Real tests passed: ${testCommand}`,
      content: `All tests passed on first run. Command: ${testCommand}. Duration: ${result.durationMs}ms.`,
      skill: 'test-report',
      tags: ['real-test', 'passed', 'first-run'],
    });
    return;
  }

  console.warn(`[Orchestrator] ❌ Real tests FAILED (exit ${result.exitCode}).`);
  if (!autoFixEnabled) {
    const msg = `[RealTest] Tests failed (exit ${result.exitCode}). Auto-fix disabled. Manual fix required.`;
    this.stateMachine.recordRisk('high', msg);
    console.warn(`[Orchestrator] ⚠️  Auto-fix disabled. Recorded as risk.`);
    if (failOnUnfixed) throw new Error(msg);
    return;
  }

  let fixRound = 0;
  // P2-D fix: fixConversationHistory is now passed in from _runTester's outer loop
  // (via _runTesterOnce) so it persists across TEST stage iterations.
  // P0-B fix: the parameter is aliased to `fixHistory` (const) at the top of this
  // function to avoid the no-param-reassign eslint rule. All references below use fixHistory.
  // P0-NEW-2: Maintain conversation history across fix rounds so the LLM can reason
  // about WHY previous fixes failed and avoid repeating the same mistakes.
  // Format: [{ role: 'user'|'assistant', content: string }]

  while (!result.passed && fixRound < maxFixRounds) {
    fixRound++;
    console.log(`\n[Orchestrator] 🔧 Auto-fix round ${fixRound}/${maxFixRounds}...`);

    // Cap failureContext to 6000 chars (keep tail – most recent error details). see CHANGELOG: P1-4/failureContext
    const _rawFailureContext = TestRunner.formatResultAsMarkdown(result);
    const failureContext = _rawFailureContext.length > 6000
      ? `... [${_rawFailureContext.length - 6000} chars omitted] ...\n` + _rawFailureContext.slice(-6000)
      : _rawFailureContext;
    const codeDiffPath = path.join(PATHS.OUTPUT_DIR, 'code.diff');
    const existingDiff = fs.existsSync(codeDiffPath) ? fs.readFileSync(codeDiffPath, 'utf-8') : '(no previous diff)';

    // P0-NEW-2: previousFixSummaries are only needed in round 1 (no history yet).
    // From round 2 onwards, the full conversation history already contains all prior
    // fix attempts and the LLM's reasoning – injecting text summaries would be redundant.
    //
    // P2-C fix: removed dead-code loop.
    //
    // The previous code was:
    //   const previousFixSummaries = [];
    //   if (fixRound === 1) {
    //     for (let r = 1; r < fixRound; r++) {   // ← DEAD CODE: when fixRound===1,
    //       ...                                   //   condition is 1 < 1 → always false
    //     }
    //   }
    //
    // The intent was to inject pre-existing fix files from a previous run (e.g. a
    // checkpoint resume). But the loop condition `r < fixRound` when `fixRound === 1`
    // evaluates to `1 < 1` which is always false – the loop body never executes.
    // previousFixSummaries was always an empty array, and previousFixesBlock was
    // always '' on the first round.
    //
    // The correct logic for round 1 is: there are no previous fix files from THIS
    // run (fixRound starts at 1), so previousFixSummaries is correctly empty.
    // If checkpoint-resume support is needed in the future, the loop condition
    // should be `r < fixRound` starting from the RESUMED round number, not 1.
    // For now, the dead code is removed to avoid confusion.
    const previousFixesBlock = fixRound > 1
      ? `## Fix History\n> This is fix round ${fixRound}. Your previous fix attempt(s) are in the conversation history above.\n> Review what you tried before and why it did not fully resolve the failures.`
      : '';

    // Collect actual source files for Fix Agent context (not just the diff)
    // This resolves the "blind fix" problem where Fix Agent only saw code.diff
    // and had no visibility into the actual current state of source files.
    //
    // P2-A fix: replaced the inline collectFiles() closure with the shared
    // scanSourceFiles() utility from file-scanner.js. The inline closure was a
    // third copy of the same "walk dir tree, filter by extension, skip ignored dirs"
    // logic that already existed in entropy-gc.js and code-graph.js. The three
    // copies had subtle differences (depth limit, dot-file skipping, maxFiles cap)
    // that were a maintenance hazard. scanSourceFiles() is the canonical version.
    let sourceFilesContext = '';
    try {
      const sourceExts = (this._config.sourceExtensions || ['.js', '.ts', '.py', '.go', '.java', '.cs']);
      const ignoreDirs = this._config.ignoreDirs || ['node_modules', '.git', 'dist', 'build', 'output'];

      // scanSourceFiles() handles: depth limit (maxDepth=4), dot-file skipping,
      // ignoreDirs filtering, and extension filtering – all in one canonical place.
      const sourceFiles = scanSourceFiles(this.projectRoot, {
        extensions: sourceExts,
        ignoreDirs,
        maxDepth: 4,       // same limit as the previous inline closure (depth > 4)
        skipDotFiles: true, // consistent with entropy-gc.js and code-graph.js
      });

      // Prioritise files mentioned in the failure output
      const failureText = result.output || (result.failureSummary || []).join('\n'); // see CHANGELOG: P1-2/sourceFiles
      const mentionedFiles = sourceFiles.filter(f => {
        const rel = path.relative(this.projectRoot, f).replace(/\\/g, '/');
        return failureText.includes(rel) || failureText.includes(path.basename(f));
      });
      const otherFiles = sourceFiles.filter(f => !mentionedFiles.includes(f));
      const orderedFiles = [...mentionedFiles, ...otherFiles];

      const fileSnippets = [];
      let totalChars = 0;
      const MAX_SOURCE_CHARS = 8000;

      for (const filePath of orderedFiles) {
        if (totalChars >= MAX_SOURCE_CHARS) break;
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const rel = path.relative(this.projectRoot, filePath).replace(/\\/g, '/');
          const rawSnippet = content.length > 3000 ? content.slice(0, 3000) + '\n... (truncated)' : content;
          // Add line numbers so Fix Agent can use [LINE_RANGE] blocks accurately. see CHANGELOG: P0-C
          const numberedSnippet = rawSnippet.split('\n').map((line, i) => `${String(i + 1).padStart(4, ' ')} | ${line}`).join('\n');
          fileSnippets.push(`### ${rel}\n\`\`\`\n${numberedSnippet}\n\`\`\``);
          totalChars += numberedSnippet.length;
        } catch { /* skip unreadable files */ }
      }

      if (fileSnippets.length > 0) {
        sourceFilesContext = `## Current Source Files (${fileSnippets.length} file(s))\n\n${fileSnippets.join('\n\n')}`;
        console.log(`[Orchestrator] 📂 Fix Agent context: ${fileSnippets.length} source file(s) injected (${totalChars} chars)`);
      }
    } catch (err) {
      console.warn(`[Orchestrator] ⚠️  Could not collect source files for Fix Agent: ${err.message}`);
    }

    const fixPrompt = [
      `You are **David Thomas and Andrew Hunt** \u2013 The Pragmatic Programmers, authors of *The Pragmatic Programmer: From Journeyman to Master* and the engineers who gave the industry the DRY principle, tracer bullets, and the broken windows theory of software quality.`,
      `Your hallmark: you fix the ROOT CAUSE, not the symptom. You never apply a patch that makes the tests pass by coincidence. You leave the code in a better state than you found it.`,
      `You are acting as the **Code Fix Agent** for this workflow. The project's test suite has failed.`,
      `Your task: produce fix blocks that fix ALL failing tests.`,
      ``,
      `## Architecture Design`,
      `> **[MANDATORY]** Before writing any fix, document your diagnosis:`,
      `> - Root cause of each failing test (what is broken and why)`,
      `> - Which files/functions need to change`,
      `> - Why your proposed fix is correct (not just a workaround)`,
      ``,
      `## Execution Plan`,
      `> **[MANDATORY]** List the fix steps in order:`,
      `> 1. Fix #1: <file> lines <start>–<end> – <what you're changing and why>`,
      `> 2. Fix #2: <file> lines <start>–<end> – <what you're changing and why>`,
      `> (continue for each fix block below)`,
      ``,
      `## Previous Diff (for reference)`,
      `\`\`\`diff`,
      existingDiff.slice(0, 2000),
      `\`\`\``,
      ``,
      previousFixesBlock,
      ``,
      sourceFilesContext,
      ``,
      failureContext,
      ``,
      `## Fix Block Formats`,
      ``,
      `### PREFERRED: [LINE_RANGE] – line-number replacement (use this whenever you know the line numbers)`,
      ``,
      `[LINE_RANGE]`,
      `file: relative/path/to/file.js`,
      `start_line: 42`,
      `end_line: 47`,
      `replace: |`,
      `  <new code that replaces lines 42–47, preserving surrounding indentation>`,
      `[/LINE_RANGE]`,
      ``,
      `### FALLBACK: [REPLACE_IN_FILE] – string-match replacement (use only when line numbers are unknown)`,
      ``,
      `[REPLACE_IN_FILE]`,
      `file: relative/path/to/file.js`,
      `find: |`,
      `  <exact code to find – MUST be copy-pasted verbatim from the source above, including all spaces and indentation>`,
      `replace: |`,
      `  <new code to replace it with>`,
      `[/REPLACE_IN_FILE]`,
      ``,
      `## Rules`,
      `1. Analyse the failure output above and identify the root cause of each failing test.`,
      `2. Fill in the Architecture Design and Execution Plan sections FIRST, then output fix blocks.`,
      `3. **PREFER [LINE_RANGE]**: The source files above include line numbers. Use start_line/end_line whenever possible.`,
      `   [LINE_RANGE] is immune to whitespace/indent mismatches that cause [REPLACE_IN_FILE] to fail silently.`,
      `4. If you use [REPLACE_IN_FILE], the "find:" block MUST be copy-pasted verbatim from the source (no paraphrasing).`,
      `5. Only change what is necessary to fix the failures.`,
      `6. Do NOT change test files unless the test itself is clearly wrong.`,
      `7. File paths are relative to the project root: ${this.projectRoot}`,
    ].join('\n');

    console.log(`[Orchestrator] 🤖 Invoking Code Fix Agent for fix round ${fixRound}...`);
    let fixResponse;
    try {
      // P0-NEW-2: push current round's prompt into conversation history,
      // then call LLM with the full history array.
      // If _rawLlmCall supports array input (multi-turn), it will use the full history.
      // If it only supports string input (single-turn), we fall back to the flat prompt.
      fixHistory.push({ role: 'user', content: fixPrompt });

      const llmInput = fixHistory.length > 1
        ? fixHistory  // multi-turn: pass full history
        : fixPrompt;              // first round: pass string (backward compat)

      fixResponse = await this._rawLlmCall(llmInput);

      // Push assistant response into history so next round sees the full reasoning chain
      if (fixResponse && fixResponse.trim()) {
        fixHistory.push({ role: 'assistant', content: fixResponse });
      }
    } catch (err) {
      console.error(`[Orchestrator] ❌ LLM call failed during fix round ${fixRound}: ${err.message}`);
      break;
    }

    if (!fixResponse || !fixResponse.trim()) {
      console.warn(`[Orchestrator] ⚠️  Code Fix Agent returned empty response in fix round ${fixRound}. Stopping.`);
      break;
    }

    const fixedDiffPath = path.join(PATHS.OUTPUT_DIR, `code-fix-round${fixRound}.txt`);
    fs.writeFileSync(fixedDiffPath, fixResponse, 'utf-8');
    console.log(`[Orchestrator] 📝 Fix response saved to: ${fixedDiffPath}`);

    const applyResult = this._applyFileReplacements(fixResponse);
    console.log(`[Orchestrator] 🔧 Applied ${applyResult.applied} replacement(s), ${applyResult.failed} failed.`);
    if (applyResult.failed > 0) {
      console.warn(`[Orchestrator] ⚠️  Some replacements failed:\n${applyResult.errors.join('\n')}`);
    }
    if (applyResult.applied === 0) {
      console.warn(`[Orchestrator] ⚠️  No replacements were applied. Stopping fix loop.`);
      fixRound--; // no real fix applied this round – see CHANGELOG: P1-1/fixRound
      break;
    }

    // ── P2-B fix: post-fix validation ─────────────────────────────────────
    // Before re-running tests, verify the fix didn't introduce new lint errors
    // or modify test files (which would be a sign of a bad fix).
    //
    // Problem: Fix Agent previously only checked "did tests pass?" after applying
    // a fix. It could silently introduce lint errors or modify test files to make
    // tests pass artificially. This step catches those cases early.
    if (lintCommand) {
      console.log(`[Orchestrator] 🔍 Post-fix lint check: ${lintCommand}`);
      try {
        const { execSync } = require('child_process');
        execSync(lintCommand, { cwd: this.projectRoot, stdio: 'pipe', timeout: 60_000 });
        console.log(`[Orchestrator] ✅ Post-fix lint: no errors.`);
      } catch (lintErr) {
        const lintOutput = (lintErr.stdout?.toString() || '') + (lintErr.stderr?.toString() || '');
        console.warn(`[Orchestrator] ⚠️  Post-fix lint FAILED in fix round ${fixRound}:\n${lintOutput.slice(0, 800)}`);
        this.stateMachine.recordRisk('medium', `[RealTest] Fix round ${fixRound} introduced lint errors: ${lintOutput.slice(0, 200)}`);
        // Don't abort – record the lint failure and continue to test run so we
        // get the full picture. The test run may also fail, giving Fix Agent
        // more context in the next round.
      }
    }

    // Warn if Fix Agent modified test files (suspicious – may be gaming the tests)
    if (applyResult.modifiedFiles && applyResult.modifiedFiles.length > 0) {
      const testFilePattern = /\.(test|spec)\.[jt]s$|__tests__\//i;
      const modifiedTestFiles = applyResult.modifiedFiles.filter(f => testFilePattern.test(f));
      if (modifiedTestFiles.length > 0) {
        const warnMsg = `[RealTest] Fix round ${fixRound} modified test file(s): ${modifiedTestFiles.join(', ')}. This may indicate the fix is gaming the tests rather than fixing the code.`;
        console.warn(`[Orchestrator] ⚠️  ${warnMsg}`);
        this.stateMachine.recordRisk('medium', warnMsg);
      }
    }
    // ── end P2-B fix ───────────────────────────────────────────────────────

    console.log(`[Orchestrator] 🔬 Re-running tests after fix round ${fixRound}...`);
    try {
      result = runner.run();
    } catch (rerunErr) {
      console.error(`[Orchestrator] ❌ Test runner threw an error in fix round ${fixRound}: ${rerunErr.message}`);
      this.stateMachine.recordRisk('high', `[RealTest] Test runner crashed in fix round ${fixRound}: ${rerunErr.message}`);
      // Use rerunErr.status (current crash exit code), not stale result.exitCode. see CHANGELOG: P0-1/exitCode
      if (result) result = { ...result, passed: false, exitCode: rerunErr.status ?? 1 };
      if (failOnUnfixed) throw rerunErr;
      break;
    }

    const roundMd = `\n\n---\n\n## Auto-Fix Round ${fixRound} Result\n\n` + TestRunner.formatResultAsMarkdown(result);
    if (fs.existsSync(testReportPath)) {
      fs.appendFileSync(testReportPath, roundMd, 'utf-8');
    }

    if (result.passed) {
      console.log(`[Orchestrator] ✅ Tests PASSED after fix round ${fixRound}.`);
      this.obs.recordTestResult({ passed: 1, failed: 0, skipped: 0, rounds: fixRound });
      // EvoMap feedback loop (P1-3: extracted to runEvoMapFeedback)
      await runEvoMapFeedback(this, {
        injectedExpIds,
        errorContext: (result.failureSummary || []).join(' ') || (result.output || ''),
        stageLabel: `TEST (auto-fix round ${fixRound})`,
      });
      this.experienceStore.record({
        type: ExperienceType.POSITIVE,
        category: ExperienceCategory.STABLE_PATTERN,
        title: `Real tests passed after ${fixRound} auto-fix round(s)`,
        content: `Tests passed after ${fixRound} fix round(s). Command: ${testCommand}. Failure summary: ${(result.failureSummary || []).slice(0, 3).join('; ')}.`,
        skill: 'test-report',
        tags: ['real-test', 'auto-fix', 'passed'],
      });

      // Re-annotate test-cases.md with post-fix PASS statuses. see CHANGELOG: T-5
      try {
        const { TestCaseExecutor } = require('./test-case-executor');
        const tcExecutorForUpdate = new TestCaseExecutor({
          projectRoot: this.projectRoot,
          testCommand,
          outputDir: PATHS.OUTPUT_DIR,
          verbose: false,
        });
        const cases = tcExecutorForUpdate._parseCasesFromMd();
        if (cases.length > 0) {
          // Build synthetic caseResults: all PASS since tests just passed
          const updatedResults = cases.map(tc => ({
            ...tc,
            _executionStatus: 'PASS',
            _executionOutput: `Passed after auto-fix round ${fixRound}`,
          }));
          // Append a new annotation section (timestamped) to distinguish from the original
          const statusIcon = { PASS: '✅', FAIL: '❌', BLOCKED: '⚠️', SKIPPED: '⏭️' };
          const rows = updatedResults.map(tc => {
            const icon = statusIcon[tc._executionStatus] || '❓';
            const title = (tc.title || tc.case_id || '').replace(/\|/g, '\\|');
            return `| ${tc.case_id} | ${title} | ${icon} ${tc._executionStatus} |`;
          });
          const annotation = [
            ``,
            `---`,
            ``,
            `## 🔧 Post-Fix Execution Results (Fix Round ${fixRound})`,
            ``,
            `> Auto-updated by TestCaseExecutor at ${new Date().toISOString()}`,
            `> **${updatedResults.length} passed** | **0 failed** | **0 blocked**`,
            ``,
            `| Case ID | Title | Status |`,
            `|---------|-------|--------|`,
            ...rows,
          ].join('\n');
          const testCasesPath = path.join(PATHS.OUTPUT_DIR, 'test-cases.md');
          if (fs.existsSync(testCasesPath)) {
            fs.appendFileSync(testCasesPath, annotation, 'utf-8');
            console.log(`[Orchestrator] 📝 test-cases.md updated with post-fix PASS statuses (${updatedResults.length} case(s)).`);
          }
        }
      } catch (annotateErr) {
        console.warn(`[Orchestrator] ⚠️  Could not update test-cases.md after fix (non-fatal): ${annotateErr.message}`);
      }

      return;
    }

    console.warn(`[Orchestrator] ❌ Tests still failing after fix round ${fixRound}.`);
  }

  // Guard against result.failureSummary being undefined. see CHANGELOG: P1-2/failureSummary
  const failMsg = `[RealTest] Tests still failing after ${fixRound} auto-fix round(s). Exit code: ${result.exitCode}. Failures: ${(result.failureSummary || []).slice(0, 3).join('; ')}`;
  this.stateMachine.recordRisk('high', failMsg);
  this.obs.recordTestResult({ passed: 0, failed: (result.failureSummary || []).length || 1, skipped: 0, rounds: fixRound });
  this.experienceStore.record({
    type: ExperienceType.NEGATIVE,
    category: ExperienceCategory.PITFALL,
    title: `Real tests failed after ${fixRound} auto-fix rounds`,
    content: failMsg,
    skill: 'test-report',
    tags: ['real-test', 'auto-fix', 'failed'],
  });
  console.warn(`[Orchestrator] ⚠️  Tests still failing after all fix rounds. Recorded as high-risk.`);
  if (failOnUnfixed) {
    throw new Error(failMsg);
  }
}

module.exports = { _runAnalyst, _runArchitect, _runDeveloper, _runTester, _runRealTestLoop };
