/**
 * Stage Runner: TESTER
 *
 * Extracted from orchestrator-stages.js (P0 decomposition – ADR-33).
 * Contains: _runTester, _runTesterOnce, _runRealTestLoop
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { PATHS, HOOK_EVENTS } = require('./constants');
const { AgentRole, WorkflowState } = require('./types');
const { ExperienceType, ExperienceCategory } = require('./experience-store');
const { SelfCorrectionEngine, formatClarificationReport } = require('./clarification-engine');
const { TestRunner } = require('./test-runner');
const { TestCaseGenerator } = require('./test-case-generator');
const { TestCaseExecutor } = require('./test-case-executor');
const { DECISION_QUESTIONS } = require('./socratic-engine');
const { RollbackCoordinator } = require('./rollback-coordinator');
const { QualityGate } = require('./quality-gate');
const { translateMdFile } = require('./i18n-translator');
const { runEvoMapFeedback } = require('./stage-runner-utils');
const { scanSourceFiles } = require('./file-scanner');
const { _recordPromptABOutcome } = require('./stage-analyst');
const {
  buildTesterUpstreamCtx,
  buildTesterContextBlock,
  storeTestContext,
  webSearchHelper,
} = require('./orchestrator-stage-helpers');

// Forward reference: _runDeveloper is needed for rollback. Lazy-loaded to avoid circular deps.
let _runDeveloper = null;
function _getRunDeveloper() {
  if (!_runDeveloper) {
    _runDeveloper = require('./stage-developer')._runDeveloper;
  }
  return _runDeveloper;
}

async function _runTester() {
  const MAX_TEST_ITERATIONS = 2;
  let testIteration = 0;

  while (testIteration < MAX_TEST_ITERATIONS) {
    testIteration++;
    const fixConversationHistory = [];
    const iterResult = await _runTesterOnce.call(this, testIteration, MAX_TEST_ITERATIONS, fixConversationHistory);

    if (iterResult.__done) {
      return iterResult.outputPath;
    }

    if (iterResult.__alreadyTransitioned) {
      return iterResult;
    }

    console.log(`[Orchestrator] 🔄 Re-running TEST stage (iteration ${testIteration + 1}/${MAX_TEST_ITERATIONS}) after developer retry...`);
  }

  console.warn(`[Orchestrator] ⚠️  TEST stage iteration limit reached without resolution.`);
  return null;
}

async function _runTesterOnce(testIteration, maxIterations, fixConversationHistory) {
  console.log(`\n[Orchestrator] Stage: TEST (TesterAgent)${testIteration > 1 ? ` [iteration ${testIteration}/${maxIterations}]` : ''}`);
  const inputPath = this.bus.consume(AgentRole.TESTER);

  const upstreamCtxForTest = buildTesterUpstreamCtx(this);

  const devMeta = this.bus.getMeta(AgentRole.TESTER);
  if (devMeta && devMeta.reviewRounds > 0) {
    console.log(`[Orchestrator] ℹ️  Code was self-corrected in ${devMeta.reviewRounds} round(s) (${devMeta.failedItems} issue(s) fixed). Tester should pay attention to corrected areas.`);
  }

  // ── Step 0: Pre-generate test cases ──────────────────────────────────────
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

  // ── Step 0.5: Execute generated test cases ─────────────────────────────────
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
        const _manualPending = tcExecutionReport.manualPending ?? 0;
        const _automatedTotal = tcExecutionReport.automatedTotal ?? (tcExecutionReport.total - _manualPending);
        console.log(`[Orchestrator] 📊 Test case execution: ${tcExecutionReport.passed}/${_automatedTotal} passed, ${tcExecutionReport.failed} failed, ${tcExecutionReport.blocked} blocked, ${_manualPending} manual-pending`);
        const execReportPath = path.join(PATHS.OUTPUT_DIR, 'test-execution-report.md');
        fs.writeFileSync(execReportPath, tcExecutionReport.summaryMd, 'utf-8');
        console.log(`[Orchestrator] 📝 Execution report saved → output/test-execution-report.md`);
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

  const testExpContextWithComplaints = await buildTesterContextBlock(this, upstreamCtxForTest, tcExecutionReport);
  this.obs.recordExpUsage({ injected: (testExpContextWithComplaints._injectedExpIds || []).length });
  const outputPath = await this.agents[AgentRole.TESTER].run(inputPath, null, testExpContextWithComplaints);

  // ── Adapter Telemetry ─────────────────────────────────────────────────────
  if (this._adapterTelemetry && outputPath && fs.existsSync(outputPath)) {
    try {
      const testOutput = fs.readFileSync(outputPath, 'utf-8');
      this._adapterTelemetry.scanReferences(testOutput, 'TESTER');
    } catch (_) { /* non-fatal */ }
  }

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
        const defectDecision = this.socratic.askAsync(DECISION_QUESTIONS.TEST_DEFECTS_ACTION, 0);
        console.log(`[Orchestrator] ⚡ Defect handling decision (non-blocking): "${defectDecision.optionText}"`);
        this.stateMachine.recordRisk('low', `[SocraticEngine] Defect handling: ${defectDecision.optionText}`);
      } catch (err) {
        this.stateMachine.recordRisk('low', `[SocraticEngine] Defect handling decision skipped (engine unavailable): ${err.message}`);
        console.warn(`[Orchestrator] ⚠️  SocraticEngine defect decision skipped – proceeding automatically. Reason: ${err.message}`);
      }

      const testGate = new QualityGate({ experienceStore: this.experienceStore, maxRollbacks: 1 });
      const testRollbackCountForGate = this._rollbackCounters?.get(WorkflowState.TEST) ?? 0;
      const testGateInput = {
        failed: corrResult.signals.filter(s => s.severity === 'high').length,
        needsHumanReview: corrResult.needsHumanReview,
        total: corrResult.signals.length,
        rounds: corrResult.rounds,
        riskNotes: [riskMsg],
        history: corrResult.history || [],
      };
      const testDecision = testGate.evaluate(testGateInput, WorkflowState.TEST, testRollbackCountForGate);
      testGate.recordExperience(testDecision, WorkflowState.TEST, testGateInput, { skill: 'test-report', category: ExperienceCategory.PITFALL });

      _recordPromptABOutcome('tester', !testDecision.rollback, corrResult.rounds ?? 0);

      if (testDecision.rollback) {
        const testRollbackCount = this._rollbackCounters?.get(WorkflowState.TEST) ?? 0;
        if (this._rollbackCounters) this._rollbackCounters.set(WorkflowState.TEST, testRollbackCount + 1);
        if (!this._pendingTestMeta) this._pendingTestMeta = {};
        this._pendingTestMeta._testRollbackCount = testRollbackCount + 1;
        try {
          const coordinator = new RollbackCoordinator(this);
          await coordinator.rollback(WorkflowState.TEST, `Test report failed: ${riskMsg.slice(0, 200)}`);

          const codeDiffPath = path.join(PATHS.OUTPUT_DIR, 'code.diff');
          const failureNote = `\n\n---\n## ⚠️ Test Report Failure (Retry ${testRollbackCount + 1})\n\nThe previous implementation failed test report review with these issues:\n${riskMsg}\n\nPlease fix the implementation to address these test failures before the tester retries.`;
          if (fs.existsSync(codeDiffPath)) {
            fs.appendFileSync(codeDiffPath, failureNote, 'utf-8');
          }
          const archOutputPath = path.join(PATHS.OUTPUT_DIR, 'architecture.md');
          if (fs.existsSync(archOutputPath)) {
          this.bus.publish(AgentRole.ARCHITECT, AgentRole.PLANNER, archOutputPath, {
              testReportFailed: true,
              riskMsg,
              rollbackRetry: testRollbackCount + 1,
              reviewRounds: 1,
              failedItems: 1,
            });
          }
          const devStageLabel = 'TEST→CODE(rollback-retry)';
          this.obs.stageStart(devStageLabel);
          let devRetry;
          try {
            devRetry = await _getRunDeveloper().call(this);
            this.obs.stageEnd(devStageLabel, 'ok');
          } catch (devErr) {
            this.obs.stageEnd(devStageLabel, 'error');
            this.obs.recordError(devStageLabel, devErr.message);
            await this.hooks.emit(HOOK_EVENTS.WORKFLOW_ERROR, { error: devErr, state: 'TEST→CODE(rollback)' }).catch(() => {});
            throw devErr;
          }
          if (devRetry && typeof devRetry === 'object' && devRetry.__alreadyTransitioned) {
            return { __done: true, __alreadyTransitioned: true };
          }
          let devOutputPath;
          if (typeof devRetry === 'string') {
            devOutputPath = devRetry;
          } else {
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
          console.log(`[Orchestrator] 🔄 Signalling TEST stage retry (rollback round ${testRollbackCount + 1}) – iterative loop will continue...`);
          this._pendingTestMeta = null;
          return { __retry: true };
        } catch (rollbackErr) {
          console.warn(`[Orchestrator] Test rollback failed (non-fatal): ${rollbackErr.message}. Proceeding with risks recorded.`);
        }
      } else {
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

  translateMdFile(outputPath, this._rawLlmCall).catch(() => {});

  try {
    if (this.experienceStore && typeof this.experienceStore.flushDirty === 'function') {
      await this.experienceStore.flushDirty();
      console.log(`[Orchestrator] 💾 ExperienceStore flushed (hitCount increments persisted).`);
    }
  } catch (flushErr) {
    console.warn(`[Orchestrator] ⚠️  ExperienceStore flush failed (non-fatal): ${flushErr.message}`);
  }

  storeTestContext(this, outputPath, tcGenResult, tcExecutionReport, corrResult ?? null);

  return { __done: true, outputPath };
}

async function _runRealTestLoop({ testCommand, autoFixEnabled, maxFixRounds, failOnUnfixed, testReportPath, lintCommand = null, fixConversationHistory = null, injectedExpIds = [] }) {
  const fixHistory = fixConversationHistory || [];
  const runner = new TestRunner({
    projectRoot: this.projectRoot,
    testCommand,
    timeoutMs: 180_000,
    verbose: true,
  });

  console.log(`\n[Orchestrator] 🔬 Running real test suite: ${testCommand}`);
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

  while (!result.passed && fixRound < maxFixRounds) {
    fixRound++;
    console.log(`\n[Orchestrator] 🔧 Auto-fix round ${fixRound}/${maxFixRounds}...`);

    const _rawFailureContext = TestRunner.formatResultAsMarkdown(result);
    const failureContext = _rawFailureContext.length > 6000
      ? `... [${_rawFailureContext.length - 6000} chars omitted] ...\n` + _rawFailureContext.slice(-6000)
      : _rawFailureContext;
    const codeDiffPath = path.join(PATHS.OUTPUT_DIR, 'code.diff');
    const existingDiff = fs.existsSync(codeDiffPath) ? fs.readFileSync(codeDiffPath, 'utf-8') : '(no previous diff)';

    const previousFixesBlock = fixRound > 1
      ? `## Fix History\n> This is fix round ${fixRound}. Your previous fix attempt(s) are in the conversation history above.\n> Review what you tried before and why it did not fully resolve the failures.`
      : '';

    // Collect source files for Fix Agent context
    let sourceFilesContext = '';
    try {
      const sourceExts = (this._config.sourceExtensions || ['.js', '.ts', '.py', '.go', '.java', '.cs']);
      const ignoreDirs = this._config.ignoreDirs || ['node_modules', '.git', 'dist', 'build', 'output'];

      const sourceFiles = scanSourceFiles(this.projectRoot, {
        extensions: sourceExts,
        ignoreDirs,
        maxDepth: 4,
        skipDotFiles: true,
      });

      const failureText = result.output || (result.failureSummary || []).join('\n');
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

    // ── Web Search: search for error solutions ────────────────────────────
    let webSearchContext = '';
    try {
      if (this.services && this.services.has('mcpRegistry')) {
        const registry = this.services.resolve('mcpRegistry');
        const wsAdapter = registry.get('websearch');
        if (wsAdapter) {
          const rawOutput = result.output || (result.failureSummary || []).join('\n');
          const errorLines = rawOutput.split('\n')
            .filter(line => /\b(Error|TypeError|ReferenceError|SyntaxError|FAIL|AssertionError|Cannot find|Module not found|unexpected token|is not a function|is not defined|ENOENT|EACCES|ECONNREFUSED)/i.test(line))
            .map(line => line.trim())
            .filter(line => line.length > 10 && line.length < 300)
            .slice(0, 3);
          if (errorLines.length > 0) {
            const primaryError = errorLines[0]
              .replace(/\bat\s+.*$/i, '')
              .replace(/\(.*?\)/g, '')
              .replace(/['"]/g, '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 150);
            const searchQuery = `${primaryError} fix solution`;
            console.log(`[Orchestrator] 🌐 Auto-fix web search: "${searchQuery.slice(0, 80)}..."`);
            const searchResult = await wsAdapter.search(searchQuery, { maxResults: 3 });
            if (searchResult && searchResult.results && searchResult.results.length > 0) {
              const formatted = searchResult.results.map((r, i) =>
                `${i + 1}. **${r.title}**\n   URL: ${r.url}\n   ${(r.snippet || '').slice(0, 250)}`
              ).join('\n\n');
              webSearchContext = [
                `## 🌐 Web Research (Error Solutions)`,
                `> The following web search results may contain relevant fixes, workarounds, or explanations.`,
                `> **Evaluate critically** — apply only solutions that match the root cause you diagnosed above.`,
                ``,
                `**Search query**: "${primaryError}"`,
                `**Error lines found**:`,
                ...errorLines.map(l => `- \`${l.slice(0, 200)}\``),
                ``,
                `**Relevant solutions**:`,
                formatted,
              ].join('\n');
              console.log(`[Orchestrator] 🌐 Auto-fix web search: ${searchResult.results.length} result(s) injected (provider: ${searchResult.provider}).`);
            } else {
              console.log(`[Orchestrator] 🌐 Auto-fix web search: no results found.`);
            }
          }
        }
      }
    } catch (wsErr) {
      console.warn(`[Orchestrator] 🌐 Auto-fix web search failed (non-fatal): ${wsErr.message}`);
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
      webSearchContext,
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
      fixHistory.push({ role: 'user', content: fixPrompt });

      const llmInput = fixHistory.length > 1
        ? fixHistory
        : fixPrompt;

      fixResponse = await this._rawLlmCall(llmInput);

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
      fixRound--;
      break;
    }

    // ── Post-fix validation ─────────────────────────────────────────────────
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
      }
    }

    if (applyResult.modifiedFiles && applyResult.modifiedFiles.length > 0) {
      const testFilePattern = /\.(test|spec)\.[jt]s$|__tests__\//i;
      const modifiedTestFiles = applyResult.modifiedFiles.filter(f => testFilePattern.test(f));
      if (modifiedTestFiles.length > 0) {
        const warnMsg = `[RealTest] Fix round ${fixRound} modified test file(s): ${modifiedTestFiles.join(', ')}. This may indicate the fix is gaming the tests rather than fixing the code.`;
        console.warn(`[Orchestrator] ⚠️  ${warnMsg}`);
        this.stateMachine.recordRisk('medium', warnMsg);
      }
    }

    console.log(`[Orchestrator] 🔬 Re-running tests after fix round ${fixRound}...`);
    try {
      result = runner.run();
    } catch (rerunErr) {
      console.error(`[Orchestrator] ❌ Test runner threw an error in fix round ${fixRound}: ${rerunErr.message}`);
      this.stateMachine.recordRisk('high', `[RealTest] Test runner crashed in fix round ${fixRound}: ${rerunErr.message}`);
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

      // Re-annotate test-cases.md with post-fix PASS statuses
      try {
        const tcExecutorForUpdate = new TestCaseExecutor({
          projectRoot: this.projectRoot,
          testCommand,
          outputDir: PATHS.OUTPUT_DIR,
          verbose: false,
        });
        const cases = tcExecutorForUpdate._parseCasesFromMd();
        if (cases.length > 0) {
          const updatedResults = cases.map(tc => ({
            ...tc,
            _executionStatus: 'PASS',
            _executionOutput: `Passed after auto-fix round ${fixRound}`,
          }));
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

module.exports = { _runTester, _runRealTestLoop };
