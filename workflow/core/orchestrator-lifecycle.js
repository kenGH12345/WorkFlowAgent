/**
 * Orchestrator Lifecycle – Shared startup/teardown and public API helpers
 *
 * Extracted from index.js to reduce the Orchestrator class size.
 * These methods are mixed into Orchestrator.prototype via Object.assign.
 *
 * Contains:
 *   - _initWorkflow()         – shared startup (StateMachine, memory, AGENTS.md)
 *   - _finalizeWorkflow()     – shared teardown (flush, dashboard, risk summary, git PR)
 *   - recordExperience()      – manual experience recording
 *   - fileComplaint()         – complaint filing
 *   - resolveComplaint()      – complaint resolution
 *   - getSystemStatus()       – Markdown status report
 *   - registerStage()         – custom stage registration
 *   - _runStage()             – single-stage executor
 *   - _rebuildCodeGraphAsync() – fire-and-forget code graph update
 */

'use strict';

const fs = require('fs');
const { PATHS, HOOK_EVENTS } = require('./constants');
const { STATE_ORDER } = require('./types');
const { SkillWatcher } = require('./skill-watcher');
const { getCachedLoader, onLoaderReady } = require('./prompt-builder');
const { ComplaintStatus } = require('./complaint-wall');

module.exports = {

  /**
   * Shared startup sequence used by both run() and runTaskBased().
   * Initialises StateMachine, builds memory context, loads AGENTS.md, and
   * prints any open complaints so agents are aware before execution begins.
   *
   * @returns {string} resumeState – the state to resume from (from StateMachine)
   */
  async _initWorkflow() {
    // 1. Initialise state machine (handles checkpoint resume)
    const resumeState = await this.stateMachine.init();
    console.log(`[Orchestrator] StateMachine initialised. Resume state: ${resumeState}`);

    // 2. Build global memory context and cache content for Agent injection
    await this.memory.buildGlobalContext().catch(err =>
      console.warn(`[Orchestrator] Memory build warning: ${err.message}`)
    );
    // Start file watcher so AGENTS.md auto-syncs when project files change during the run.
    this.memory.startWatching();
    // Read AGENTS.md content once and cache it for all Agent stages
    this._agentsMdContent = fs.existsSync(PATHS.AGENTS_MD)
      ? fs.readFileSync(PATHS.AGENTS_MD, 'utf-8')
      : '';
    if (this._agentsMdContent) {
      console.log(`[Orchestrator] 📋 AGENTS.md loaded (${this._agentsMdContent.length} chars) – will be injected into all Agent prompts.`);
    }

    // 3. Print open complaints before starting (awareness check)
    const openComplaints = this.complaintWall.getOpenComplaints();
    if (openComplaints.length > 0) {
      console.warn(`[Orchestrator] ⚠️  ${openComplaints.length} open complaint(s) need attention:`);
      for (const c of openComplaints.slice(0, 3)) {
        console.warn(`  [${c.severity}] ${c.description}`);
      }
    }

    // 4. Start SkillWatcher for hot-reload of skill files
    // Fix: ContextLoader is a module-level cached singleton inside prompt-builder.js,
    // not an Orchestrator property. Use getCachedLoader() to retrieve it.
    const cachedLoader = getCachedLoader();
    if (cachedLoader && this.skillEvolution) {
      this._skillWatcher = new SkillWatcher(cachedLoader, PATHS.SKILLS_DIR, {
        skillEvolution: this.skillEvolution,
      });
      this._skillWatcher.on('skill:changed', ({ filename, eventType }) => {
        console.log(`[Orchestrator] 🔄 Skill hot-reload: ${filename} (${eventType})`);
      });
      this._skillWatcher.start();
    } else if (!cachedLoader) {
      // SkillWatcher deferred: ContextLoader hasn't been created yet (lazy init
      // in prompt-builder.js). Register a one-shot callback so the watcher starts
      // automatically on the first buildAgentPrompt() call.
      this._skillWatcherDeferred = true;
      onLoaderReady((loader) => {
        if (this._skillWatcher || !this.skillEvolution) return; // already started or shutdown
        this._skillWatcher = new SkillWatcher(loader, PATHS.SKILLS_DIR, {
          skillEvolution: this.skillEvolution,
        });
        this._skillWatcher.on('skill:changed', ({ filename, eventType }) => {
          console.log(`[Orchestrator] 🔄 Skill hot-reload: ${filename} (${eventType})`);
        });
        this._skillWatcher.start();
        this._skillWatcherDeferred = false;
        console.log(`[Orchestrator] 🔄 SkillWatcher started (deferred → ContextLoader now available).`);
      });
      console.log(`[Orchestrator] ℹ️  SkillWatcher deferred: ContextLoader not yet initialised (will activate on first LLM call).`);
    }

    // 5. Connect MCP adapters (fire-and-forget, non-blocking)
    // Uses ServiceContainer.resolve() to access the MCPRegistry instance –
    // this is the first real consumption of the DI container, activating the
    // ServiceContainer that was previously registered-but-never-consumed.
    if (this.services.has('mcpRegistry')) {
      const registry = this.services.resolve('mcpRegistry');
      registry.connectAll().catch(err =>
        console.warn(`[Orchestrator] ⚠️  MCP connectAll failed (non-fatal): ${err.message}`)
      );
    }

    return resumeState;
  },

  /**
   * Shared teardown sequence used by both run() and runTaskBased().
   * Flushes risks, saves the bus log, emits WORKFLOW_COMPLETE, stops the file
   * watcher, prints the Observability dashboard, and prints the risk summary.
   *
   * @param {string} mode   - 'sequential' | 'task-based' (for WORKFLOW_COMPLETE payload)
   * @param {object} [extra] - Additional fields merged into the WORKFLOW_COMPLETE payload
   */
  async _finalizeWorkflow(mode, extra = {}) {
    // Flush all in-memory risk entries to the manifest checkpoint
    if (this.stateMachine.flushRisks) {
      this.stateMachine.flushRisks();
    }

    // Persist the inter-agent communication log
    this.bus.saveLog();

    // P1-C fix: flush ExperienceStore write queue before emitting WORKFLOW_COMPLETE.
    try {
      if (this.experienceStore && typeof this.experienceStore.flushDirty === 'function') {
        await this.experienceStore.flushDirty();
        console.log(`[Orchestrator] 💾 ExperienceStore flushed in _finalizeWorkflow (task-based write guarantee).`);
      }
    } catch (flushErr) {
      console.warn(`[Orchestrator] ⚠️  ExperienceStore flush in _finalizeWorkflow failed (non-fatal): ${flushErr.message}`);
    }

    // Emit WORKFLOW_COMPLETE so HookSystem handlers (e.g. notifications) are triggered
    await this.hooks.emit(HOOK_EVENTS.WORKFLOW_COMPLETE, {
      mode,
      projectId: this.projectId,
      ...extra,
    });

    // Stop file watcher – no more changes expected
    this.memory.stopWatching();

    // Stop SkillWatcher
    if (this._skillWatcher) {
      this._skillWatcher.stop();
      this._skillWatcher = null;
    }

    // ── Export resolved complaints to troubleshooting skill ────────────────────
    // Closes the feedback loop: complaint resolution → troubleshooting knowledge.
    // Collects all resolved complaints, formats them as troubleshooting entries,
    // and feeds them into SkillEvolution to update the troubleshooting skill file.
    if (this.complaintWall && this.skillEvolution) {
      try {
        const { entries, count } = this.complaintWall.exportToTroubleshooting();
        if (count > 0) {
          for (const entry of entries) {
            this.skillEvolution.evolve('troubleshooting', {
              trigger: `complaint-resolution:${entry.sourceComplaintId}`,
              newContent: [
                `### ${entry.title}`,
                `**Error:** ${entry.error}`,
                `**Root Cause:** ${entry.rootCause}`,
                `**Fix:** ${entry.fix}`,
                `**Prevention:** ${entry.prevention}`,
              ].join('\n'),
            });
          }
          console.log(`[Orchestrator] 📚 Exported ${count} resolved complaint(s) to troubleshooting skill.`);
        }
      } catch (tsErr) {
        console.warn(`[Orchestrator] ⚠️  Troubleshooting export failed (non-fatal): ${tsErr.message}`);
      }
    }

    // ── AEF Self-Refinement Analysis ──────────────────────────────────────────
    // Inspired by AEF's self-refinement skill: analyse the workflow run for
    // error patterns and generate refinement suggestions.
    // Two channels: automatic (low-severity, auto-evolve) and prudent (high-severity, suggest only).
    if (this.complaintWall && this.skillEvolution && this.experienceStore) {
      try {
        const openComplaints = this.complaintWall.getOpenComplaints();
        const negativeExps = this.experienceStore.getAll ? this.experienceStore.getAll().filter(e => e.type === 'negative') : [];
        const refinementSuggestions = [];

        // Analyse open complaints for recurring patterns
        const patternCounts = {};
        for (const c of openComplaints) {
          const key = c.targetType + ':' + (c.rootCause || 'unknown');
          patternCounts[key] = (patternCounts[key] || 0) + 1;
        }

        for (const [pattern, count] of Object.entries(patternCounts)) {
          if (count >= 2) {
            const [targetType, rootCause] = pattern.split(':');
            refinementSuggestions.push({
              pattern,
              count,
              rootCause,
              suggestion: `Recurring ${targetType} issue (${rootCause}): ${count} open complaints. Consider adding a preventive rule to the relevant skill.`,
            });
          }
        }

        if (refinementSuggestions.length > 0) {
          console.log(`\n${'─'.repeat(60)}`);
          console.log(`  💡 AEF SELF-REFINEMENT SUGGESTIONS (${refinementSuggestions.length})`);
          console.log(`${'─'.repeat(60)}`);
          for (const s of refinementSuggestions.slice(0, 3)) {
            console.log(`  [${s.rootCause}] ${s.suggestion}`);
          }
          console.log(`${'─'.repeat(60)}\n`);
        }

        // Auto-evolve: for low-severity resolved complaints with clear patterns,
        // automatically add prevention rules to relevant skills
const resolvedComplaints = this.complaintWall.complaints.filter(c => c.status === ComplaintStatus.RESOLVED && c.rootCause);
        for (const rc of resolvedComplaints.slice(-3)) {  // Last 3 resolved
          const skillName = rc.targetType === 'skill' ? rc.targetId : 'troubleshooting';
          if (this.skillEvolution.registry.has(skillName)) {
            this.skillEvolution.evolve(skillName, {
              section: 'Prevention Rules',
              title: `[Auto] Prevention for ${rc.rootCause}: ${rc.description.slice(0, 60)}`,
              content: `**Root Cause**: ${rc.rootCause}\n**Prevention**: ${rc.suggestion}\n**Source**: Complaint ${rc.id}`,
              sourceExpId: rc.id,
              reason: `AEF self-refinement: auto-evolve from resolved complaint`,
            });
          }
        }
      } catch (srErr) {
        console.warn(`[Orchestrator] ⚠️  AEF Self-Refinement analysis failed (non-fatal): ${srErr.message}`);
      }
    }

    // ── Prompt A/B: snapshot variant stats into Observability before flush ──
    if (this.promptSlotManager) {
      this.obs.recordPromptVariantUsage(this.promptSlotManager.getStats());
    }

    // ── Defect #3 fix: flush metrics BEFORE printDashboard ──────────────────
    try {
      this.obs.flush();
    } catch (flushErr) {
      console.warn(`[Orchestrator] ⚠️  Observability flush failed (non-fatal): ${flushErr.message}`);
    }

    // Print Observability dashboard (session metrics summary)
    try {
      this.obs.printDashboard();
    } catch (dashErr) {
      console.warn(`[Orchestrator] ⚠️  Observability dashboard failed (non-fatal): ${dashErr.message}`);
    }

    // Print accumulated risk summary
    const risks = this.stateMachine.getRisks ? this.stateMachine.getRisks() : [];
    if (risks.length > 0) {
      console.warn(`\n${'─'.repeat(60)}`);
      console.warn(`  ⚠️  RISK SUMMARY (${risks.length} item(s))`);
      console.warn(`${'─'.repeat(60)}`);
      for (const r of risks) {
        console.warn(`  [${r.severity?.toUpperCase() ?? 'UNKNOWN'}] ${r.description}`);
      }
      console.warn(`${'─'.repeat(60)}\n`);
    }

    // ── Dry-run: save report and print summary ───────────────────────────────
    if (this.dryRun && this.sandbox.pendingCount > 0) {
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`  🧪 DRY-RUN SUMMARY: ${this.sandbox.pendingCount} pending operation(s)`);
      console.log(`${'─'.repeat(60)}`);
      const reportPath = this.sandbox.saveReport();
      console.log(`  Report saved to: ${reportPath}`);
      console.log(`  To apply changes: await orchestrator.sandbox.apply()`);
      console.log(`${'─'.repeat(60)}\n`);
      await this.hooks.emit(HOOK_EVENTS.DRYRUN_REPORT_SAVED, {
        reportPath,
        pendingCount: this.sandbox.pendingCount,
        ops: this.sandbox.getPendingOps().map(op => ({ type: op.type, path: op.relPath })),
      });
    }

    // ── Git PR workflow ──────────────────────────────────────────────────────
    if (this._gitOptions.enabled && !this.dryRun) {
      await this._runGitPRWorkflow(mode, extra);
    }
  },

  // ─── AgentFlow: Experience & Skill Management ─────────────────────────────────

  /**
   * Records an experience manually (e.g. from a human observation).
   *
   * @param {object} options - Same as ExperienceStore.record()
   * @returns {Experience}
   */
  recordExperience(options) {
    const exp = this.experienceStore.record(options);
    this.hooks.emit(HOOK_EVENTS.EXPERIENCE_RECORDED, { expId: exp.id });
    return exp;
  },

  /**
   * Files a complaint about an incorrect experience, skill, or workflow rule.
   *
   * @param {object} options - Same as ComplaintWall.file()
   * @returns {Complaint}
   */
  fileComplaint(options) {
    const complaint = this.complaintWall.file(options);
    this.hooks.emit(HOOK_EVENTS.COMPLAINT_FILED, { complaintId: complaint.id });
    return complaint;
  },

  /**
   * Resolves a complaint and optionally evolves the related skill.
   *
   * @param {string} complaintId
   * @param {string} resolution
   * @param {object} [skillEvolution] - If provided, evolves the related skill
   */
  resolveComplaint(complaintId, resolution, skillEvolution = null) {
    this.complaintWall.resolve(complaintId, resolution);
    this.hooks.emit(HOOK_EVENTS.COMPLAINT_RESOLVED, { complaintId });

    if (skillEvolution) {
      this.skillEvolution.evolve(skillEvolution.skillName, skillEvolution);
    }
  },

  /**
   * Returns a full system status report.
   *
   * @returns {string} Markdown-formatted status
   */
  getSystemStatus() {
    const taskSummary = this.taskManager.getSummary();
    const expStats = this.experienceStore.getStats();
    const skillStats = this.skillEvolution.getStats();
    const complaintStats = this.complaintWall.getStats();

    const lines = [
      `# AgentFlow System Status`,
      ``,
      `## Tasks`,
      `- Total: ${taskSummary.total}`,
      ...Object.entries(taskSummary.byStatus).map(([s, n]) => `- ${s}: ${n}`),
      ``,
      `## Experience Store`,
      `- Total: ${expStats.total} (✅ ${expStats.positive} positive / ❌ ${expStats.negative} negative)`,
      `- Total evolutions triggered: ${expStats.totalEvolutions}`,
      ``,
      `## Skills`,
      `- Total skills: ${skillStats.totalSkills}`,
      `- Total evolutions: ${skillStats.totalEvolutions}`,
      skillStats.mostEvolved.length > 0
        ? `- Most evolved: ${skillStats.mostEvolved.map(s => `${s.name} (×${s.evolutionCount})`).join(', ')}`
        : '',
      ``,
      this.complaintWall.getSummaryText(),
    ];

    return lines.filter(l => l !== '').join('\n');
  },

  // ─── Stage Registration (P1-b) ────────────────────────────────────────────

  /**
   * Registers a custom stage runner in the pipeline.
   *
   * @param {StageRunner} runner - Must extend StageRunner
   * @param {object} [opts]
   * @param {string} [opts.before] - Insert before this existing stage
   * @param {string} [opts.after]  - Insert after this existing stage
   * @returns {Orchestrator} this (for chaining)
   */
  registerStage(runner, opts = {}) {
    this.stageRegistry.register(runner, opts);
    const { buildStateOrder } = require('./types');
    const newStateOrder = buildStateOrder(this.stageRegistry.getOrder());
    this.stateMachine.setStateOrder(newStateOrder);
    console.log(`[Orchestrator] 🔧 Custom stage "${runner.getName()}" registered. Pipeline: [${this.stageRegistry.getOrder().join(' → ')}]`);
    return this;
  },

  // ─── Stage Runners ────────────────────────────────────────────────────────────

  /**
   * Runs a single stage if not already completed.
   * Skips the stage if the current state is already past it.
   */
  async _runStage(fromState, toState, stageRunner, resumeState) {
    const resumeIdx = STATE_ORDER.indexOf(resumeState);
    const fromIdx = STATE_ORDER.indexOf(fromState);

    // If resumeState is invalid (not in STATE_ORDER), treat as fresh start (idx = 0).
    const effectiveResumeIdx = resumeIdx === -1 ? 0 : resumeIdx;

    // Skip if already past this stage
    if (effectiveResumeIdx > fromIdx) {
      console.log(`[Orchestrator] Skipping stage ${fromState} → ${toState} (already completed)`);
      return;
    }

    // Observability: track stage timing
    const stageLabel = `${fromState}→${toState}`;
    this.obs.stageStart(stageLabel);
    let stageStatus = 'ok';
    try {
      const stageResult = await stageRunner();
      const alreadyTransitioned = stageResult && stageResult.__alreadyTransitioned === true;
      const artifactPath = alreadyTransitioned ? stageResult.artifactPath : stageResult;
      if (!alreadyTransitioned) {
        await this.stateMachine.transition(artifactPath, `Stage ${fromState} → ${toState} completed`);
      } else {
        // P0-C fix: use jumpTo(toState) to forcibly advance the state machine
        const currentState = this.stateMachine.getState();
        if (currentState !== toState) {
          console.log(`[Orchestrator] P0-C: State machine at "${currentState}" after rollback chain; jumping to "${toState}" to stay in sync.`);
          await this.stateMachine.jumpTo(toState, `P0-C sync after rollback chain in stage ${fromState}→${toState}`);
        }
      }
    } catch (err) {
      stageStatus = 'error';
      this.obs.recordError(stageLabel, err.message);
      throw err;
    } finally {
      this.obs.stageEnd(stageLabel, stageStatus);
    }
  },

  /**
   * Rebuilds the code graph asynchronously (fire-and-forget).
   *
   * @param {string} trigger - Label for logging (e.g. 'post-developer')
   */
  _rebuildCodeGraphAsync(trigger = 'manual') {
    setImmediate(async () => {
      try {
        console.log(`[Orchestrator] 🔄 Code graph update triggered (${trigger})...`);
        const result = await this.codeGraph.build();
        console.log(`[Orchestrator] ✅ Code graph updated: ${result.symbolCount} symbols, ${result.edgeCount} edges`);
        this.obs.recordCodeGraphResult(result);
      } catch (err) {
        console.warn(`[Orchestrator] Code graph update failed (non-fatal): ${err.message}`);
      }
    });
  },
};
