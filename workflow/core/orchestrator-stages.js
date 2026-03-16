'use strict';

const fs   = require('fs');
const path = require('path');
const { PATHS, HOOK_EVENTS } = require('./constants');
const { AgentRole } = require('./types');
const { ExperienceType, ExperienceCategory } = require('./experience-store');
const { ComplaintTarget } = require('./complaint-wall');
const { SelfCorrectionEngine, formatClarificationReport } = require('./clarification-engine');
const { RequirementClarifier } = require('./requirement-clarifier');
const { CoverageChecker } = require('./coverage-checker');
const { CodeReviewAgent } = require('./code-review-agent');
const { ArchitectureReviewAgent } = require('./architecture-review-agent');
const { TestRunner } = require('./test-runner');
const { TestCaseGenerator } = require('./test-case-generator');
const { TestCaseExecutor } = require('./test-case-executor');
const { DECISION_QUESTIONS } = require('./socratic-engine');
const { StageContextStore } = require('./stage-context-store');

/**
 * Stage runner methods for Orchestrator.
 * All functions use `this` bound to the Orchestrator instance.
 */

async function _runAnalyst(rawRequirement) {
  console.log(`\n[Orchestrator] Stage: ANALYSE (AnalystAgent)`);

  // ── Cross-stage context: init store on first stage ────────────────────────
  // StageContextStore is lazily initialised here (first stage) and reused
  // across all stages via this.stageCtx. Each stage deposits a summary of
  // its key decisions so downstream agents can read the full upstream context.
  if (!this.stageCtx) {
    this.stageCtx = new StageContextStore({
      outputDir: PATHS.OUTPUT_DIR,
      verbose: false,
    });
    console.log(`[Orchestrator] 🔗 StageContextStore initialised for cross-stage context propagation.`);
  }

  const clarifier = new RequirementClarifier({
    askUser: this.askUser,
    maxRounds: 2,
    verbose: true,
    llmCall: this._rawLlmCall,
  });
  const clarResult = await clarifier.clarify(rawRequirement);

  if (clarResult.riskNotes && clarResult.riskNotes.length > 0) {
    try {
      const scopeDecision = await this.socratic.ask(DECISION_QUESTIONS.SCOPE_CLARIFICATION);
      console.log(`[Orchestrator] 🤔 Scope clarification decision: "${scopeDecision.optionText}"`);
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

  const outputPath = await this.agents[AgentRole.ANALYST].run(null, clarResult.enrichedRequirement);

  // ── Store ANALYSE stage context for downstream stages ─────────────────────
  const analyseCtx = StageContextStore.extractFromFile(outputPath, 'ANALYSE');
  this.stageCtx.set('ANALYSE', {
    summary:      analyseCtx.summary,
    keyDecisions: analyseCtx.keyDecisions,
    artifacts:    [outputPath],
    risks:        clarResult.riskNotes ?? [],
    meta: {
      clarificationRounds: clarResult.rounds ?? 0,
      signalCount:         clarResult.allSignals?.length ?? 0,
      skipped:             clarResult.skipped ?? false,
    },
  });
  console.log(`[Orchestrator] 🔗 ANALYSE context stored: ${analyseCtx.keyDecisions.length} key decision(s).`);

  this.bus.publish(AgentRole.ANALYST, AgentRole.ARCHITECT, outputPath, {
    clarificationRounds: clarResult.rounds ?? 0,
    signalCount:         clarResult.allSignals?.length ?? 0,
    riskNotes:           clarResult.riskNotes ?? [],
    skipped:             clarResult.skipped ?? false,
    contextSummary:      analyseCtx.summary,
  });
  return outputPath;
}

async function _runArchitect() {
  console.log(`\n[Orchestrator] Stage: ARCHITECT (ArchitectAgent)`);
  const inputPath = this.bus.consume(AgentRole.ARCHITECT);

  // ── Inject upstream cross-stage context ───────────────────────────────────
  // Architect now sees a structured summary of what the Analyst decided,
  // including key requirement sections and flagged risks.
  const upstreamCtxForArch = this.stageCtx ? this.stageCtx.getAll(['ARCHITECT'], 1500) : '';
  if (upstreamCtxForArch) {
    console.log(`[Orchestrator] 🔗 Cross-stage context injected into ArchitectAgent (${upstreamCtxForArch.length} chars). Upstream: ${this.stageCtx.getLogLine()}`);
  }

  let techStackPrefix = '';
  try {
    const techDecision = await this.socratic.ask(DECISION_QUESTIONS.TECH_STACK_PREFERENCE);
    console.log(`[Orchestrator] 🤔 Tech stack preference: "${techDecision.optionText}"`);
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

  const agentsMdForArch = this._agentsMdContent || '';
  if (agentsMdForArch) {
    console.log(`[Orchestrator] 📋 AGENTS.md injected into ArchitectAgent context.`);
  }

  const archExpContext = this.experienceStore.getContextBlock('architecture-design');
  console.log(`[Orchestrator] 📚 Experience context injected for ArchitectAgent (${archExpContext.length} chars)`);

  const archComplaints = this.complaintWall.getOpenComplaintsFor(ComplaintTarget.SKILL, 'architecture-design');
  const archComplaintBlock = archComplaints.length > 0
    ? `\n\n## Known Issues (Open Complaints)\n${archComplaints.map(c => `- [${c.severity}] ${c.description}`).join('\n')}`
    : '';
  const archExpContextWithComplaints = [
    techStackPrefix ? techStackPrefix.trim() : '',
    agentsMdForArch ? `## Project Context (AGENTS.md)\n${agentsMdForArch}` : '',
    upstreamCtxForArch,
    archExpContext,
    archComplaintBlock,
  ].filter(Boolean).join('\n\n');
  if (archComplaints.length > 0) {
    console.log(`[Orchestrator] ⚠️  ${archComplaints.length} open complaint(s) injected into ArchitectAgent context.`);
  }

  const outputPath = await this.agents[AgentRole.ARCHITECT].run(inputPath, null, archExpContextWithComplaints);

  const requirementPath = path.join(PATHS.OUTPUT_DIR, 'requirements.md');
  const coverageChecker = new CoverageChecker(this._rawLlmCall, { verbose: true });
  const coverageResult = await coverageChecker.check(requirementPath, outputPath);

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

  const archReviewer = new ArchitectureReviewAgent(
    this._rawLlmCall,
    {
      maxRounds: 2,
      verbose: true,
      outputDir: PATHS.OUTPUT_DIR,
      investigationTools: this._buildInvestigationTools('Architecture'),
    }
  );
  const archReviewResult = await archReviewer.review(outputPath, requirementPath);

  for (const note of archReviewResult.riskNotes) {
    const severity = note.includes('(high)') ? 'high' : 'medium';
    this.stateMachine.recordRisk(severity, note, false);
  }
  this.stateMachine.flushRisks();

  if (archReviewResult.failed === 0 || !archReviewResult.needsHumanReview) {
    try {
      const archDecision = await this.socratic.ask(DECISION_QUESTIONS.ARCHITECTURE_APPROVAL);
      if (archDecision.optionIndex === 1) {
        const abortMsg = '[SocraticEngine] User rejected architecture. Workflow aborted by user decision.';
        this.stateMachine.recordRisk('high', abortMsg);
        throw new Error(abortMsg);
      } else if (archDecision.optionIndex === 2) {
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
  }

  if (archReviewResult.failed === 0) {
    console.log(`[Orchestrator] ✅ Architecture review passed.`);
    const archPassTitle = 'Architecture design passed all checklist items';
    this.experienceStore.recordIfAbsent(archPassTitle, {
      type: ExperienceType.POSITIVE,
      category: ExperienceCategory.ARCHITECTURE,
      title: archPassTitle,
      content: `Architecture passed all ${archReviewResult.total ?? 'N/A'} checklist items with full requirement coverage.`,
      skill: 'architecture-design',
      tags: ['architecture-review', 'passed', 'stable'],
    });
  } else if (archReviewResult.needsHumanReview) {
    console.warn(`[Orchestrator] ⚠️  ${archReviewResult.failed} high-severity architecture issue(s) remain. Recorded as risks.`);
    const archFailTitle = 'Architecture review: high-severity issues unresolved after self-correction';
    const failedNotes = archReviewResult.riskNotes.slice(0, 3).join('; ');
    const failContent = `After ${archReviewResult.rounds ?? 'N/A'} self-correction round(s), ${archReviewResult.failed} high-severity issue(s) remained. Issues: ${failedNotes}`;
    if (!this.experienceStore.appendByTitle(archFailTitle, failContent)) {
      this.experienceStore.record({
        type: ExperienceType.NEGATIVE,
        category: ExperienceCategory.PITFALL,
        title: archFailTitle,
        content: failContent,
        skill: 'architecture-design',
        tags: ['architecture-review', 'failed', 'pitfall'],
      });
    }
  } else {
    console.log(`[Orchestrator] ℹ️  ${archReviewResult.failed} minor architecture issue(s) remain. Proceeding automatically.`);
  }

  // ── Store ARCHITECT stage context for downstream stages ──────────────────
  const archOutputCtx = StageContextStore.extractFromFile(outputPath, 'ARCHITECT');
  this.stageCtx.set('ARCHITECT', {
    summary:      archOutputCtx.summary,
    keyDecisions: archOutputCtx.keyDecisions,
    artifacts:    [outputPath],
    risks:        archReviewResult.riskNotes ?? [],
    meta: {
      reviewRounds: archReviewResult.rounds ?? 0,
      failedItems:  archReviewResult.failed ?? 0,
      coverageRate: coverageResult.coverageRate ?? null,
    },
  });
  console.log(`[Orchestrator] 🔗 ARCHITECT context stored: ${archOutputCtx.keyDecisions.length} key decision(s), ${archReviewResult.riskNotes?.length ?? 0} risk(s).`);

  this.bus.publish(AgentRole.ARCHITECT, AgentRole.DEVELOPER, outputPath, {
    reviewRounds:   archReviewResult.rounds ?? 0,
    failedItems:    archReviewResult.failed ?? 0,
    riskNotes:      archReviewResult.riskNotes ?? [],
    contextSummary: archOutputCtx.summary,
  });
  return outputPath;
}

async function _runDeveloper() {
  console.log(`\n[Orchestrator] Stage: CODE (DeveloperAgent)`);
  const inputPath = this.bus.consume(AgentRole.DEVELOPER);

  // ── Inject upstream cross-stage context ───────────────────────────────────
  // Developer now sees summaries from ANALYSE + ARCHITECT stages:
  // - What requirements were clarified
  // - What architecture decisions were made (tech stack, module structure, APIs)
  // - What risks were flagged upstream
  const upstreamCtxForDev = this.stageCtx ? this.stageCtx.getAll(['CODE'], 1800) : '';
  if (upstreamCtxForDev) {
    console.log(`[Orchestrator] 🔗 Cross-stage context injected into DeveloperAgent (${upstreamCtxForDev.length} chars). Upstream: ${this.stageCtx.getLogLine()}`);
  }

  const archMeta = this.bus.getMeta(AgentRole.DEVELOPER);
  if (archMeta && archMeta.reviewRounds > 0) {
    console.log(`[Orchestrator] ℹ️  Architecture was self-corrected in ${archMeta.reviewRounds} round(s) (${archMeta.failedItems} issue(s) fixed). Developer should review architecture.md carefully.`);
  }

  const agentsMdForDev = this._agentsMdContent || '';
  if (agentsMdForDev) {
    console.log(`[Orchestrator] 📋 AGENTS.md injected into DeveloperAgent context.`);
  }

  const devExpContext = this.experienceStore.getContextBlock('code-development');
  console.log(`[Orchestrator] 📚 Experience context injected for DeveloperAgent (${devExpContext.length} chars)`);

  let codeGraphContext = '';
  try {
    const archPath = path.join(PATHS.OUTPUT_DIR, 'architecture.md');
    if (fs.existsSync(archPath)) {
      const archContent = fs.readFileSync(archPath, 'utf-8');
      const identifiers = [...new Set(
        (archContent.match(/\b[A-Z][a-zA-Z0-9]{2,}\b/g) || [])
          .filter(id => id.length >= 3 && id.length <= 40)
          .slice(0, 20)
      )];
      if (identifiers.length > 0) {
        const graphMd = this.codeGraph.querySymbolsAsMarkdown(identifiers);
        if (graphMd && !graphMd.includes('_Code graph not available') && !graphMd.includes('_No matching')) {
          codeGraphContext = graphMd;
          console.log(`[Orchestrator] 🗺️  Code graph: queried ${identifiers.length} symbol(s) from architecture doc`);
        }
      }
    }
  } catch (err) {
    console.warn(`[Orchestrator] Code graph query failed (non-fatal): ${err.message}`);
  }

  const devComplaints = this.complaintWall.getOpenComplaintsFor(ComplaintTarget.SKILL, 'code-development');
  const devComplaintBlock = devComplaints.length > 0
    ? `\n\n## Known Issues (Open Complaints)\n${devComplaints.map(c => `- [${c.severity}] ${c.description}`).join('\n')}`
    : '';
  const devExpContextWithComplaints = [
    agentsMdForDev ? `## Project Context (AGENTS.md)\n${agentsMdForDev}` : '',
    upstreamCtxForDev,
    devExpContext,
    devComplaintBlock,
    codeGraphContext ? `\n\n${codeGraphContext}` : '',
  ].filter(Boolean).join('\n\n');
  if (devComplaints.length > 0) {
    console.log(`[Orchestrator] ⚠️  ${devComplaints.length} open complaint(s) injected into DeveloperAgent context.`);
  }

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

  for (const note of reviewResult.riskNotes) {
    const severity = note.includes('(high)') ? 'high' : 'medium';
    this.stateMachine.recordRisk(severity, note, false);
  }
  this.stateMachine.flushRisks();

  if (reviewResult.failed === 0) {
    console.log(`[Orchestrator] ✅ Code review passed. Proceeding automatically.`);
    const codePassTitle = 'Code development passed all checklist items';
    this.experienceStore.recordIfAbsent(codePassTitle, {
      type: ExperienceType.POSITIVE,
      category: ExperienceCategory.STABLE_PATTERN,
      title: codePassTitle,
      content: `Code passed all ${reviewResult.total ?? 'N/A'} checklist items.`,
      skill: 'code-development',
      tags: ['code-review', 'passed', 'stable'],
    });
  } else if (reviewResult.needsHumanReview) {
    console.warn(`[Orchestrator] ⚠️  ${reviewResult.failed} high-severity code issue(s) remain. Recorded as risks.`);
    const codeFailTitle = 'Code review: high-severity issues unresolved after self-correction';
    const failedNotes = reviewResult.riskNotes.slice(0, 3).join('; ');
    const failContent = `After ${reviewResult.rounds ?? 'N/A'} self-correction round(s), ${reviewResult.failed} high-severity issue(s) remained. Issues: ${failedNotes}`;
    if (!this.experienceStore.appendByTitle(codeFailTitle, failContent)) {
      this.experienceStore.record({
        type: ExperienceType.NEGATIVE,
        category: ExperienceCategory.PITFALL,
        title: codeFailTitle,
        content: failContent,
        skill: 'code-development',
        tags: ['code-review', 'failed', 'pitfall'],
      });
    }
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

  // ── Store CODE stage context for downstream stages ────────────────────────
  const codeOutputCtx = StageContextStore.extractFromFile(outputPath, 'CODE');
  this.stageCtx.set('CODE', {
    summary:      codeOutputCtx.summary,
    keyDecisions: codeOutputCtx.keyDecisions,
    artifacts:    [outputPath],
    risks:        reviewResult.riskNotes ?? [],
    meta: {
      reviewRounds: reviewResult.rounds ?? 0,
      failedItems:  reviewResult.failed ?? 0,
    },
  });
  console.log(`[Orchestrator] 🔗 CODE context stored: ${codeOutputCtx.keyDecisions.length} key decision(s), ${reviewResult.riskNotes?.length ?? 0} risk(s).`);

  this.bus.publish(AgentRole.DEVELOPER, AgentRole.TESTER, outputPath, {
    reviewRounds:   reviewResult.rounds ?? 0,
    failedItems:    reviewResult.failed ?? 0,
    riskNotes:      reviewResult.riskNotes ?? [],
    contextSummary: codeOutputCtx.summary,
  });
  return outputPath;
}

async function _runTester() {
  console.log(`\n[Orchestrator] Stage: TEST (TesterAgent)`);
  const inputPath = this.bus.consume(AgentRole.TESTER);

  // ── Inject upstream cross-stage context ───────────────────────────────────
  // Tester now sees summaries from ALL upstream stages:
  // - ANALYSE: what requirements were clarified, what risks were flagged
  // - ARCHITECT: what architecture was designed, what tech stack was chosen
  // - CODE: what was implemented, what code review issues were found
  // This gives the tester full visibility into the entire development history.
  const upstreamCtxForTest = this.stageCtx ? this.stageCtx.getAll(['TEST'], 2000) : '';
  if (upstreamCtxForTest) {
    console.log(`[Orchestrator] 🔗 Cross-stage context injected into TesterAgent (${upstreamCtxForTest.length} chars). Upstream: ${this.stageCtx.getLogLine()}`);
  }

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

  // ── Step 0.5: Execute generated test cases (close the plan→execution gap) ──
  // Defect #4 fix: previously test-cases.md was only "simulated" by the LLM.
  // Now we convert the JSON plan into a real executable test script and run it.
  // The execution report is stored and later injected into TesterAgent's prompt
  // so the AI sees REAL pass/fail results instead of imagined ones.
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
        console.log(`[Orchestrator] 📊 Test case execution: ${tcExecutionReport.passed}/${tcExecutionReport.total} passed, ${tcExecutionReport.failed} failed, ${tcExecutionReport.blocked} blocked`);
        // Save execution report to output dir for traceability
        const execReportPath = path.join(PATHS.OUTPUT_DIR, 'test-execution-report.md');
        fs.writeFileSync(execReportPath, tcExecutionReport.summaryMd, 'utf-8');
        console.log(`[Orchestrator] 📝 Execution report saved → output/test-execution-report.md`);
        if (tcExecutionReport.failed > 0) {
          this.stateMachine.recordRisk('medium',
            `[TestCaseExecutor] ${tcExecutionReport.failed}/${tcExecutionReport.total} generated test case(s) failed real execution. See output/test-execution-report.md.`);
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

  const agentsMdForTest = this._agentsMdContent || '';
  if (agentsMdForTest) {
    console.log(`[Orchestrator] 📋 AGENTS.md injected into TesterAgent context.`);
  }

  const testExpContext = this.experienceStore.getContextBlock('test-report');
  console.log(`[Orchestrator] 📚 Experience context injected for TesterAgent (${testExpContext.length} chars)`);

  const testComplaints = this.complaintWall.getOpenComplaintsFor(ComplaintTarget.SKILL, 'test-report');
  const testComplaintBlock = testComplaints.length > 0
    ? `\n\n## Known Issues (Open Complaints)\n${testComplaints.map(c => `- [${c.severity}] ${c.description}`).join('\n')}`
    : '';

  // Inject real execution results into TesterAgent context (Defect #4 fix)
  // This replaces the previous approach where TesterAgent only "imagined" test results.
  // Now the agent sees actual PASS/FAIL/BLOCKED statuses from real script execution.
  const realExecutionBlock = tcExecutionReport && !tcExecutionReport.skipped
    ? `\n\n## ⚡ Real Test Execution Results (Pre-Run)\n> The following results come from ACTUALLY RUNNING the generated test script.\n> Use these as ground truth – do NOT contradict them in your report.\n\n${tcExecutionReport.summaryMd}`
    : '';
  if (realExecutionBlock) {
    console.log(`[Orchestrator] ⚡ Real execution results injected into TesterAgent context (${tcExecutionReport.total} cases).`);
  }

  const testExpContextWithComplaints = [
    agentsMdForTest ? `## Project Context (AGENTS.md)\n${agentsMdForTest}` : '',
    upstreamCtxForTest,
    testExpContext,
    testComplaintBlock,
    realExecutionBlock,
  ].filter(Boolean).join('\n\n');
  if (testComplaints.length > 0) {
    console.log(`[Orchestrator] ⚠️  ${testComplaints.length} open complaint(s) injected into TesterAgent context.`);
  }

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
      console.warn(`[Orchestrator] ⚠️  High-severity issues recorded as risks. Proceeding automatically.`);
      try {
        const defectDecision = await this.socratic.ask(DECISION_QUESTIONS.TEST_DEFECTS_ACTION);
        console.log(`[Orchestrator] 🤔 Defect handling decision: "${defectDecision.optionText}"`);
        this.stateMachine.recordRisk('low', `[SocraticEngine] Defect handling: ${defectDecision.optionText}`);
      } catch (err) {
      this.stateMachine.recordRisk('low', `[SocraticEngine] Defect handling decision skipped (engine unavailable): ${err.message}`);
      console.warn(`[Orchestrator] ⚠️  SocraticEngine defect decision skipped – proceeding automatically. Reason: ${err.message}`);
    }
      const testFailTitle = 'Test report: high-severity issues unresolved after self-correction';
      const failContent = `Unresolved high-severity signals after ${corrResult.rounds} self-correction round(s): ${riskMsg}`;
      if (!this.experienceStore.appendByTitle(testFailTitle, failContent)) {
        this.experienceStore.record({
          type: ExperienceType.NEGATIVE,
          category: ExperienceCategory.PITFALL,
          title: testFailTitle,
          content: failContent,
          skill: 'test-report',
          tags: ['test-report', 'failed', 'pitfall'],
        });
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
    await _runRealTestLoop.call(this, { testCommand, autoFixEnabled, maxFixRounds, failOnUnfixed, testReportPath: outputPath });
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

  return outputPath;
}

async function _runRealTestLoop({ testCommand, autoFixEnabled, maxFixRounds, failOnUnfixed, testReportPath }) {
  const runner = new TestRunner({
    projectRoot: this.projectRoot,
    testCommand,
    timeoutMs: 180_000,
    verbose: true,
  });

  console.log(`\n[Orchestrator] 🔬 Running real test suite: ${testCommand}`);
  let result = runner.run();

  const realResultMd = TestRunner.formatResultAsMarkdown(result);
  if (fs.existsSync(testReportPath)) {
    fs.appendFileSync(testReportPath, `\n\n---\n\n${realResultMd}`, 'utf-8');
  }

  if (result.passed) {
    console.log(`[Orchestrator] ✅ Real tests PASSED on first run.`);
    this.obs.recordTestResult({ passed: result.passed ? 1 : 0, failed: 0, skipped: 0, rounds: 1 });
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
  while (!result.passed && fixRound < maxFixRounds) {
    fixRound++;
    console.log(`\n[Orchestrator] 🔧 Auto-fix round ${fixRound}/${maxFixRounds}...`);

    const failureContext = TestRunner.formatResultAsMarkdown(result);
    const codeDiffPath = path.join(PATHS.OUTPUT_DIR, 'code.diff');
    const existingDiff = fs.existsSync(codeDiffPath) ? fs.readFileSync(codeDiffPath, 'utf-8') : '(no previous diff)';

    // Collect actual source files for Fix Agent context (not just the diff)
    // This resolves the "blind fix" problem where Fix Agent only saw code.diff
    // and had no visibility into the actual current state of source files.
    let sourceFilesContext = '';
    try {
      const sourceExts = (this._config.sourceExtensions || ['.js', '.ts', '.py', '.go', '.java', '.cs']);
      const ignoreDirs = new Set(this._config.ignoreDirs || ['node_modules', '.git', 'dist', 'build', 'output']);
      const sourceFiles = [];

      const collectFiles = (dir, depth = 0) => {
        if (depth > 4) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (ignoreDirs.has(entry.name)) continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            collectFiles(fullPath, depth + 1);
          } else if (sourceExts.some(ext => entry.name.endsWith(ext))) {
            sourceFiles.push(fullPath);
          }
        }
      };
      collectFiles(this.projectRoot);

      // Prioritise files mentioned in the failure output
      const failureText = result.output || result.failureSummary.join('\n');
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
          const snippet = content.length > 3000 ? content.slice(0, 3000) + '\n... (truncated)' : content;
          fileSnippets.push(`### ${rel}\n\`\`\`\n${snippet}\n\`\`\``);
          totalChars += snippet.length;
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
      `You are a **Code Fix Agent**. The project's test suite has failed.`,
      `Your task: produce REPLACE_IN_FILE blocks that fix ALL failing tests.`,
      ``,
      `## Previous Diff (for reference)`,
      `\`\`\`diff`,
      existingDiff.slice(0, 2000),
      `\`\`\``,
      ``,
      sourceFilesContext,
      ``,
      failureContext,
      ``,
      `## Output Format`,
      `For each file you need to change, output one or more blocks in this EXACT format:`,
      ``,
      `[REPLACE_IN_FILE]`,
      `file: relative/path/to/file.js`,
      `find: |`,
      `  <exact code to find, including indentation>`,
      `replace: |`,
      `  <new code to replace it with>`,
      `[/REPLACE_IN_FILE]`,
      ``,
      `## Rules`,
      `1. Analyse the failure output above and identify the root cause of each failing test.`,
      `2. Output ONLY [REPLACE_IN_FILE] blocks – no explanations, no markdown prose.`,
      `3. The "find:" block MUST be an exact substring of the current file (copy-paste it from the source above).`,
      `4. Only change what is necessary to fix the failures.`,
      `5. Do NOT change test files unless the test itself is clearly wrong.`,
      `6. File paths are relative to the project root: ${this.projectRoot}`,
    ].join('\n');

    console.log(`[Orchestrator] 🤖 Invoking Code Fix Agent for fix round ${fixRound}...`);
    let fixResponse;
    try {
      fixResponse = await this._rawLlmCall(fixPrompt);
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
      break;
    }

    console.log(`[Orchestrator] 🔬 Re-running tests after fix round ${fixRound}...`);
    result = runner.run();

    const roundMd = `\n\n---\n\n## Auto-Fix Round ${fixRound} Result\n\n` + TestRunner.formatResultAsMarkdown(result);
    if (fs.existsSync(testReportPath)) {
      fs.appendFileSync(testReportPath, roundMd, 'utf-8');
    }

    if (result.passed) {
      console.log(`[Orchestrator] ✅ Tests PASSED after fix round ${fixRound}.`);
      this.obs.recordTestResult({ passed: 1, failed: 0, skipped: 0, rounds: fixRound });
      this.experienceStore.record({
        type: ExperienceType.POSITIVE,
        category: ExperienceCategory.STABLE_PATTERN,
        title: `Real tests passed after ${fixRound} auto-fix round(s)`,
        content: `Tests passed after ${fixRound} fix round(s). Command: ${testCommand}. Failure summary: ${result.failureSummary.slice(0, 3).join('; ')}.`,
        skill: 'test-report',
        tags: ['real-test', 'auto-fix', 'passed'],
      });
      return;
    }

    console.warn(`[Orchestrator] ❌ Tests still failing after fix round ${fixRound}.`);
  }

  const failMsg = `[RealTest] Tests still failing after ${fixRound} auto-fix round(s). Exit code: ${result.exitCode}. Failures: ${result.failureSummary.slice(0, 3).join('; ')}`;
  this.stateMachine.recordRisk('high', failMsg);
  this.obs.recordTestResult({ passed: 0, failed: result.failureSummary.length || 1, skipped: 0, rounds: fixRound });
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
