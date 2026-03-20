/**
 * Orchestrator Task – Task-based parallel execution methods
 *
 * Extracted from index.js to reduce the Orchestrator class size.
 * These methods are mixed into Orchestrator.prototype via Object.assign.
 *
 * Contains:
 *   - runTaskBased()              – main task-based entry point
 *   - _runAgentWorker()           – single agent worker loop
 *   - _executeTask()              – task execution with role inference
 *   - _evaluateReplan()           – dynamic re-planning after task completion
 *   - _validateDecomposition()    – task decomposition quality validation
 *   - _checkCrossTaskCoherence()  – cross-task output coherence check
 *   - _checkRequirementCoverage() – requirement coverage traceability
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS, HOOK_EVENTS } = require('./constants');
const { AgentRole, WorkflowState } = require('./types');
const { ExperienceType, ExperienceCategory } = require('./experience-store');
const { buildAgentPrompt } = require('./prompt-builder');
// B-fix: import stage runners + context builders so task-based mode can reuse
// the same ANALYSE/ARCHITECT stages and per-task context injection as sequential mode.
const { _runAnalyst, _runArchitect } = require('./orchestrator-stages');
const {
  buildDeveloperContextBlock,
  buildTesterContextBlock,
  buildDeveloperUpstreamCtx,
  buildTesterUpstreamCtx,
} = require('./orchestrator-stage-helpers');
const { CodeReviewAgent } = require('./code-review-agent');
const { ArchitectureReviewAgent } = require('./architecture-review-agent');

// ─── Module-level helpers ─────────────────────────────────────────────────────

/**
 * D2 optimisation: maps AgentRole → WorkflowState for getRelevant() context selection.
 */
function _roleToStageForTask(role) {
  // R1-3 audit: removed redundant require('./types') – WorkflowState is already
  // imported at the top of orchestrator-task.js via the AgentRole/WorkflowState import.
  const map = {
    [AgentRole.ANALYST]:   WorkflowState.ANALYSE,
    [AgentRole.ARCHITECT]: WorkflowState.ARCHITECT,
    [AgentRole.DEVELOPER]: WorkflowState.CODE,
    [AgentRole.TESTER]:    WorkflowState.TEST,
  };
  return map[role] || null;
}

module.exports = {

  /**
   * Runs a goal using AgentFlow-style task decomposition and parallel execution.
   *
   * @param {string} goal - High-level goal description
   * @param {object[]} taskDefs - Array of task definitions with deps
   * @param {number} [concurrency=3] - Max parallel agents
   */
  async runTaskBased(goal, taskDefs, concurrency = 3) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  AgentFlow Task-Based Execution`);
    console.log(`  Goal: ${goal}`);
    console.log(`  Tasks: ${taskDefs.length} | Concurrency: ${concurrency}`);
    console.log(`${'='.repeat(60)}\n`);

    // Store current requirement/goal so cross-task checks can reference it
    this._currentRequirement = goal;

    // 1–3. Shared startup
    const resumeState = await this._initWorkflow();
    console.log(`[Orchestrator] Task-based mode resume state: ${resumeState} (reserved for future checkpoint-resume support).`);

    // ════════════════════════════════════════════════════════════════════════════
    // B-fix: ANALYSE + ARCHITECT stages BEFORE parallel task execution.
    //
    // PROBLEM: The original runTaskBased() completely skipped requirement analysis
    // and architecture design. Tasks were executed by _rawLlmCall with zero adapter
    // context, zero context builder, zero self-correction, and zero document output.
    // This produced dramatically lower quality than the sequential run() pipeline.
    //
    // FIX: Run the SAME _runAnalyst and _runArchitect functions used by sequential
    // run(). This produces requirements.md + architecture.md with full adapter
    // context (11 plugins), self-correction loops, quality gates, and rollback.
    // Tasks then execute WITH these documents as upstream context.
    // ════════════════════════════════════════════════════════════════════════════
    console.log(`\n[Orchestrator] ════ Phase 1: Requirement Analysis & Architecture Design ════`);
    console.log(`[Orchestrator] Running ANALYSE + ARCHITECT stages before task decomposition...\n`);

    this.obs.stageStart('task-based:ANALYSE');
    let analyseResult;
    try {
      analyseResult = await _runAnalyst.call(this, goal);
      this.obs.stageEnd('task-based:ANALYSE', 'ok');
      console.log(`[Orchestrator] ✅ ANALYSE stage complete → requirements.md produced.`);
      // Stage Output Report: transparent artifact summary
      try {
        const { reportStageOutput } = require('./stage-output-reporter');
        reportStageOutput('ANALYSE', PATHS.OUTPUT_DIR, { artifactPath: typeof analyseResult === 'string' ? analyseResult : undefined });
      } catch (_) { /* non-fatal */ }
    } catch (err) {
      this.obs.stageEnd('task-based:ANALYSE', 'error');
      this.obs.recordError('task-based:ANALYSE', err.message);
      console.error(`[Orchestrator] ❌ ANALYSE stage failed: ${err.message}`);
      throw err;
    }

    // Advance state machine: INIT → ANALYSE
    if (analyseResult && !(analyseResult && analyseResult.__alreadyTransitioned)) {
      await this.stateMachine.transition(analyseResult, 'Task-based: INIT → ANALYSE');
    }

    this.obs.stageStart('task-based:ARCHITECT');
    let architectResult;
    try {
      architectResult = await _runArchitect.call(this);
      this.obs.stageEnd('task-based:ARCHITECT', 'ok');
      console.log(`[Orchestrator] ✅ ARCHITECT stage complete → architecture.md produced.`);
      // Stage Output Report: transparent artifact summary
      try {
        const { reportStageOutput } = require('./stage-output-reporter');
        reportStageOutput('ARCHITECT', PATHS.OUTPUT_DIR, { artifactPath: typeof architectResult === 'string' ? architectResult : undefined });
      } catch (_) { /* non-fatal */ }
    } catch (err) {
      this.obs.stageEnd('task-based:ARCHITECT', 'error');
      this.obs.recordError('task-based:ARCHITECT', err.message);
      console.error(`[Orchestrator] ❌ ARCHITECT stage failed: ${err.message}`);
      throw err;
    }

    // Advance state machine: ANALYSE → ARCHITECT
    if (architectResult && !(architectResult && architectResult.__alreadyTransitioned)) {
      await this.stateMachine.transition(architectResult, 'Task-based: ANALYSE → ARCHITECT');
    }

    console.log(`\n[Orchestrator] ════ Phase 2: Task-Based Parallel Execution ════\n`);

    // Register all tasks
    for (const def of taskDefs) {
      this.taskManager.addTask(def);
    }

    const tbAdaptive = this._adaptiveStrategy;

    // Run parallel agent workers
    const workers = Array.from({ length: concurrency }, (_, i) =>
      this._runAgentWorker(`agent-${i + 1}`)
    );

    try {
      this.obs.stageStart('task-based-execution');
      await Promise.all(workers);
      this.obs.stageEnd('task-based-execution', 'ok');
    } catch (err) {
      this.obs.stageEnd('task-based-execution', 'error');
      this.obs.recordError('task-based-execution', err.message);
      await this.hooks.emit(HOOK_EVENTS.WORKFLOW_ERROR, { error: err, state: 'task-based' });
      throw err;
    }

    // ── EntropyGC: scan after all tasks complete ────────────────────────────
    if (tbAdaptive.skipEntropyOnClean) {
      console.log(`[Orchestrator] ⏭️  Entropy scan skipped (adaptive strategy – recent sessions clean).`);
    } else {
      try {
        console.log(`\n[Orchestrator] 🔍 Running entropy scan after task-based execution...`);
        const gcResult = await this.entropyGC.run();
        this.obs.recordEntropyResult(gcResult);
        if (gcResult.violations > 0) {
          console.warn(`[Orchestrator] ⚠️  EntropyGC: ${gcResult.violations} violation(s) found.`);
        } else {
          console.log(`[Orchestrator] ✅ Entropy scan: no violations found.`);
        }
      } catch (err) {
        console.warn(`[Orchestrator] EntropyGC scan failed (non-fatal): ${err.message}`);
      }
    }

    // ── CodeGraph: full rebuild after all tasks complete ─────────────────────
    try {
      console.log(`[Orchestrator] 🗺️  Rebuilding code graph after task-based execution...`);
      const graphResult = await this.codeGraph.build();
      this.obs.recordCodeGraphResult(graphResult);
      console.log(`[Orchestrator] ✅ Code graph built: ${graphResult.symbolCount} symbols, ${graphResult.edgeCount} edges`);
    } catch (err) {
      console.warn(`[Orchestrator] CodeGraph build failed (non-fatal): ${err.message}`);
    }

    // ── CIIntegration: local pipeline validation ─────────────────────────────
    try {
      console.log(`[Orchestrator] 🚀 Running CI pipeline validation (post task-based execution)...`);
      await this.hooks.emit(HOOK_EVENTS.CI_PIPELINE_STARTED, { command: this._config.testCommand || null });
      const ciResult = await this.ci.runLocalPipeline({
        skipEntropy: tbAdaptive.skipEntropyOnClean,
      });
      this.obs.recordCIResult(ciResult);
      if (ciResult.status === 'success') {
        console.log(`[Orchestrator] ✅ CI pipeline passed: ${ciResult.message}`);
        await this.hooks.emit(HOOK_EVENTS.CI_PIPELINE_COMPLETE, { result: ciResult });
      } else {
        console.warn(`[Orchestrator] ⚠️  CI pipeline ${ciResult.status}: ${ciResult.message}`);
        await this.hooks.emit(HOOK_EVENTS.CI_PIPELINE_FAILED, { result: ciResult });
      }
    } catch (err) {
      console.warn(`[Orchestrator] CI pipeline validation failed (non-fatal): ${err.message}`);
    }

    // ── Enhancement 2: Cross-Task Output Coherence Check ─────────────────────
    try {
      await this._checkCrossTaskCoherence(goal);
    } catch (err) {
      console.warn(`[Orchestrator] ⚠️  Cross-task coherence check failed (non-fatal): ${err.message}`);
    }

    // ── Enhancement 3: Requirement Coverage Traceability ──────────────────────
    try {
      this._checkRequirementCoverage(goal);
    } catch (err) {
      console.warn(`[Orchestrator] ⚠️  Requirement coverage check failed (non-fatal): ${err.message}`);
    }

    // Print task-based specific summary before shared teardown
    const summary = this.taskManager.getSummary();
    const expStats = this.experienceStore.getStats();
    const skillStats = this.skillEvolution.getStats();
    const complaintStats = this.complaintWall.getStats();

    console.log(`\n${'='.repeat(60)}`);
    console.log(`  AgentFlow Execution Complete`);
    console.log(`  Tasks: ${summary.byStatus.done || 0} done / ${summary.byStatus.failed || 0} failed / ${summary.total} total`);
    console.log(`  Experiences: ${expStats.positive} positive / ${expStats.negative} negative`);
    console.log(`  Skill evolutions: ${skillStats.totalEvolutions}`);
    console.log(`  Complaints: ${complaintStats.open} open / ${complaintStats.total} total`);
    console.log(`${'='.repeat(60)}\n`);

    // Shared teardown
    await this._finalizeWorkflow('task-based', { taskCount: taskDefs.length, goal });
  },

  /**
   * A single agent worker that continuously claims and executes tasks.
   *
   * @param {string} agentId
   */
  async _runAgentWorker(agentId) {
    console.log(`[AgentWorker:${agentId}] Started`);
    let idleCount = 0;
    let waitingForRunningCount = 0;
    const MAX_IDLE = 8;

    while (idleCount < MAX_IDLE) {
      const summary = this.taskManager.getSummary();
      const nonFailedActive = ['pending', 'running', 'blocked', 'interrupted']
        .some(s => (summary.byStatus[s] || 0) > 0);
      const failedCount = summary.byStatus['failed'] || 0;
      let hasRetryableNow = false;
      if (!nonFailedActive && failedCount > 0 && typeof this.taskManager.getRetryableTasks === 'function') {
        hasRetryableNow = this.taskManager.getRetryableTasks().length > 0;
      }
      const hasActive = nonFailedActive || hasRetryableNow || (failedCount > 0 && typeof this.taskManager.getRetryableTasks !== 'function');
      if (!hasActive) break;

      const task = this.taskManager.claimNextTask(agentId);
      if (!task) {
        const freshSummary = this.taskManager.getSummary();
        const hasRunning = (freshSummary.byStatus['running'] || 0) > 0;

        // P0-2 fix: if all failed tasks are in backoff, wait for nearest retry
        const freshFailedCount = freshSummary.byStatus['failed'] || 0;
        const freshNonFailedActive = ['pending', 'running', 'blocked', 'interrupted']
          .some(s => (freshSummary.byStatus[s] || 0) > 0);
        if (!hasRunning && !freshNonFailedActive && freshFailedCount > 0 &&
            typeof this.taskManager.getRetryableTasks === 'function' &&
            this.taskManager.getRetryableTasks().length === 0) {
          const allTasks = this.taskManager.getAllTasks();
          const failedInBackoff = allTasks.filter(t => t.status === 'failed' && t.nextRetryAt);
          if (failedInBackoff.length > 0) {
            const nearestRetryMs = Math.min(...failedInBackoff.map(t => new Date(t.nextRetryAt).getTime()));
            const waitUntilRetry = Math.max(500, nearestRetryMs - Date.now());
            const cappedWait = Math.min(waitUntilRetry, 10000);
            console.log(`[AgentWorker:${agentId}] All failed tasks in backoff. Waiting ${cappedWait}ms for nearest retry...`);
            await new Promise(r => setTimeout(r, cappedWait));
            continue;
          }
        }

        if (!hasRunning) {
          idleCount++;
        }

        if (hasRunning) {
          waitingForRunningCount = (waitingForRunningCount || 0) + 1;
        } else {
          waitingForRunningCount = 0;
        }
        const waitMs = hasRunning
          ? Math.min(500 * waitingForRunningCount, 5000)
          : Math.min(1000 * Math.pow(2, idleCount - 1), 10000);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      idleCount = 0;
      waitingForRunningCount = 0;

      await this.hooks.emit(HOOK_EVENTS.TASK_CLAIMED, { agentId, taskId: task.id });

      // Set current agent ID for optimistic lock tracking in _applyFileReplacements
      this._currentAgentId = agentId;

      try {
        let skillContent = '';
        if (task.skill) {
          skillContent = this.skillEvolution.readSkill(task.skill) || '';
        }

        const expContext = await this.experienceStore.getContextBlock(task.skill || null);

        console.log(`[AgentWorker:${agentId}] Executing task: ${task.id} – "${task.title}"`);
        const taskTimeoutMs = (this._config && this._config.taskTimeoutMs) || 5 * 60 * 1000;
        const taskTimeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Task execution timed out after ${taskTimeoutMs}ms`)), taskTimeoutMs)
        );
        const result = await Promise.race([
          this._executeTask(task, expContext, skillContent),
          taskTimeoutPromise,
        ]);

        const verificationNote = (result && result.summary)
          ? `Task executed by ${agentId}. Output: ${String(result.summary).slice(0, 120)}`
          : `Task executed by ${agentId} (no output summary).`;
        this.taskManager.completeTask(task.id, result, verificationNote);
        await this.hooks.emit(HOOK_EVENTS.TASK_COMPLETED, { agentId, taskId: task.id, result });

        // Dynamic re-planning
        await this._evaluateReplan(task, result, agentId).catch(err => {
          console.warn(`[AgentWorker:${agentId}] Re-planning evaluation failed (non-fatal): ${err.message}`);
        });

        // Record positive experience
        if (result && result.experience) {
          const expTitle = result.experience.title || `Task ${task.id} solution`;
          const exp = await this.experienceStore.recordIfAbsent(expTitle, {
            type: ExperienceType.POSITIVE,
            category: result.experience.category || ExperienceCategory.STABLE_PATTERN,
            title: expTitle,
            content: result.experience.content || result.summary || '',
            taskId: task.id,
            skill: task.skill,
            tags: result.experience.tags || [],
            codeExample: result.experience.codeExample || null,
          });
        }

      } catch (err) {
        console.error(`[AgentWorker:${agentId}] Task failed: ${task.id} – ${err.message}`);
        const isTimeout = err.message.includes('timed out after');
        if (isTimeout && typeof this.taskManager.exhaustTask === 'function') {
          this.taskManager.exhaustTask(task.id, err.message);
          console.warn(`[AgentWorker:${agentId}] Task ${task.id} timed out – marked as exhausted (no retry).`);
        } else {
          this.taskManager.failTask(task.id, err.message);
        }
        await this.hooks.emit(HOOK_EVENTS.TASK_FAILED, { agentId, taskId: task.id, error: err.message });

        this.stateMachine.recordRisk('high', `[TaskFailed:${task.id}] ${err.message}`);

        const negTitle = `Task failure: ${(task.title ?? 'unknown').slice(0, 50)}`;
        const negContent = `Task "${task.title}" failed with: ${err.message}`;
        const appended = await this.experienceStore.appendByTitle(negTitle, negContent);
        if (!appended) {
          await this.experienceStore.record({
            type: ExperienceType.NEGATIVE,
            category: ExperienceCategory.PITFALL,
            title: negTitle,
            content: negContent,
            taskId: task.id,
            skill: task.skill,
            tags: ['failure', 'pitfall'],
          });
        }
      }
    }

    console.log(`[AgentWorker:${agentId}] No more tasks. Worker exiting.`);
  },

  /**
   * Executes a single task using the appropriate agent, context builder,
   * and self-correction loop — matching sequential run() quality.
   *
   * B-fix: COMPLETELY REWRITTEN to address 8 critical deficiencies:
   *   1. ✅ Uses context builders (adapter plugins, token budget, compression)
   *   2. ✅ Uses agent.run() instead of _rawLlmCall (structured output, JSON instruction)
   *   3. ✅ Full self-correction / review loops (CodeReviewAgent, ArchitectureReviewAgent)
   *   4. ✅ Upstream context from ANALYSE + ARCHITECT documents
   *   5. ✅ Adapter Telemetry and BlockCompressor integration
   *   6. ✅ SmartContext filtering (skip irrelevant adapters)
   *   7. ✅ Token Budget Guard with priority-based truncation
   *   8. ✅ Writes output to proper artifact files (not just in-memory strings)
   *
   * @param {Task} task
   * @param {string} expContext
   * @param {string} skillContent
   * @returns {object} result
   */
  async _executeTask(task, expContext, skillContent) {
    // ── Role Inference ──────────────────────────────────────────────────────
    let role = AgentRole.DEVELOPER;
    if (task.agentRole && this.agents[task.agentRole]) {
      role = task.agentRole;
    } else {
      const hint = `${task.title ?? ''} ${task.description ?? ''}`.toLowerCase();
      if (/\b(analys[ei]s|requirement|clarif|research|investig|survey|feasib)/i.test(hint)) {
        role = AgentRole.ANALYST;
      } else if (/\b(architect|design|schema|diagram|structure|module|component|interface|api\s+design)/i.test(hint)) {
        role = AgentRole.ARCHITECT;
      } else if (/\b(test|spec|qa|quality|coverage|assert|verif|validat)/i.test(hint)) {
        role = AgentRole.TESTER;
      }
      if (role !== AgentRole.DEVELOPER) {
        console.log(`[Orchestrator] 🤖 Auto-inferred agent role "${role}" for task "${task.id}" based on title/description keywords.`);
      }
    }

    // ── Prepare task-specific context ───────────────────────────────────────
    const agentsMdContent = this._agentsMdContent ?? '';

    // Cross-stage context injection (includes ANALYSE + ARCHITECT output summaries)
    let crossStageCtx = '';
    if (this.stageCtx) {
      const currentStage = _roleToStageForTask(role);
      const taskHints = `${task.title ?? ''} ${task.description ?? ''}`;
      crossStageCtx = currentStage
        ? this.stageCtx.getRelevant(currentStage, { taskHints, maxChars: 1500 })
        : this.stageCtx.getAll([], 1500);
    }

    // CodeGraph: on-demand symbol lookup
    let codeGraphContext = '';
    if (role === AgentRole.DEVELOPER || role === AgentRole.ARCHITECT) {
      try {
        const taskHint = `${task.title ?? ''} ${task.description ?? ''}`;
        // R1-1 audit: extended regex to capture both PascalCase and camelCase identifiers
        // (previously only PascalCase was matched, missing most JS function names).
        // Also filter common English words and prefer code-like identifiers.
        const COMMON_WORDS = new Set([
          'This', 'That', 'These', 'Those', 'With', 'From', 'Should', 'Would', 'Could',
          'When', 'Where', 'What', 'Which', 'Each', 'Every', 'Some', 'None', 'Only',
          'Before', 'After', 'Between', 'During', 'About', 'Below', 'Above', 'Under',
          'Must', 'Also', 'Will', 'Shall', 'Note', 'Make', 'Uses', 'Used', 'Using',
        ]);
        const identifiers = [...new Set(
          (taskHint.match(/\b[A-Za-z][a-zA-Z0-9_]{3,}\b/g) || [])
            .filter(id => id.length >= 4 && id.length <= 40)
            .filter(id => !COMMON_WORDS.has(id))
            .filter(id => /[a-z][A-Z]|[A-Z][a-z]|_/.test(id))
            .slice(0, 20)
        )];
        if (identifiers.length > 0) {
          const graphMd = this.codeGraph.querySymbolsAsMarkdown(identifiers);
          if (graphMd && !graphMd.includes('_Code graph not available') && !graphMd.includes('_No matching')) {
            codeGraphContext = graphMd;
            console.log(`[Orchestrator] 🗺️  Code graph: queried ${identifiers.length} symbol(s) for task "${task.id}"`);
          } else {
            // P1: Fallback to semantic search — if exact symbol lookup found nothing,
            // use the full task hint as a natural-language search query to leverage
            // the inverted token index + TF-IDF scoring.
            const searchQuery = taskHint.slice(0, 120);
            const searchResults = this.codeGraph.search(searchQuery, { limit: 5 });
            if (searchResults.length > 0) {
              const searchNames = searchResults.map(s => s.name);
              const fallbackMd = this.codeGraph.querySymbolsAsMarkdown(searchNames);
              if (fallbackMd && !fallbackMd.includes('_No matching')) {
                codeGraphContext = fallbackMd;
                console.log(`[Orchestrator] 🗺️  Code graph (semantic fallback): found ${searchResults.length} symbol(s) for task "${task.id}"`);
              }
            }
          }
        }
      } catch (err) {
        console.warn(`[Orchestrator] Code graph query failed for task "${task.id}" (non-fatal): ${err.message}`);
      }
    }

    // Goal-Aware Execution
    const globalGoal = this._currentRequirement || '';
    const goalContext = globalGoal
      ? `## Global Goal\nThis task is part of a larger objective: ${globalGoal.slice(0, 300)}${globalGoal.length > 300 ? '...' : ''}\nEnsure your output aligns with and contributes to this overall goal.`
      : '';

    // Task-specific instruction block
    const taskBlock = [
      `## Task Assignment`,
      `**Task ID**: ${task.id}`,
      `**Title**: ${task.title}`,
      `**Description**:`,
      task.description,
      task.deps && task.deps.length > 0 ? `**Dependencies**: ${task.deps.join(', ')}` : '',
    ].filter(Boolean).join('\n');

    // ══════════════════════════════════════════════════════════════════════════
    // B-fix: CONTEXT BUILDER INTEGRATION
    //
    // Instead of manually splicing a flat prompt string, we now build labelled
    // context blocks through the SAME context builder pipeline used by sequential
    // run(). This provides:
    //   - Full adapter plugin blocks (Security CVE, Package Registry, Code Quality, etc.)
    //   - Token budget guard with priority-based truncation
    //   - Block compression (Markdown → JSON shorthand)
    //   - Adapter telemetry tracking (injection/truncation/drop/reference)
    //   - SmartContext filtering (skip irrelevant adapters)
    // ══════════════════════════════════════════════════════════════════════════

    let output = '';
    let reviewRiskNotes = [];
    const uid = require('crypto').randomUUID().slice(0, 8);

    if (role === AgentRole.DEVELOPER) {
      // ── DEVELOPER task: use full developer context builder pipeline ──────
      try {
        // Build upstream context (includes architecture.md, requirements.md, etc.)
        const upstreamCtx = buildDeveloperUpstreamCtx(this);

        // Build full developer context block with adapter plugins
        const devCtxBlock = await buildDeveloperContextBlock(this, upstreamCtx);
        // Inject task-specific context into the assembled prompt
        const assembledCtx = devCtxBlock.assembled || devCtxBlock;
        const taskSpecificInput = [
          goalContext,
          typeof assembledCtx === 'string' ? assembledCtx : '',
          skillContent ? `## Skill Context\n${skillContent}` : '',
          codeGraphContext ? `## Code Graph Context\n${codeGraphContext}` : '',
          taskBlock,
        ].filter(Boolean).join('\n\n');

        // Write to temp file as agent input
        const tmpInputPath = path.join(PATHS.OUTPUT_DIR, `task-${task.id}-${uid}-input.md`);
        fs.writeFileSync(tmpInputPath, taskSpecificInput, 'utf-8');

        // Use agent.run() — structured output with JSON instruction, proper parsing
        const outputPath = await this.agents[AgentRole.DEVELOPER].run(tmpInputPath, null, devCtxBlock);
        output = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8') : '';

        // Adapter Telemetry: scan LLM output for block references
        if (this._adapterTelemetry && output) {
          this._adapterTelemetry.scanReferences(output, 'DEVELOPER');
        }

        // Self-correction: CodeReviewAgent review (same as sequential _runDeveloper)
        if (output && output.length > 200) {
          try {
            const reviewer = new CodeReviewAgent(this._rawLlmCall, {
              maxRounds: 1,
              verbose: false,
              outputDir: PATHS.OUTPUT_DIR,
            });
            const reviewResult = await reviewer.review(outputPath, null);
            reviewRiskNotes = reviewResult.riskNotes || [];
            if (reviewRiskNotes.length > 0) {
              console.warn(`[Orchestrator] ⚠️  Code review (task ${task.id}): ${reviewRiskNotes.length} issue(s) found.`);
              for (const note of reviewRiskNotes) {
                this.stateMachine.recordRisk(note.includes('(high)') ? 'high' : 'medium', `[TaskCode:${task.id}] ${note}`, false);
              }
              this.stateMachine.flushRisks();
            }
          } catch (revErr) {
            console.warn(`[Orchestrator] Code review for task "${task.id}" failed (non-fatal): ${revErr.message}`);
          }
        }

        // Apply file replacements from the developer output
        if (output) {
          const applyResult = this._applyFileReplacements(output);
          if (applyResult.applied > 0) {
            console.log(`[Orchestrator] 🔧 Task ${task.id}: Applied ${applyResult.applied} replacement(s).`);
          }
        }

        // Clean up temp input file
        try { fs.unlinkSync(tmpInputPath); } catch { /* ignore */ }

      } catch (ctxErr) {
        console.warn(`[Orchestrator] Developer context builder failed for task "${task.id}" (non-fatal, falling back to buildAgentPrompt): ${ctxErr.message}`);
        // Fallback: use buildAgentPrompt (still better than raw _rawLlmCall)
        output = await this._executeTaskFallback(task, expContext, skillContent, role, goalContext, agentsMdContent, crossStageCtx, codeGraphContext, taskBlock);
      }

    } else if (role === AgentRole.TESTER) {
      // ── TESTER task: use full tester context builder pipeline ────────────
      try {
        const upstreamCtx = buildTesterUpstreamCtx(this);
        const testCtxBlock = await buildTesterContextBlock(this, upstreamCtx, null /* no tcExecutionReport in task mode */);
        const assembledCtx = testCtxBlock.assembled || testCtxBlock;
        const taskSpecificInput = [
          goalContext,
          typeof assembledCtx === 'string' ? assembledCtx : '',
          skillContent ? `## Skill Context\n${skillContent}` : '',
          taskBlock,
        ].filter(Boolean).join('\n\n');

        const tmpInputPath = path.join(PATHS.OUTPUT_DIR, `task-${task.id}-${uid}-input.md`);
        fs.writeFileSync(tmpInputPath, taskSpecificInput, 'utf-8');

        const outputPath = await this.agents[AgentRole.TESTER].run(tmpInputPath, null, testCtxBlock);
        output = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8') : '';

        if (this._adapterTelemetry && output) {
          this._adapterTelemetry.scanReferences(output, 'TESTER');
        }

        try { fs.unlinkSync(tmpInputPath); } catch { /* ignore */ }
      } catch (ctxErr) {
        console.warn(`[Orchestrator] Tester context builder failed for task "${task.id}" (non-fatal, falling back): ${ctxErr.message}`);
        output = await this._executeTaskFallback(task, expContext, skillContent, role, goalContext, agentsMdContent, crossStageCtx, codeGraphContext, taskBlock);
      }

    } else if (role === AgentRole.ARCHITECT) {
      // ── ARCHITECT task: use buildAgentPrompt + ArchitectureReviewAgent ───
      // Note: The main architecture is already done in Phase 1. Task-level
      // ARCHITECT roles handle sub-architecture decisions (schema design, etc.)
      try {
        const dynamicInput = [
          goalContext,
          skillContent    ? `## Skill Context\n${skillContent}` : '',
          expContext      ? `## Experience Context\n${expContext}` : '',
          agentsMdContent ? `## Project Context (AGENTS.md)\n${agentsMdContent}` : '',
          crossStageCtx   ? crossStageCtx : '',
          codeGraphContext ? `## Code Graph Context\n${codeGraphContext}` : '',
          taskBlock,
        ].filter(Boolean).join('\n\n');

        const tmpInputPath = path.join(PATHS.OUTPUT_DIR, `task-${task.id}-${uid}-input.md`);
        fs.writeFileSync(tmpInputPath, dynamicInput, 'utf-8');

        const outputPath = await this.agents[AgentRole.ARCHITECT].run(tmpInputPath, null);
        output = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8') : '';

        if (this._adapterTelemetry && output) {
          this._adapterTelemetry.scanReferences(output, 'ARCHITECT');
        }

        // Self-correction: ArchitectureReviewAgent
        if (output && output.length > 200) {
          try {
            const reviewer = new ArchitectureReviewAgent(this._rawLlmCall, {
              maxRounds: 1,
              verbose: false,
              outputDir: PATHS.OUTPUT_DIR,
            });
            const reviewResult = await reviewer.review(outputPath, null);
            reviewRiskNotes = reviewResult.riskNotes || [];
            if (reviewRiskNotes.length > 0) {
              console.warn(`[Orchestrator] ⚠️  Arch review (task ${task.id}): ${reviewRiskNotes.length} issue(s) found.`);
              for (const note of reviewRiskNotes) {
                this.stateMachine.recordRisk(note.includes('(high)') ? 'high' : 'medium', `[TaskArch:${task.id}] ${note}`, false);
              }
              this.stateMachine.flushRisks();
            }
          } catch (revErr) {
            console.warn(`[Orchestrator] Arch review for task "${task.id}" failed (non-fatal): ${revErr.message}`);
          }
        }

        try { fs.unlinkSync(tmpInputPath); } catch { /* ignore */ }
      } catch (ctxErr) {
        console.warn(`[Orchestrator] Architect execution failed for task "${task.id}" (non-fatal, falling back): ${ctxErr.message}`);
        output = await this._executeTaskFallback(task, expContext, skillContent, role, goalContext, agentsMdContent, crossStageCtx, codeGraphContext, taskBlock);
      }

    } else {
      // ── ANALYST task (rare in task-based mode — main analysis done in Phase 1)
      output = await this._executeTaskFallback(task, expContext, skillContent, role, goalContext, agentsMdContent, crossStageCtx, codeGraphContext, taskBlock);
    }

    const experience = {
      title: `Task completed: ${(task.title ?? 'unknown').slice(0, 60)}`,
      content: `Task "${task.title}" completed successfully. Output summary: ${(output ?? '').slice(0, 300)}`,
      category: role === AgentRole.ARCHITECT ? ExperienceCategory.ARCHITECTURE
               : role === AgentRole.TESTER   ? ExperienceCategory.DEBUG_TECHNIQUE
               : ExperienceCategory.STABLE_PATTERN,
      tags: [role.toLowerCase(), 'task-based', 'completed'],
      codeExample: null,
    };

    return { summary: output, raw: output, experience, reviewRiskNotes };
  },

  /**
   * Fallback task execution using buildAgentPrompt + _rawLlmCall.
   * Used when context builder fails or for ANALYST role tasks.
   * Still significantly better than the old bare _rawLlmCall approach
   * because it uses buildAgentPrompt for structured output formatting.
   *
   * @private
   */
  async _executeTaskFallback(task, expContext, skillContent, role, goalContext, agentsMdContent, crossStageCtx, codeGraphContext, taskBlock) {
    const dynamicInput = [
      goalContext,
      skillContent    ? `## Skill Context\n${skillContent}` : '',
      expContext      ? `## Experience Context\n${expContext}` : '',
      agentsMdContent ? `## Project Context (AGENTS.md)\n${agentsMdContent}` : '',
      crossStageCtx   ? crossStageCtx : '',
      codeGraphContext ? `## Code Graph Context\n${codeGraphContext}` : '',
      taskBlock,
    ].filter(Boolean).join('\n\n');

    let optimisedPrompt = dynamicInput;
    try {
      const result = buildAgentPrompt(role, dynamicInput);
      optimisedPrompt = result.prompt;
      console.log(`[Orchestrator] LLM call for ${role} (task: ${task.id}): ~${result.meta.estimatedTokens} tokens`);
    } catch (err) {
      console.warn(`[Orchestrator] buildAgentPrompt failed for role "${role}" (task: ${task.id}): ${err.message}. Using raw prompt.`);
    }
    return this._rawLlmCall(optimisedPrompt);
  },

  /**
   * Dynamic re-planning after task completion.
   */
  async _evaluateReplan(completedTask, result, agentId) {
    const summary = this.taskManager.getSummary();
    const pendingCount = (summary.byStatus['pending'] || 0) + (summary.byStatus['blocked'] || 0);
    if (pendingCount === 0) return;

    const MAX_TOTAL_TASKS = 20;
    if (summary.total >= MAX_TOTAL_TASKS) {
      console.log(`[AgentWorker:${agentId}] Re-planning skipped: task graph at max size (${summary.total}/${MAX_TOTAL_TASKS}).`);
      return;
    }

    const outputSummary = (result && result.summary) ? String(result.summary) : '';
    if (outputSummary.length < 100) return;

    const pendingTasks = this.taskManager.getAllTasks()
      .filter(t => t.status === 'pending' || t.status === 'blocked')
      .slice(0, 10)
      .map(t => `- [${t.id}] ${t.title}${t.deps && t.deps.length > 0 ? ` (deps: ${t.deps.join(', ')})` : ''}`)
      .join('\n');

    const replanGoal = this._currentRequirement || '';
    const replanGoalSection = replanGoal
      ? [`## Global Goal`, replanGoal.slice(0, 300) + (replanGoal.length > 300 ? '...' : ''), ``]
      : [];

    const replanPrompt = [
      `You are a **Task Re-planning Agent**. A task just completed and you must evaluate whether its result reveals the need for additional tasks.`,
      ``,
      ...replanGoalSection,
      `## Completed Task`,
      `**ID**: ${completedTask.id}`,
      `**Title**: ${completedTask.title}`,
      `**Output Summary** (first 800 chars):`,
      outputSummary.slice(0, 800),
      ``,
      `## Remaining Pending Tasks`,
      pendingTasks || '(none)',
      ``,
      `## Decision`,
      `Based on the completed task's output, do you need to insert NEW tasks that were not in the original plan?`,
      ``,
      `Rules:`,
      `- Only add tasks if the completed output REVEALS a concrete gap that the existing pending tasks do NOT cover.`,
      `- Do NOT add tasks that duplicate or overlap with existing pending tasks.`,
      `- Maximum 3 new tasks per re-plan.`,
      `- New tasks must have clear, actionable titles (≤60 chars).`,
      `- New tasks may depend on the completed task (use its ID: ${completedTask.id}).`,
      ``,
      `## Output Format`,
      `If no new tasks are needed, respond with exactly:`,
      `NO_REPLAN`,
      ``,
      `If new tasks are needed, respond with:`,
      `REPLAN`,
      `NEW_TASKS:`,
      `- <task title> [deps: ${completedTask.id}]`,
      `- <task title> [deps: none]`,
      `(max 3 tasks)`,
    ].join('\n');

    let replanResponse;
    try {
      const REPLAN_TIMEOUT_MS = 15_000;
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Re-planning timed out after ${REPLAN_TIMEOUT_MS}ms`)), REPLAN_TIMEOUT_MS)
      );
      replanResponse = await Promise.race([this._rawLlmCall(replanPrompt), timeoutPromise]);
    } catch (err) {
      console.warn(`[AgentWorker:${agentId}] Re-planning LLM call failed: ${err.message}`);
      return;
    }

    if (!replanResponse || /NO_REPLAN/i.test(replanResponse)) {
      console.log(`[AgentWorker:${agentId}] Re-planning: no new tasks needed after "${completedTask.title}".`);
      return;
    }

    if (!/REPLAN/i.test(replanResponse)) return;

    const newTaskLines = replanResponse
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('- '));

    if (newTaskLines.length === 0) return;

    let inserted = 0;
    const existingTitles = new Set(
      this.taskManager.getAllTasks().map(t => (t.title || '').toLowerCase())
    );

    for (const line of newTaskLines.slice(0, 3)) {
      const depsMatch = line.match(/\[deps:\s*([^\]]+)\]/i);
      const title = line.slice(2).replace(/\[deps:[^\]]*\]/i, '').trim();
      if (!title || existingTitles.has(title.toLowerCase())) continue;

      let deps = [];
      if (depsMatch && depsMatch[1].trim().toLowerCase() !== 'none') {
        deps = depsMatch[1].split(',').map(d => d.trim()).filter(Boolean);
      }

      const newId = `replan-${completedTask.id}-${inserted + 1}`;
      try {
        this.taskManager.addTask({ id: newId, title, deps, description: `Auto-inserted by re-planning after task "${completedTask.title}" completed.` });
        existingTitles.add(title.toLowerCase());
        inserted++;
        console.log(`[AgentWorker:${agentId}] 🔄 Re-planning: inserted new task [${newId}] "${title}"${deps.length > 0 ? ` (deps: ${deps.join(', ')})` : ''}`);
        this.stateMachine.recordRisk('low', `[Replan] New task inserted after "${completedTask.title}": "${title}"`);
      } catch (err) {
        console.warn(`[AgentWorker:${agentId}] Re-planning: failed to insert task "${title}": ${err.message}`);
      }
    }

    if (inserted > 0) {
      console.log(`[AgentWorker:${agentId}] ✅ Re-planning complete: ${inserted} new task(s) inserted.`);
    }
  },

  /**
   * Enhancement 1: Validates the quality of LLM-generated task decomposition.
   */
  _validateDecomposition(taskDefs, rawRequirement) {
    const issues = [];
    const warnings = [];

    // Check 1: Requirement Keyword Coverage
    const reqWords = _extractSignificantWordsLocal(rawRequirement);
    const taskTitleWords = new Set();
    for (const t of taskDefs) {
      for (const w of _extractSignificantWordsLocal(t.title)) {
        taskTitleWords.add(w);
      }
    }
    const coveredWords = reqWords.filter(w => taskTitleWords.has(w));
    const coverageRate = reqWords.length > 0
      ? Math.round((coveredWords.length / reqWords.length) * 100)
      : 100;

    if (coverageRate < 30) {
      issues.push(`Requirement keyword coverage too low (${coverageRate}%): tasks may not address the core requirement. ` +
        `Missing concepts: [${reqWords.filter(w => !taskTitleWords.has(w)).slice(0, 5).join(', ')}]`);
    } else if (coverageRate < 60) {
      warnings.push(`Requirement keyword coverage is moderate (${coverageRate}%). ` +
        `Potentially missing: [${reqWords.filter(w => !taskTitleWords.has(w)).slice(0, 5).join(', ')}]`);
    }

    // Check 2: Dependency Graph Validity (DAG check)
    const idSet = new Set(taskDefs.map(t => t.id));
    const inDegree = {};
    const adjacency = {};
    for (const t of taskDefs) {
      inDegree[t.id] = 0;
      adjacency[t.id] = [];
    }
    let invalidDeps = 0;
    for (const t of taskDefs) {
      for (const dep of t.deps) {
        if (!idSet.has(dep)) {
          invalidDeps++;
          continue;
        }
        adjacency[dep].push(t.id);
        inDegree[t.id]++;
      }
    }
    if (invalidDeps > 0) {
      warnings.push(`${invalidDeps} dependency reference(s) point to non-existent task IDs (will be ignored).`);
    }

    const queue = Object.keys(inDegree).filter(id => inDegree[id] === 0);
    let sorted = 0;
    const visited = new Set();
    while (queue.length > 0) {
      const node = queue.shift();
      visited.add(node);
      sorted++;
      for (const next of (adjacency[node] || [])) {
        inDegree[next]--;
        if (inDegree[next] === 0) queue.push(next);
      }
    }
    if (sorted < taskDefs.length) {
      const cycleNodes = taskDefs.filter(t => !visited.has(t.id)).map(t => t.id);
      issues.push(`Dependency cycle detected among tasks: [${cycleNodes.join(', ')}]. Parallel execution would deadlock.`);
    }

    // Check for disconnected subgraphs
    const hasOutgoing = new Set();
    const hasIncoming = new Set();
    for (const t of taskDefs) {
      if (t.deps.length > 0) {
        hasIncoming.add(t.id);
        t.deps.forEach(d => hasOutgoing.add(d));
      }
    }
    const isolated = taskDefs.filter(t => !hasOutgoing.has(t.id) && !hasIncoming.has(t.id));
    if (isolated.length > 1 && isolated.length === taskDefs.length) {
      warnings.push(`All ${isolated.length} tasks are completely independent (no dependencies). ` +
        `This may indicate the requirement was split into unrelated work items rather than a coherent plan.`);
    }

    // Check 3: Task Granularity Balance
    const titleLengths = taskDefs.map(t => t.title.length);
    const avgLen = titleLengths.reduce((a, b) => a + b, 0) / titleLengths.length;
    if (avgLen > 0) {
      for (const t of taskDefs) {
        if (t.title.length > avgLen * 3 && t.title.length > 40) {
          warnings.push(`Task "${t.id}" title is unusually long (${t.title.length} chars vs avg ${Math.round(avgLen)}). May need further decomposition.`);
        }
      }
    }

    // Check 4: Parallelism Ratio – Anti-Serial-Collapse Guard
    // Detects task graphs that appear parallel but actually form a long serial
    // chain, causing concurrency workers to sit idle. Uses the DAG critical path
    // (longest dependency chain) computed via topological-order DP.
    if (sorted === taskDefs.length && taskDefs.length >= 3) {
      // Compute longest path (critical path depth) via topological DP.
      // Re-derive topological order from adjacency (already validated acyclic).
      const inDeg2 = {};
      for (const t of taskDefs) { inDeg2[t.id] = 0; }
      for (const t of taskDefs) {
        for (const dep of t.deps) {
          if (idSet.has(dep)) inDeg2[t.id]++;
        }
      }
      const topoQueue = Object.keys(inDeg2).filter(id => inDeg2[id] === 0);
      const topoOrder = [];
      while (topoQueue.length > 0) {
        const node = topoQueue.shift();
        topoOrder.push(node);
        for (const next of (adjacency[node] || [])) {
          inDeg2[next]--;
          if (inDeg2[next] === 0) topoQueue.push(next);
        }
      }

      // DP: longest path from any source to each node
      const depth = {};
      for (const id of topoOrder) { depth[id] = 1; } // each node has depth >= 1
      for (const id of topoOrder) {
        for (const next of (adjacency[id] || [])) {
          if (depth[id] + 1 > depth[next]) {
            depth[next] = depth[id] + 1;
          }
        }
      }
      const maxChainDepth = Math.max(...Object.values(depth));
      const parallelismRatio = taskDefs.length / maxChainDepth;

      if (parallelismRatio <= 1.0 && taskDefs.length >= 4) {
        // Fully serial chain: every task depends on the previous one
        issues.push(
          `Serial collapse detected: all ${taskDefs.length} tasks form a single dependency chain ` +
          `(max chain depth = ${maxChainDepth}, parallelism ratio = ${parallelismRatio.toFixed(2)}). ` +
          `Parallel execution would degrade to sequential. Consider restructuring tasks ` +
          `to allow independent work items, or fall back to sequential mode.`
        );
      } else if (parallelismRatio <= 1.2 && taskDefs.length >= 3) {
        // Near-serial: very little actual parallelism available
        warnings.push(
          `Low parallelism ratio (${parallelismRatio.toFixed(2)}): ${taskDefs.length} tasks with ` +
          `max chain depth ${maxChainDepth}. Most workers will be idle during execution. ` +
          `Effective concurrency ≈ ${parallelismRatio.toFixed(1)}x.`
        );
      }
    }

    return { valid: issues.length === 0, issues, warnings, coverageRate };
  },

  /**
   * Enhancement 2: Cross-task output coherence check.
   */
  async _checkCrossTaskCoherence(goal) {
    const allTasks = this.taskManager.getAllTasks();
    const doneTasks = allTasks.filter(t => t.status === 'done');

    if (doneTasks.length < 2) {
      console.log(`[Orchestrator] ⏭️  Cross-task coherence check skipped (only ${doneTasks.length} completed task(s)).`);
      return;
    }

    const taskSummaries = doneTasks.map(t => {
      const outputSnippet = (t.result && t.result.summary)
        ? String(t.result.summary).slice(0, 200)
        : '(no output summary)';
      return `[${t.id}] ${t.title}\n  Output: ${outputSnippet}`;
    }).join('\n\n');

    const coherencePrompt = [
      `You are an **Integration Coherence Auditor**. Multiple parallel tasks just completed for the following goal:`,
      ``,
      `## Goal`,
      goal.slice(0, 500),
      ``,
      `## Completed Tasks and Outputs`,
      taskSummaries,
      ``,
      `## Task`,
      `Evaluate whether these task outputs are COHERENT as a whole:`,
      `- Do the outputs reference consistent interfaces/APIs/data models?`,
      `- Are there any obvious contradictions or gaps between tasks?`,
      `- Is anything from the original goal clearly NOT addressed by any task?`,
      ``,
      `## Output Format`,
      `If all outputs are coherent, respond with exactly:`,
      `COHERENT`,
      ``,
      `If there are integration issues, respond with:`,
      `ISSUES`,
      `- <issue description>`,
      `- <issue description>`,
      `(max 5 issues)`,
    ].join('\n');

    let response;
    try {
      const TIMEOUT_MS = 15_000;
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Cross-task coherence check timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)
      );
      response = await Promise.race([this._rawLlmCall(coherencePrompt), timeoutPromise]);
    } catch (err) {
      console.warn(`[Orchestrator] Cross-task coherence LLM call failed: ${err.message}`);
      return;
    }

    if (!response || /COHERENT/i.test(response.trim().split('\n')[0])) {
      console.log(`[Orchestrator] ✅ Cross-task coherence check: all outputs are coherent.`);
      this.experienceStore.recordIfAbsent(
        `Cross-task coherence: ${doneTasks.length} tasks produced coherent output`,
        {
          type: 'positive',
          category: 'stable_pattern',
          title: `Cross-task coherence: ${doneTasks.length} tasks produced coherent output`,
          content: `Goal: ${goal.slice(0, 200)}\nTasks: ${doneTasks.map(t => t.title).join(', ')}\nAll task outputs were verified as coherent – no integration issues detected.`,
          skill: 'task-management',
          tags: ['coherence', 'cross-task', 'positive'],
        }
      );
      return;
    }

    const issueLines = response.split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('- '))
      .map(l => l.slice(2).trim())
      .slice(0, 5);

    if (issueLines.length > 0) {
      console.warn(`[Orchestrator] ⚠️  Cross-task coherence issues detected (${issueLines.length}):`);
      for (const issue of issueLines) {
        console.warn(`  • ${issue}`);
        if (this.stateMachine && this.stateMachine.manifest) {
          this.stateMachine.recordRisk('medium', `[CrossTaskCoherence] ${issue}`);
        }
      }

      this.experienceStore.record({
        type: 'negative',
        category: 'pitfall',
        title: `Cross-task coherence: integration issues found`,
        content: `Goal: ${goal.slice(0, 200)}\nTasks: ${doneTasks.map(t => t.title).join(', ')}\nIssues:\n${issueLines.map(i => `- ${i}`).join('\n')}`,
        skill: 'task-management',
        tags: ['coherence', 'cross-task', 'negative', 'integration'],
      });
    }
  },

  /**
   * Enhancement 3: Requirement coverage traceability.
   */
  _checkRequirementCoverage(goal) {
    const allTasks = this.taskManager.getAllTasks();
    const doneTasks = allTasks.filter(t => t.status === 'done');
    const failedTasks = allTasks.filter(t => t.status === 'failed' || t.status === 'exhausted');

    if (doneTasks.length === 0) {
      console.warn(`[Orchestrator] ⚠️  Requirement coverage: no tasks completed. Cannot verify coverage.`);
      return;
    }

    const outputCorpus = doneTasks.map(t => {
      const summary = (t.result && t.result.summary) ? String(t.result.summary) : '';
      return `${t.title} ${summary}`;
    }).join(' ').toLowerCase();

    const reqWords = _extractSignificantWordsLocal(goal);
    if (reqWords.length === 0) {
      console.log(`[Orchestrator] ⏭️  Requirement coverage check skipped (no significant keywords extracted from goal).`);
      return;
    }

    const covered = [];
    const uncovered = [];
    for (const word of reqWords) {
      if (outputCorpus.includes(word)) {
        covered.push(word);
      } else {
        uncovered.push(word);
      }
    }

    const coverageRate = Math.round((covered.length / reqWords.length) * 100);

    if (uncovered.length === 0) {
      console.log(`[Orchestrator] ✅ Requirement coverage: 100% (${reqWords.length}/${reqWords.length} key concepts addressed).`);
    } else {
      const statusIcon = coverageRate >= 80 ? '⚠️' : '❌';
      console.log(`[Orchestrator] ${statusIcon} Requirement coverage: ${coverageRate}% (${covered.length}/${reqWords.length} key concepts addressed).`);
      console.log(`[Orchestrator]    Potentially uncovered: [${uncovered.join(', ')}]`);

      if (this.stateMachine && this.stateMachine.manifest) {
        for (const word of uncovered.slice(0, 5)) {
          this.stateMachine.recordRisk(
            coverageRate < 50 ? 'high' : 'medium',
            `[RequirementCoverage] Concept "${word}" from original requirement not found in any completed task output.`
          );
        }
      }
    }

    if (failedTasks.length > 0) {
      console.warn(`[Orchestrator] ⚠️  ${failedTasks.length} task(s) failed/exhausted – their requirement aspects may be uncovered:`);
      for (const t of failedTasks) {
        console.warn(`  • [${t.id}] ${t.title}`);
        if (this.stateMachine && this.stateMachine.manifest) {
          this.stateMachine.recordRisk('high', `[RequirementCoverage] Task "${t.title}" failed – its requirement scope is uncovered.`);
        }
      }
    }

    return { coverageRate, covered, uncovered, failedTasks: failedTasks.map(t => t.id) };
  },
};

// ─── Module-level Stopwords (used by _validateDecomposition and _checkRequirementCoverage) ──

const _DECOMP_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'shall',
  'can', 'need', 'must', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'we', 'you',
  'they', 'he', 'she', 'my', 'our', 'your', 'their', 'all', 'each', 'every', 'both',
  'few', 'more', 'most', 'other', 'some', 'such', 'no', 'not', 'only', 'same', 'so',
  'than', 'too', 'very', 'just', 'about', 'above', 'after', 'again', 'also', 'any',
  'because', 'before', 'below', 'between', 'during', 'further', 'here', 'how', 'if',
  'into', 'once', 'out', 'over', 'own', 'then', 'there', 'through', 'under', 'until',
  'up', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'what', 'as', 'new',
  'use', 'using', 'used', 'make', 'like', 'get', 'set',
  'implement', 'create', 'build', 'add', 'update', 'write', 'code', 'develop',
  'feature', 'function', 'method', 'class', 'file', 'module', 'system', 'project',
  'please', 'want', 'based', 'following',
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
  '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
  '自己', '这', '他', '她', '它', '我们', '你们', '他们', '这个', '那个',
  '可以', '需要', '进行', '实现', '使用', '通过', '以及', '并且', '或者',
]);

/**
 * Extracts significant (non-stopword) keywords from a text string.
 * Supports both English and Chinese text. Returns lowercased unique words.
 */
function _extractSignificantWordsLocal(text) {
  if (!text || typeof text !== 'string') return [];
  const words = new Set();
  const englishWords = text.toLowerCase().match(/[a-z][a-z0-9_-]{1,}/g) || [];
  for (const w of englishWords) {
    if (!_DECOMP_STOPWORDS.has(w) && w.length > 2) {
      words.add(w);
    }
  }
  const chineseChars = text.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const segment of chineseChars) {
    if (!_DECOMP_STOPWORDS.has(segment) && segment.length >= 2) {
      words.add(segment);
    }
  }
  return Array.from(words);
}
