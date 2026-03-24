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
const path = require('path');
const { PATHS, HOOK_EVENTS } = require('./constants');
const { STATE_ORDER } = require('./types');
const { SkillWatcher } = require('./skill-watcher');
const { getCachedLoader, onLoaderReady } = require('./prompt-builder');
const { ComplaintStatus } = require('./complaint-wall');
const { SessionSignalDetector } = require('./session-signal-detector');
const { SessionQualityScorer } = require('./session-quality-scorer');
const { KnowledgeLayer, getLayerForCategory } = require('./experience-types');

// ─── P1 Recovery Hook: Recoverable Error Classification ────────────────────
// Defines which error types are safe to auto-retry in _runStage().
// Transient errors (network timeouts, rate limits, temporary file locks)
// should be retried; logic errors and fatal failures should not.
//
// Classification approach:
//   1. Error code matching (ETIMEDOUT, ECONNRESET, etc.)
//   2. Error message pattern matching (rate_limit, 429, 503, etc.)
//   3. Error class matching (known transient error classes)

const RECOVERABLE_ERROR_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED',
  'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN',
  'ENOTFOUND', 'EBUSY', 'EMFILE', 'ENFILE',
]);

const RECOVERABLE_MESSAGE_PATTERNS = [
  /rate.?limit/i,
  /too many requests/i,
  /\b429\b/,
  /\b503\b/,
  /\b502\b/,
  /service.?unavailable/i,
  /gateway.?timeout/i,
  /request.?timeout/i,
  /connection.?reset/i,
  /network.?error/i,
  /socket.?hang.?up/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /temporarily.?unavailable/i,
  /overloaded/i,
  /capacity/i,
  /throttl/i,
  /quota.?exceeded/i,
];

/**
 * Determines if an error is transient/recoverable and safe to auto-retry.
 *
 * @param {Error} err
 * @returns {{ recoverable: boolean, category: string }}
 */
function classifyError(err) {
  if (!err) return { recoverable: false, category: 'unknown' };

  // Check error code (Node.js system errors)
  if (err.code && RECOVERABLE_ERROR_CODES.has(err.code)) {
    return { recoverable: true, category: `system:${err.code}` };
  }

  // Check HTTP status code (LLM API errors)
  const statusCode = err.status || err.statusCode || err.response?.status;
  if (statusCode === 429 || statusCode === 502 || statusCode === 503 || statusCode === 504) {
    return { recoverable: true, category: `http:${statusCode}` };
  }

  // Check error message patterns
  const msg = err.message || '';
  for (const pattern of RECOVERABLE_MESSAGE_PATTERNS) {
    if (pattern.test(msg)) {
      return { recoverable: true, category: `message:${pattern.source.slice(0, 30)}` };
    }
  }

  return { recoverable: false, category: 'fatal' };
}

module.exports = {

  /**
   * Shared startup sequence used by both run() and runTaskBased().
   * Initialises StateMachine, builds memory context, loads AGENTS.md, and
   * prints any open complaints so agents are aware before execution begins.
   *
   * P1-4: Side Effect Isolation — each setup step is:
   *   1. Wrapped in an idempotent guard (safe to call multiple times)
   *   2. Isolated in its own try/catch (one failure doesn't block others)
   *   3. Labelled for structured logging and debugging
   *
   * Reference: Temporal — "Workflow code must be deterministic; side effects
   * belong in Activities." We isolate each side effect so re-entry after crash
   * doesn't re-execute already-completed setup steps.
   *
   * @returns {string} resumeState – the state to resume from (from StateMachine)
   */
  async _initWorkflow() {
    // P1-4: Track which init steps have completed (idempotent re-entry guard)
    if (!this._initCompleted) this._initCompleted = new Set();

    // ── Step 1: StateMachine init (MUST run first, not idempotent-guarded) ──
    const resumeState = await this.stateMachine.init();
    console.log(`[Orchestrator] StateMachine initialised. Resume state: ${resumeState}`);

    // ── Step 2: Memory context + AGENTS.md (idempotent: re-reading is safe) ──
    if (!this._initCompleted.has('memory')) {
      try {
        await this.memory.buildGlobalContext().catch(err =>
          console.warn(`[Orchestrator] Memory build warning: ${err.message}`)
        );
        this.memory.startWatching();
        this._agentsMdContent = fs.existsSync(PATHS.AGENTS_MD)
          ? fs.readFileSync(PATHS.AGENTS_MD, 'utf-8')
          : '';
        if (this._agentsMdContent) {
          console.log(`[Orchestrator] 📋 AGENTS.md loaded (${this._agentsMdContent.length} chars) – will be injected into all Agent prompts.`);
        }
        this._initCompleted.add('memory');
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️  [P1-4] Step 2 (Memory/AGENTS.md) failed (non-fatal): ${err.message}`);
      }
    }

    // ── Step 3: Complaint awareness check (idempotent: read-only) ──
    if (!this._initCompleted.has('complaints')) {
      try {
        const openComplaints = this.complaintWall.getOpenComplaints();
        if (openComplaints.length > 0) {
          console.warn(`[Orchestrator] ⚠️  ${openComplaints.length} open complaint(s) need attention:`);
          for (const c of openComplaints.slice(0, 3)) {
            console.warn(`  [${c.severity}] ${c.description}`);
          }
        }
        this._initCompleted.add('complaints');
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️  [P1-4] Step 3 (Complaints) failed (non-fatal): ${err.message}`);
      }
    }

    // ── Step 4: SkillWatcher (idempotent: guarded by this._skillWatcher check) ──
    if (!this._initCompleted.has('skillWatcher')) {
      try {
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
          this._skillWatcherDeferred = true;
          onLoaderReady((loader) => {
            if (this._skillWatcher || !this.skillEvolution) return;
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
        this._initCompleted.add('skillWatcher');
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️  [P1-4] Step 4 (SkillWatcher) failed (non-fatal): ${err.message}`);
      }
    }

    // ── Step 5: MCP adapters (idempotent: connectAll is safe to re-call) ──
    if (!this._initCompleted.has('mcpAdapters')) {
      try {
        if (this.services.has('mcpRegistry')) {
          const registry = this.services.resolve('mcpRegistry');
          registry.connectAll().catch(err =>
            console.warn(`[Orchestrator] ⚠️  MCP connectAll failed (non-fatal): ${err.message}`)
          );
        }
        this._initCompleted.add('mcpAdapters');
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️  [P1-4] Step 5 (MCP Adapters) failed (non-fatal): ${err.message}`);
      }
    }

    // ── Step 6: Experience preheat (idempotent: only fires when total < 3) ──
    if (!this._initCompleted.has('experiencePreheat')) {
      try {
        if (this.experienceStore) {
          const stats = this.experienceStore.getStats();
          if (stats.total < 3) {
            const { preheatExperienceStore } = require('./context-budget-manager');
            const techStack = this._detectTechStackForPreheat();
            preheatExperienceStore(this, { techStack, projectType: this._detectProjectType() })
              .then(r => {
                if (r.success && r.seeded > 0) {
                  console.log(`[Orchestrator] 🌱 Experience cold-start preheated: ${r.seeded} seed experiences injected.`);
                }
              })
              .catch(err => {
                console.warn(`[Orchestrator] ⚠️  Experience preheat failed (non-fatal): ${err.message}`);
              });
          }
        }
        this._initCompleted.add('experiencePreheat');
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️  [P1-4] Step 6 (Experience Preheat) failed (non-fatal): ${err.message}`);
      }
    }

    // ── Step 6b: P1 fix – Set ExperienceStore reference in PromptBuilder for synonym expansion ──
    if (!this._initCompleted.has('experienceStoreRef')) {
      try {
        if (this.experienceStore) {
          const { setExperienceStore } = require('./prompt-builder');
          setExperienceStore(this.experienceStore);
          console.log(`[Orchestrator] 🔗 ExperienceStore linked to PromptBuilder (synonym expansion enabled).`);
        }
        this._initCompleted.add('experienceStoreRef');
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️  [P1-4] Step 6b (ExperienceStore Ref) failed (non-fatal): ${err.message}`);
      }
    }

    // ── Steps 7-9: Island modules (Logger, Negotiation, ExperienceRouter) ──
    if (!this._initCompleted.has('islandModules')) {
      try {
        await this._initIslandModules(resumeState);
        this._initCompleted.add('islandModules');
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️  [P1-4] Steps 7-9 (Island Modules) failed (non-fatal): ${err.message}`);
      }
    }

    // ── Step 10: P2-1 EventJournal — Append-only event sourcing log ──────────
    // Creates an EventJournal and attaches it to HookSystem as a universal
    // subscriber. Every emitted event is captured in a JSONL file for:
    //   - Structured observability (query events by type/stage/time)
    //   - Future replay support (deterministic session reconstruction)
    //   - Debugging (full audit trail of all LLM calls, transitions, errors)
    // Reference: Restate deterministic journal + OpenHands EventStream.
    if (!this._initCompleted.has('eventJournal')) {
      try {
        const { EventJournal } = require('./event-journal');
        this.eventJournal = new EventJournal({
          outputDir: this._outputDir || PATHS.OUTPUT_DIR,
          sessionId: `${this.projectId || 'session'}-${Date.now()}`,
          enabled: true,
        });
        this.eventJournal.attachToHookSystem(this.hooks);
        this._initCompleted.add('eventJournal');
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️  [P2-1] Step 10 (EventJournal) failed (non-fatal): ${err.message}`);
      }
    }

    return resumeState;
  },

  // ── Step 7: P1-4 Structured Logger: emit first structured log entry ────────
  // ── Step 8: P1-2 NegotiationEngine: reset counters for new run ────────────
  // ── Step 9: P2-1 ExperienceRouter: auto-import from other projects ────────
  // These are integrated at the end of _initWorkflow so all prerequisites
  // (AGENTS.md, ExperienceStore, techStack) are available.

  /**
   * Initialises the "island" modules that were previously created but not
   * connected to the lifecycle. Called at the end of _initWorkflow().
   *
   * @param {string} resumeState
   */
  async _initIslandModules(resumeState) {
    // Step 7: Structured Logger — first structured log entry
    if (this.logger) {
      this.logger.info('Orchestrator', 'Workflow initialised', {
        projectId: this.projectId,
        resumeState,
        outputDir: this._outputDir,
      });
    }

    // Step 8: NegotiationEngine — reset round counters for fresh run
    if (this.negotiation) {
      this.negotiation.reset();
      if (this.logger) {
        this.logger.info('Negotiation', 'Round counters reset for new workflow run');
      }
    }

    // Step 9: ExperienceRouter — update tech stack and auto-import
    if (this.experienceRouter) {
      // Update tech stack from AGENTS.md (now loaded) so discovery uses accurate tags
      const detectedTechStack = this._detectTechStackForPreheat();
      if (detectedTechStack.length > 0) {
        this.experienceRouter._techStack = new Set(detectedTechStack.map(t => t.toLowerCase()));
      }

      // Fire-and-forget: auto-import relevant experiences from other projects
      try {
        const importResult = this.experienceRouter.autoImport();
        if (importResult.imported > 0 && this.logger) {
          this.logger.info('ExperienceRouter', `Auto-imported ${importResult.imported} experience(s)`, {
            sources: importResult.sources,
            skipped: importResult.skipped,
          });
        }
      } catch (routerErr) {
        console.warn(`[Orchestrator] ⚠️  ExperienceRouter auto-import failed (non-fatal): ${routerErr.message}`);
      }
    }
  },

  /**
   * ADR-30 P1: Detects the project's tech stack from AGENTS.md and skill files.
   * Used to construct targeted web search queries for experience preheating.
   * @returns {string[]} Array of tech stack terms (e.g. ['React', 'TypeScript', 'Next.js'])
   */
  _detectTechStackForPreheat() {
    const techPattern = /\b(?:React|Vue|Angular|Next\.js|Nuxt|Svelte|Express|Fastify|Koa|NestJS|Django|Flask|FastAPI|Spring\s?Boot|Laravel|Rails|Prisma|TypeORM|Sequelize|Mongoose|TailwindCSS|Bootstrap|Redis|MongoDB|PostgreSQL|MySQL|SQLite|GraphQL|gRPC|Docker|Kubernetes|TypeScript|JavaScript|Python|Java|Go|Rust|Lua|C#|Unity|Flutter|Dart|Swift|Kotlin|Electron|Tauri)\b/gi;
    let source = this._agentsMdContent || '';
    // Also scan skill filenames for domain hints
    try {
      const PATHS = require('./constants').PATHS;
      const skillFiles = require('fs').readdirSync(PATHS.SKILLS_DIR).filter(f => f.endsWith('.md'));
      source += ' ' + skillFiles.map(f => f.replace('.md', '').replace(/-/g, ' ')).join(' ');
    } catch (_) { /* non-fatal */ }
    const matches = source.match(techPattern) || [];
    return [...new Set(matches.map(t => t.trim()))].slice(0, 6);
  },

  /**
   * ADR-30 P1: Detects the project type (frontend/backend/fullstack/game/mobile).
   * @returns {string} Project type string
   */
  _detectProjectType() {
    const content = (this._agentsMdContent || '').toLowerCase();
    if (/\bgame\b|\bunity\b|\bgodot\b|\bunreal\b|\bcocos\b/.test(content)) return 'game';
    if (/\bmobile\b|\bflutter\b|\breact\s?native\b|\bswiftui\b|\bkotlin\b/.test(content)) return 'mobile';
    if (/\bfrontend\b|\breact\b|\bvue\b|\bangular\b|\bsvelte\b/.test(content)) {
      if (/\bbackend\b|\bapi\b|\bserver\b|\bdatabase\b/.test(content)) return 'fullstack';
      return 'frontend';
    }
    if (/\bbackend\b|\bapi\b|\bserver\b|\bmicroservice\b/.test(content)) return 'backend';
    return 'general';
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
    // ── Smart Trigger: determine which evolution modules should run ───────────
    // Avoids unnecessary token consumption by only running modules when conditions
    // indicate they will produce meaningful results.
    const shouldEvolve = this._shouldTriggerEvolution();

    // Flush all in-memory risk entries to the manifest checkpoint
    if (this.stateMachine.flushRisks) {
      this.stateMachine.flushRisks();
    }

    // Persist the inter-agent communication log
    this.bus.saveLog();

    // P0-B: Check FileRefBus contract violations and record them as risks.
    // Previously, contract violations were detected and logged as warnings during
    // publish(), but never checked at workflow finalization — they were silently
    // ignored. Now we surface them as formal risks in the manifest so they're
    // visible in the RISK SUMMARY and HTML report.
    const contractViolations = this.bus.getContractViolations();
    if (contractViolations.length > 0) {
      console.warn(`[Orchestrator] ⚠️  ${contractViolations.length} FileRefBus contract violation(s) detected during this run:`);
      for (const v of contractViolations) {
        const desc = `[ContractViolation] ${v.from}→${v.to}: ${v.reason.slice(0, 200)}`;
        console.warn(`  - ${desc}`);
        this.stateMachine.recordRisk('medium', desc, false);
      }
    }

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
    // Smart Trigger: only run if there are open complaints or negative experiences.
    if (this.complaintWall && this.skillEvolution && this.experienceStore && shouldEvolve.aefRefinement) {
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
    } else if (this.complaintWall && !shouldEvolve.aefRefinement) {
      console.log(`[Orchestrator] ⏭️  AEF Self-Refinement skipped (no open complaints or negative experiences)`);
    }

    // ── ADR-43: Session Signal Detection + Quality Scoring ──────────────────
    // Automatic capture of "pitfall moments" from workflow sessions.
    // Only runs if session has meaningful signals (errors, retries, complaints).
    if (this._sessionSignalDetector && this.experienceStore) {
      try {
        // 1. Gather session context for signal detection
        const decisionLogContent = this.decisionTrail
          ? this.decisionTrail.getTimeline().map(t => `${t.stage}: ${t.decision}`).join('\n')
          : '';
        const errorLogContent = this.complaintWall
          ? this.complaintWall.getOpenComplaints().map(c => c.description).join('\n')
          : '';

        // 2. Detect signals from session
        const signalResult = this._sessionSignalDetector.detectSignals({
          decisionLog: decisionLogContent,
          errorLog: errorLogContent,
        });

        // 3. Score session quality
        const qualityScorer = new SessionQualityScorer({
          experienceStore: this.experienceStore,
          verbose: this._verbose,
        });
        const qualityResult = qualityScorer.scoreWithSignals(
          { decisionLog: decisionLogContent, errorLog: errorLogContent },
          signalResult
        );

        // 4. Capture experience if warranted
        if (qualityResult.shouldCapture && signalResult.signals.length > 0) {
          console.log(`\n${'─'.repeat(60)}`);
          console.log(`  🎯 SESSION SIGNAL CAPTURE (ADR-43)`);
          console.log(`${'─'.repeat(60)}`);
          console.log(`  Signals: ${signalResult.signals.length} (score: ${signalResult.score.toFixed(2)})`);
          console.log(`  Quality: ${qualityResult.qualityScore.toFixed(2)}`);
          console.log(`  Reason: ${qualityResult.reason}`);
          console.log(`${'─'.repeat(60)}\n`);

          // 5. Extract experience using LLM (only if signals detected)
          if (this._rawLlmCall && signalResult.signals.length > 0) {
            const extractionPrompt = this._sessionSignalDetector.buildExtractionPrompt({
              decisionLog: decisionLogContent,
              errorLog: errorLogContent,
            });

            this._rawLlmCall(extractionPrompt, 'session-signal-extraction')
              .then(response => {
                if (!response) return;

                // Parse JSON response
                let extracted = null;
                try {
                  let cleaned = response.trim();
                  if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
                  else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
                  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
                  const startIdx = cleaned.indexOf('{');
                  const endIdx = cleaned.lastIndexOf('}');
                  if (startIdx !== -1 && endIdx !== -1) {
                    extracted = JSON.parse(cleaned.slice(startIdx, endIdx + 1));
                  }
                } catch (_) { /* parse error, ignore */ }

                // Record extracted experiences
                if (extracted && extracted.experiences && Array.isArray(extracted.experiences)) {
                  for (const exp of extracted.experiences.slice(0, 2)) {
                    if (!exp.title || !exp.content) continue;

                    // Ensure category is in PRACTICE layer
                    const category = exp.category || 'pitfall';
                    const layer = getLayerForCategory(category);

                    this.experienceStore.record({
                      type: exp.type || 'negative',
                      category,
                      title: exp.title,
                      content: `${exp.content}\n> _Source: Session Signal Detection (ADR-43)_`,
                      tags: [...(exp.tags || []), 'signal-captured', `layer:${layer}`],
                      ttlDays: exp.type === 'negative' ? 90 : 180,
                    });

                    console.log(`[Orchestrator] 📝 Captured experience: "${exp.title.slice(0, 50)}..." (layer: ${layer})`);
                  }
                }
              })
              .catch(err => {
                console.warn(`[Orchestrator] ⚠️  Signal extraction failed (non-fatal): ${err.message}`);
              });
          }
        } else {
          console.log(`[Orchestrator] ⏭️  Session Signal Capture skipped (${qualityResult.reason})`);
        }

        // 6. Check experience store layer health
        if (this.experienceStore.checkLayerHealth) {
          const layerHealth = this.experienceStore.checkLayerHealth(0.5);
          if (!layerHealth.healthy) {
            console.warn(`[Orchestrator] ⚠️  ${layerHealth.recommendation}`);
          }
        }

        // 7. Reset detector for next session
        this._sessionSignalDetector.reset();
      } catch (ssErr) {
        console.warn(`[Orchestrator] ⚠️  Session Signal Detection failed (non-fatal): ${ssErr.message}`);
      }
    }

    // ── Prompt A/B: snapshot variant stats into Observability before flush ──
    if (this.promptSlotManager) {
      this.obs.recordPromptVariantUsage(this.promptSlotManager.getStats());
    }

    // ── Adapter Telemetry: snapshot block lifecycle stats into Observability ──
    if (this._adapterTelemetry) {
      try {
        const telemetryReport = this._adapterTelemetry.getReport();
        this.obs.recordBlockTelemetry(telemetryReport);
        if (telemetryReport.recommendations.length > 0) {
          console.log(`[Orchestrator] 📊 Adapter telemetry: ${telemetryReport.recommendations.length} recommendation(s):`);
          for (const rec of telemetryReport.recommendations.slice(0, 5)) {
            console.log(`  → ${rec}`);
          }
        }
        if (telemetryReport.summary.totalSavedByCompression > 0) {
          console.log(`[Orchestrator] 🗜️  Total compression savings: ${telemetryReport.summary.totalSavedByCompression} chars across ${telemetryReport.summary.totalBlocks} block(s).`);
        }
      } catch (telErr) {
        console.warn(`[Orchestrator] ⚠️  Adapter telemetry report failed (non-fatal): ${telErr.message}`);
      }
    }

    // ── P1 Self-Reflection: Quality Gate Validation + Proactive Audit ────────
    // This is the integration point where SelfReflectionEngine hooks into the
    // workflow lifecycle. It runs AFTER all stages complete but BEFORE the
    // Observability flush, so gating results are captured in the session report.
    // Smart Trigger: only run if there are errors or the workflow took long.
    if (this._selfReflection && shouldEvolve.selfReflection) {
      try {
        // Step 1: Flush current metrics snapshot for validation
        const preFlushMetrics = this.obs.getMetricsSnapshot ? this.obs.getMetricsSnapshot() : null;

        // Step 2: Run quality gate validation against current session
        if (preFlushMetrics) {
          const gatingResult = this._selfReflection.validateRun(preFlushMetrics);
          this.obs.recordReflectionGating(gatingResult);

          if (!gatingResult.passed) {
            console.warn(`[Orchestrator] ❌ Self-Reflection: ${gatingResult.gates.filter(g => !g.passed).length} quality gate(s) failed.`);
          }
        }

        // Step 3: Run proactive health audit (cross-session anomaly detection)
        const auditResult = this._selfReflection.auditHealth();
        if (auditResult.findings.length > 0) {
          console.log(`[Orchestrator] 🔍 Self-Reflection health audit: ${auditResult.findings.length} finding(s)`);
        }

        // Step 4: Flush reflection data to disk
        this._selfReflection.flush();
      } catch (srErr) {
        console.warn(`[Orchestrator] ⚠️  Self-Reflection integration failed (non-fatal): ${srErr.message}`);
      }
    } else if (this._selfReflection && !shouldEvolve.selfReflection) {
      // Log skip reason for observability
      console.log(`[Orchestrator] ⏭️  Self-Reflection skipped (no errors, short session)`);
    }

    // ── P0 Prompt Tracing: flush prompt trace digests to prompt-traces.jsonl ──
    // Must run BEFORE obs.flush() so the promptTraceSummary in run-metrics.json
    // accurately reflects the number of traces that were persisted.
    try {
      const tracesWritten = this.obs.flushPromptTraces();
      if (tracesWritten > 0) {
        console.log(`[Orchestrator] 📝 Prompt traces: ${tracesWritten} trace(s) persisted for replay & debugging.`);
      }
    } catch (ptErr) {
      console.warn(`[Orchestrator] ⚠️  Prompt trace flush failed (non-fatal): ${ptErr.message}`);
    }

    // ── Direction 1+2: RunGuard summary — cost analysis & execution guard report ──
    // Prints a structured summary of LLM call counts, token usage, cost, and
    // any tier downgrades that occurred during execution.
    if (this.runGuard) {
      try {
        const guardSummary = this.runGuard.formatSummary();
        if (guardSummary) {
          console.log(guardSummary);
        }
        // Record RunGuard metrics into Observability for cross-session analysis
        if (this.obs.recordRunGuardSummary) {
          this.obs.recordRunGuardSummary(this.runGuard.getSummary());
        }
      } catch (rgErr) {
        console.warn(`[Orchestrator] ⚠️  RunGuard summary failed (non-fatal): ${rgErr.message}`);
      }
    }

    // ── Direction 4: DecisionTrail — print structured decision timeline ──
    // Shows the complete chain of decisions made during this workflow run,
    // grouped by stage, with evidence and outcomes for each decision.
    if (this.decisionTrail) {
      try {
        const timeline = this.decisionTrail.formatTimeline();
        if (timeline) {
          console.log(timeline);
        }
      } catch (dtErr) {
        console.warn(`[Orchestrator] ⚠️  DecisionTrail summary failed (non-fatal): ${dtErr.message}`);
      }
    }

    // ── Direction 5: StageSmartSkip — print skip summary ──
    // Shows which stages were skipped and why (complexity assessment).
    if (this.stageSmartSkip) {
      try {
        const skipSummary = this.stageSmartSkip.formatSummary();
        if (skipSummary) {
          console.log(skipSummary);
        }
      } catch (ssErr) {
        console.warn(`[Orchestrator] ⚠️  StageSmartSkip summary failed (non-fatal): ${ssErr.message}`);
      }
    }

    // ── Skill Lifecycle: sync usage stats to SkillEvolutionEngine registry ──
    // Transfers per-session skill injection/effectiveness data from Observability
    // to the persistent SkillEvolutionEngine registry, enabling cross-session
    // effectiveness tracking, stale skill detection, and retirement.
    if (this.skillEvolution && this.obs._skillInjectedCounts) {
      try {
        for (const [skillName, count] of this.obs._skillInjectedCounts) {
          this.skillEvolution.recordUsage(skillName, count);
        }
        for (const skillName of this.obs._skillEffectiveSet) {
          this.skillEvolution.recordEffective(skillName);
        }
        this.skillEvolution.flushLifecycleStats();

        // Run stale skill detection (dry-run by default — logs findings)
        const { stale } = this.skillEvolution.retireStaleSkills({ dryRun: true });
        if (stale.length > 0) {
          console.log(`[Orchestrator] 📦 Stale skill detection: ${stale.length} skill(s) underperforming:`);
          for (const s of stale) {
            const hr = ((s.effectiveCount || 0) / (s.usageCount || 1) * 100).toFixed(0);
            console.log(`[Orchestrator]   - ${s.name}: ${hr}% effective (${s.usageCount} uses)`);
          }
        }

        // ── ADR-32 P4: Stale Skill Auto-Refresh ──────────────────────────
        // Skills that haven't been evolved in >90 days are auto-enriched from
        // external knowledge, similar to CDN cache refresh. This completes the
        // self-evolution loop: stale detection → auto re-enrichment → fresh knowledge.
        // Fire-and-forget: must not block the finalize pipeline.
        if (this.skillEvolution) {
          try {
            const STALE_DAYS = 90;
            const now = Date.now();
            const refreshCandidates = [];

            for (const meta of this.skillEvolution.registry.values()) {
              if (meta.retiredAt) continue;
              const lastEvolved = meta.lastEvolvedAt ? new Date(meta.lastEvolvedAt).getTime() : 0;
              const created = meta.createdAt ? new Date(meta.createdAt).getTime() : 0;
              const latestActivity = Math.max(lastEvolved, created);
              const daysSince = latestActivity > 0 ? (now - latestActivity) / (24 * 60 * 60 * 1000) : Infinity;

              if (daysSince > STALE_DAYS && (meta.usageCount || 0) > 0) {
                refreshCandidates.push(meta.name);
              }
            }

            if (refreshCandidates.length > 0) {
              console.log(`[Orchestrator] 🔄 Auto-refreshing ${refreshCandidates.length} stale skill(s): [${refreshCandidates.slice(0, 5).join(', ')}${refreshCandidates.length > 5 ? '...' : ''}]`);
              // Refresh top 3 stale skills (fire-and-forget, rate-limited by _enrichmentState)
              const { enrichSkillFromExternalKnowledge } = require('./context-budget-manager');
              for (const skillName of refreshCandidates.slice(0, 3)) {
                enrichSkillFromExternalKnowledge(this, skillName, { maxSearchResults: 3, maxFetchPages: 2 })
                  .then(r => {
                    if (r.success && r.sectionsAdded > 0) {
                      console.log(`[Orchestrator] 🔄→📝 Auto-refreshed stale skill "${skillName}": ${r.sectionsAdded} entries updated.`);
                    }
                  })
                  .catch(() => { /* non-fatal */ });
              }
            }
          } catch (refreshErr) {
            console.warn(`[Orchestrator] ⚠️ Stale skill auto-refresh failed (non-fatal): ${refreshErr.message}`);
          }
        }
      } catch (skillSyncErr) {
        console.warn(`[Orchestrator] ⚠️  Skill lifecycle sync failed (non-fatal): ${skillSyncErr.message}`);
      }
    }

    // ── Defect #3 fix: flush metrics BEFORE printDashboard ──────────────────
    try {
      this.obs.flush();
    } catch (flushErr) {
      console.warn(`[Orchestrator] ⚠️  Observability flush failed (non-fatal): ${flushErr.message}`);
    }

    // ── P1 ADR-34: YELLOW Tier Auto-Deploy (config param adjustment) ─────────
    // After metrics are flushed, re-derive the adaptive strategy from updated
    // history and auto-apply any config parameter changes to workflow.config.js.
    // This closes the loop: run workflow → collect metrics → adjust config → next run.
    // Smart Trigger: only run if strategy source is not 'defaults' (i.e., we have history).
    if (this.autoDeployer && shouldEvolve.autoDeploy) {
      try {
        const Observability = require('./observability');
        const cfgAutoFix = (this._config && this._config.autoFixLoop) || {};
        const postRunStrategy = Observability.deriveStrategy(this._outputDir, {
          maxFixRounds:    cfgAutoFix.maxFixRounds    ?? 2,
          maxReviewRounds: cfgAutoFix.maxReviewRounds ?? 2,
          maxExpInjected:  cfgAutoFix.maxExpInjected  ?? 5,
          projectId:       this.projectId,
        });

        if (postRunStrategy.source !== 'defaults') {
          const yellowResult = this.autoDeployer.applyYellow(postRunStrategy);
          if (yellowResult.applied && yellowResult.changes.length > 0) {
            console.log(`[Orchestrator] 🟡 Auto-Deploy: ${yellowResult.changes.length} config param(s) updated for next run.`);
          }
        }
      } catch (adErr) {
        console.warn(`[Orchestrator] ⚠️  Auto-Deploy (YELLOW) failed (non-fatal): ${adErr.message}`);
      }
    } else if (this.autoDeployer && !shouldEvolve.autoDeploy) {
      console.log(`[Orchestrator] ⏭️  Auto-Deploy YELLOW skipped (no strategy history)`);
    }

    // Print Observability dashboard (session metrics summary)
    try {
      this.obs.printDashboard();
    } catch (dashErr) {
      console.warn(`[Orchestrator] ⚠️  Observability dashboard failed (non-fatal): ${dashErr.message}`);
    }

    // Generate HTML visualisation report (interactive session audit trail)
    try {
      const reportPath = this.obs.generateHTMLReport();
      console.log(`[Orchestrator] 📊 HTML session report: ${reportPath}`);
    } catch (htmlErr) {
      console.warn(`[Orchestrator] ⚠️  HTML report generation failed (non-fatal): ${htmlErr.message}`);
    }

    // P3 fix: Generate cross-session trends report (long-term evolution tracking)
    try {
      const ObsStrategy = require('./observability-strategy');
      const history = ObsStrategy.loadHistory(PATHS.OUTPUT_DIR);
      const trendsPath = ObsStrategy.generateTrendsReport(history, PATHS.OUTPUT_DIR);
      if (trendsPath) {
        console.log(`[Orchestrator] 📈 Cross-session trends report: ${trendsPath}`);
      }
    } catch (trendsErr) {
      console.warn(`[Orchestrator] ⚠️  Trends report generation failed (non-fatal): ${trendsErr.message}`);
    }

    // ── P3 Cross-Stage Risk Correlation Analysis ─────────────────────────────
    // Inspired by the white-box audit methodology's "attack chain" thinking:
    // individual risks across different stages can combine into compound risks
    // greater than the sum of their parts (Swiss Cheese Model).
    //
    // This analysis runs BEFORE the RISK SUMMARY so correlated risks are
    // included in the final report and visible to the user.
    const risks = this.stateMachine.getRisks ? this.stateMachine.getRisks() : [];
    if (risks.length >= 2) {
      try {
        const correlatedRisks = _analyseRiskCorrelations(risks, this.stageCtx);
        if (correlatedRisks.length > 0) {
          console.warn(`\n${'─'.repeat(60)}`);
          console.warn(`  🔗 RISK CORRELATION ANALYSIS (${correlatedRisks.length} chain(s) found)`);
          console.warn(`${'─'.repeat(60)}`);
          for (const chain of correlatedRisks) {
            console.warn(`  ⛓️  [${chain.severity.toUpperCase()}] ${chain.label}`);
            console.warn(`      Contributing factors:`);
            for (const factor of chain.factors) {
              console.warn(`        → [${factor.stage}] ${factor.description.slice(0, 120)}`);
            }
            console.warn(`      Impact: ${chain.impact}`);
            if (chain.recommendation) {
              console.warn(`      Recommendation: ${chain.recommendation}`);
            }
            // Record the correlated risk as a new risk entry for traceability
            this.stateMachine.recordRisk(chain.severity,
              `[RiskCorrelation] ${chain.label}: ${chain.factors.map(f => f.description.slice(0, 60)).join(' + ')}. Impact: ${chain.impact}`,
              false
            );
          }
          console.warn(`${'─'.repeat(60)}`);
          this.stateMachine.flushRisks();
        }
      } catch (corrErr) {
        console.warn(`[Orchestrator] ⚠️  Risk correlation analysis failed (non-fatal): ${corrErr.message}`);
      }
    }

    // Print accumulated risk summary (now includes correlated risks from P3 above)
    const allRisks = this.stateMachine.getRisks ? this.stateMachine.getRisks() : [];
    if (allRisks.length > 0) {
      console.warn(`\n${'─'.repeat(60)}`);
      console.warn(`  ⚠️  RISK SUMMARY (${allRisks.length} item(s))`);
      console.warn(`${'─'.repeat(60)}`);
      for (const r of allRisks) {
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

    // ── Optimistic lock: report conflicts and reset ────────────────────────
    try {
      const { fileLockManager } = require('./file-lock-manager');
      const lockStats = fileLockManager.getStats();
      if (lockStats.conflicts > 0) {
        console.warn(`\n${'─'.repeat(60)}`);
        console.warn(`  🔒 OPTIMISTIC LOCK SUMMARY`);
        console.warn(`  Tracked files: ${lockStats.trackedFiles} | Conflicts: ${lockStats.conflicts}`);
        for (const c of fileLockManager.getConflicts().slice(-5)) {
          console.warn(`  [${c.acquiredBy}→${c.conflictBy}] ${path.basename(c.file)}`);
        }
        console.warn(`${'─'.repeat(60)}\n`);
      }
      fileLockManager.reset();
    } catch (err) { console.warn(`[Orchestrator] fileLockManager.reset() failed: ${err.message}`); }

    // ── DocGen: Auto-generate CHANGELOG.md ──────────────────────────────────
    // After all stages complete, generate a CHANGELOG entry from git log
    // and append it to CHANGELOG.md. This runs before git PR workflow so the
    // CHANGELOG is included in the PR commit.
    try {
      if (this.services && this.services.has('mcpRegistry')) {
        const registry = this.services.resolve('mcpRegistry');
        let docGenAdapter;
        try { docGenAdapter = registry.get('doc-gen'); } catch (_) { /* not registered */ }
        if (docGenAdapter && docGenAdapter.isConnected) {
          const changelogResult = await docGenAdapter.generateChangelog();
          if (changelogResult.markdown && changelogResult.entries.length > 0) {
            const changelogPath = docGenAdapter.appendChangelog(changelogResult.markdown);
            if (changelogPath) {
              console.log(`[Orchestrator] 📝 CHANGELOG.md auto-updated: ${changelogResult.entries.length} commit(s) for v${changelogResult.version}.`);
            }
          }
        }
      }
    } catch (clErr) {
      console.warn(`[Orchestrator] ⚠️  CHANGELOG auto-generation failed (non-fatal): ${clErr.message}`);
    }

    // ── P1-2: Flush NegotiationEngine log ────────────────────────────────────
    // Persist negotiation entries (if any) so they're available for audit.
    if (this.negotiation) {
      try {
        const negLog = this.negotiation.getLog();
        if (negLog.length > 0) {
          this.negotiation.flush();
          console.log(`[Orchestrator] 🤝 NegotiationEngine: ${negLog.length} negotiation(s) persisted.`);
        }
      } catch (negErr) {
        console.warn(`[Orchestrator] ⚠️  NegotiationEngine flush failed (non-fatal): ${negErr.message}`);
      }
    }

    // ── P2-1: ExperienceRouter — publish high-value experiences ──────────────
    // After ExperienceStore is flushed, publish to the cross-project registry
    // so other projects can discover and import this project's experiences.
    if (this.experienceRouter) {
      try {
        const pubResult = this.experienceRouter.publish();
        if (pubResult.published > 0) {
          console.log(`[Orchestrator] 🌐 ExperienceRouter: published ${pubResult.published} experience(s) to cross-project registry.`);
        }
      } catch (pubErr) {
        console.warn(`[Orchestrator] ⚠️  ExperienceRouter publish failed (non-fatal): ${pubErr.message}`);
      }
    }

    // ── P2-1: EventJournal — flush and close ────────────────────────────────
    // Must run before Logger flush: EventJournal captures the close event and
    // writes its summary before the Logger captures the final log line.
    if (this.eventJournal) {
      try {
        await this.eventJournal.close();
        const stats = this.eventJournal.getStats();
        console.log(`[Orchestrator] 📖 EventJournal: ${stats.totalEvents} events captured in ${path.basename(this.eventJournal.journalPath)}`);
      } catch (ejErr) {
        console.warn(`[Orchestrator] ⚠️  EventJournal close failed (non-fatal): ${ejErr.message}`);
      }
    }

    // ── P1-4: Structured Logger — flush and close ───────────────────────────
    // Must be last: all other modules should have logged by now.
    if (this.logger) {
      try {
        this.logger.info('Orchestrator', 'Workflow finalisation complete', {
          mode,
          projectId: this.projectId,
        });
        const entryCount = this.logger.flush();
        if (entryCount > 0) {
          console.log(`[Orchestrator] 📝 Structured Logger: ${entryCount} log entries written to workflow.log.jsonl`);
        }
      } catch (logErr) {
        console.warn(`[Orchestrator] ⚠️  Logger flush failed (non-fatal): ${logErr.message}`);
      }
    }

    // ── Git PR workflow ──────────────────────────────────────────────────────
    if (this._gitOptions.enabled && !this.dryRun) {
      await this._runGitPRWorkflow(mode, extra);
    }

    // ── P0 MAPE Engine: Self-Adaptive Closed-Loop ───────────────────────────
    // Runs the MAPE cycle (Monitor-Analyze-Plan-Execute) to detect anomalies,
    // identify root causes, and automatically apply fixes. This closes the
    // self-adaptive loop: run workflow → detect issues → auto-fix → next run.
    // Reference: ADR-35 MAPE Engine for Self-Adaptive Workflow Optimization.
    // Smart Trigger: only run if there are anomaly signals or metrics history.
    if (shouldEvolve.mape) {
      try {
        const { MAPEEngine } = require('./mape-engine');
        const mape = new MAPEEngine({ orchestrator: this, verbose: this._verbose });

        // Run MAPE cycle in dry-run mode first to see what actions would be taken
        const mapeReport = await mape.runCycle({ dryRun: false, maxActions: 5 });

        if (mapeReport.phases.monitor.signalCount > 0) {
          console.log(`[Orchestrator] 🔄 MAPE Engine: ${mapeReport.phases.monitor.signalCount} signal(s) detected`);
          console.log(`[Orchestrator]    → ${mapeReport.phases.analyze.rootCauses} root cause(s), ${mapeReport.phases.analyze.correlations} correlation(s)`);
          console.log(`[Orchestrator]    → ${mapeReport.phases.execute.executed} action(s) executed, ${mapeReport.phases.execute.skipped} skipped`);
        }

        // Record MAPE results in observability for cross-session tracking
        if (this.obs && typeof this.obs.recordCustomMetric === 'function') {
          this.obs.recordCustomMetric('mape_cycle', {
            signalCount: mapeReport.phases.monitor.signalCount,
            rootCauses: mapeReport.phases.analyze.rootCauses,
            correlations: mapeReport.phases.analyze.correlations,
            executed: mapeReport.phases.execute.executed,
            elapsed: mapeReport.elapsed,
          });
        }
      } catch (mapeErr) {
        console.warn(`[Orchestrator] ⚠️  MAPE Engine cycle failed (non-fatal): ${mapeErr.message}`);
      }
    } else {
      console.log(`[Orchestrator] ⏭️  MAPE Engine skipped (no anomaly signals or insufficient history)`);
    }

    // ── Sleeptime Maintenance Pipeline ───────────────────────────────────────
    // Unified orchestration of distill/purge/retire/audit. Replaces scattered
    // calls with a single pipeline. Runs after Git PR so maintenance doesn't
    // block the primary deliverable.
    // Smart Trigger: only run if there are enough experiences or skills to maintain.
    if (shouldEvolve.sleeptime) {
      try {
        const { sleeptime } = require('./sleeptime');
        const sleeptimeResult = sleeptime({
          experienceStore: this.experienceStore,
          skillEvolution: this.skillEvolution,
          selfReflection: this._selfReflection,
          verbose: true,
        });
        // Record sleeptime results in observability for cross-session tracking
        if (this.obs && typeof this.obs.recordCustomMetric === 'function') {
          this.obs.recordCustomMetric('sleeptime', {
            totalDurationMs: sleeptimeResult.totalDurationMs,
            stages: sleeptimeResult.stages.map(s => ({ name: s.name, status: s.status })),
          });
        }
      } catch (stErr) {
        console.warn(`[Orchestrator] ⚠️  Sleeptime pipeline failed (non-fatal): ${stErr.message}`);
      }
    } else {
      console.log(`[Orchestrator] ⏭️  Sleeptime skipped (low experience/skill count)`);
    }

    // ── Recall Memory: record task history for cross-session continuity ──────
    try {
      const { TaskHistory } = require('./task-history');
      const taskHistory = new TaskHistory();
      const metrics = this.obs.getMetricsSnapshot ? this.obs.getMetricsSnapshot() : {};
      const allTasks = this.taskManager ? this.taskManager.getAllTasks() : [];
      const doneTasks = allTasks.filter(t => t.status === 'done');
      const failedTasks = allTasks.filter(t => t.status === 'failed' || t.status === 'exhausted');
      const outcome = failedTasks.length === 0 ? 'success'
                    : doneTasks.length > 0 ? 'partial'
                    : 'failed';
      taskHistory.record({
        mode,
        goal: extra.goal || this._currentRequirement || '',
        projectId: this.projectId,
        taskCount: allTasks.length,
        taskTitles: doneTasks.map(t => t.title || '').slice(0, 10),
        outcome,
        metrics: {
          durationMs: metrics.totalDurationMs || (Date.now() - (this.obs._startedAt || Date.now())),
          errorCount: (metrics.errors && metrics.errors.count) || 0,
          expRecorded: this.experienceStore ? this.experienceStore.getStats().total : 0,
        },
      });
      console.log(`[Orchestrator] 📖 Task history recorded for recall memory (${taskHistory.getStats().totalEntries} total entries).`);

      // Trigger incremental arch-knowledge-cache rebuild after task-history update
      try {
        const { rebuildCache } = require('./arch-knowledge-cache');
        rebuildCache(this.projectRoot, { projectProfile: this._config && this._config.projectProfile });
      } catch (cacheErr) {
        console.warn(`[Orchestrator] ⚠️  Arch knowledge cache rebuild failed (non-fatal): ${cacheErr.message}`);
      }
    } catch (thErr) {
      console.warn(`[Orchestrator] ⚠️  Task history recording failed (non-fatal): ${thErr.message}`);
    }

    // ── ADR-38: TechRadar Staleness Check ─────────────────────────────────────
    // Remind user to run /techradar if >7 days since last tech scan.
    // This follows the same pattern as Stale Skill Auto-Refresh (ADR-32 P4).
    // Condition-triggered: zero daemon, zero background processes.
    try {
      const { isTechRadarStale } = require('./techradar');
      const staleness = isTechRadarStale(this._manifest && this._manifest.meta);

      if (staleness.isStale) {
        const daysText = staleness.daysSince === Infinity ? 'never' : `${staleness.daysSince} days`;
        console.log(`[Orchestrator] 🔔 TechRadar: ${daysText} since last tech scan.`);
        console.log(`[Orchestrator]    Run /techradar to discover new techniques and evaluate upgrades.`);
      }
    } catch (trErr) {
      // Non-fatal: TechRadar module may not be available
    }

    // ── ADR-32 P3: ArticleScout Staleness Check ───────────────────────────────
    // Remind user to run /article-scout if >14 days since last article discovery.
    // Complements TechRadar: TechRadar focuses on tech upgrades, ArticleScout on knowledge articles.
    try {
      const { isArticleScoutStale } = require('./article-scout');
      const staleness = isArticleScoutStale(this._manifest && this._manifest.meta);

      if (staleness.isStale) {
        const daysText = staleness.daysSince === Infinity ? 'never' : `${staleness.daysSince} days`;
        console.log(`[Orchestrator] 🔔 ArticleScout: ${daysText} since last article discovery.`);
        console.log(`[Orchestrator]    Run /article-scout to discover high-value AI/Agent articles.`);
      }
    } catch (asErr) {
      // Non-fatal: ArticleScout module may not be available
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
   *
   * P1 Recovery Hook: Transient errors (network timeouts, LLM rate limits,
   * temporary file system issues) are automatically retried with exponential
   * backoff. Fatal errors (logic errors, assertion failures) are immediately
   * propagated. This prevents long-running workflows from aborting due to
   * momentary infrastructure hiccups.
   *
   * Retry policy:
   *   - Max retries: 2 (configurable via this._adaptiveStrategy)
   *   - Backoff: exponential (2s, 6s) with jitter
   *   - Only transient errors are retried (classifyError())
   *   - Each retry is recorded in Observability for cross-session analysis
   *   - Recovery events are recorded as experiences for future learning
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

    // Recovery Hook configuration
    const MAX_STAGE_RETRIES = (this._adaptiveStrategy && this._adaptiveStrategy.maxStageRetries) || 2;
    const BASE_BACKOFF_MS = 2000; // 2 seconds base

    // P0-2: Stage budget ceiling — maximum allowed execution time per stage attempt.
    // Reference: Temporal Activity heartbeat timeout — if no progress after N seconds, abort.
    // Default: 10 minutes. Configurable via workflow.config.js adaptiveStrategy.maxStageDurationMs.
    const MAX_STAGE_DURATION_MS = (this._adaptiveStrategy && this._adaptiveStrategy.maxStageDurationMs) || 10 * 60 * 1000;

    // P0-3: Heartbeat interval — emit STAGE_HEARTBEAT every N ms during execution.
    // Reference: Temporal Activity heartbeat — periodic liveness signal.
    const HEARTBEAT_INTERVAL_MS = (this._adaptiveStrategy && this._adaptiveStrategy.heartbeatIntervalMs) || 30 * 1000;

    // Observability: track stage timing
    const stageLabel = `${fromState}→${toState}`;
    this.obs.stageStart(stageLabel);
    // P1-4: Structured Logger integration – log stage lifecycle
    if (this.logger) {
      this.logger.info('Stage', `Stage started: ${stageLabel}`, { fromState, toState });
    }

    // ── Direction 1+2: RunGuard pre-stage check ─────────────────────────
    // Checks global execution limits (LLM calls, tokens, duration, budget).
    // If budget pressure is detected, automatically downgrades LlmRouter tier.
    // If hard limits are exceeded, throws RunGuardAbortError.
    if (this.runGuard) {
      try {
        const guardResult = this.runGuard.beforeStage(fromState, { llmRouter: this.llmRouter });
        if (guardResult.warnings.length > 0 && this.logger) {
          this.logger.warn('RunGuard', `Pre-stage warnings for ${fromState}`, { warnings: guardResult.warnings, tierMode: guardResult.tierMode });
        }
        // Direction 4: Record routing/resource decisions from RunGuard
        if (this.decisionTrail && guardResult.tierMode !== 'normal') {
          this.decisionTrail.record({
            category: 'routing',
            stage: fromState,
            action: 'tier_downgrade',
            reason: `RunGuard applied ${guardResult.tierMode} tier (${guardResult.warnings[0] || 'budget pressure'})`,
            evidence: { tierMode: guardResult.tierMode },
            outcome: 'tier_changed',
          });
        }
      } catch (guardErr) {        if (guardErr.code === 'RUN_GUARD_ABORT') {
          console.error(`[Orchestrator] 🛑 RunGuard aborted workflow before stage ${fromState}: ${guardErr.message}`);
          this.obs.stageEnd(stageLabel, 'aborted');
          throw guardErr;
        }
        // Non-RunGuard errors: log and continue (guard must not block execution)
        console.warn(`[Orchestrator] ⚠️  RunGuard.beforeStage failed (non-fatal): ${guardErr.message}`);
      }
    }

    let stageStatus = 'ok';
    let lastErr = null;

    // Direction 4: Record stage-enter decision in DecisionTrail
    let stageDecisionSeq = -1;
    if (this.decisionTrail) {
      stageDecisionSeq = this.decisionTrail.record({
        category: 'stage',
        stage: fromState,
        action: 'enter_stage',
        reason: `Executing stage ${stageLabel}`,
        evidence: null,
      });
    }

    try {
    for (let attempt = 0; attempt <= MAX_STAGE_RETRIES; attempt++) {
      try {
        // On retry attempts, log the retry with backoff info
        if (attempt > 0) {
          const backoffMs = BASE_BACKOFF_MS * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 1000);
          console.log(`[Orchestrator] 🔄 Recovery Hook: retrying stage ${stageLabel} (attempt ${attempt + 1}/${MAX_STAGE_RETRIES + 1}, backoff ${backoffMs}ms)...`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));

          // Record retry event in Observability
          if (this.obs.recordStageRetry) {
            this.obs.recordStageRetry(stageLabel, attempt, lastErr ? lastErr.message : 'unknown');
          }
        }

        // P0-2 + P0-3: Wrap stageRunner() with budget ceiling timeout and heartbeat.
        // - Budget Ceiling: if the stage doesn't complete within MAX_STAGE_DURATION_MS, abort.
        // - Heartbeat: emit STAGE_HEARTBEAT every HEARTBEAT_INTERVAL_MS during execution.
        const stageStartMs = Date.now();
        let heartbeatTimer = null;

        // P0-3: Start heartbeat interval
        if (this.hooks) {
          heartbeatTimer = setInterval(() => {
            const elapsedMs = Date.now() - stageStartMs;
            this.hooks.emit(HOOK_EVENTS.STAGE_HEARTBEAT, {
              stage: stageLabel,
              elapsedMs,
              attempt,
              maxDurationMs: MAX_STAGE_DURATION_MS,
            }).catch(() => {}); // fire-and-forget
          }, HEARTBEAT_INTERVAL_MS);
        }

        let stageResult;
        try {
          // P0-2: Race stageRunner against timeout
          stageResult = await Promise.race([
            stageRunner(),
            new Promise((_, reject) => {
              setTimeout(() => {
                const elapsedMs = Date.now() - stageStartMs;
                // Emit timeout event before rejecting
                if (this.hooks) {
                  this.hooks.emit(HOOK_EVENTS.STAGE_TIMEOUT, {
                    stage: stageLabel,
                    timeoutMs: MAX_STAGE_DURATION_MS,
                    elapsedMs,
                    attempt,
                  }).catch(() => {});
                }
                reject(new Error(
                  `[StageBudgetCeiling] Stage ${stageLabel} exceeded ${(MAX_STAGE_DURATION_MS / 1000 / 60).toFixed(1)}min budget ceiling (elapsed: ${(elapsedMs / 1000).toFixed(0)}s). ` +
                  `Aborting to prevent runaway execution. Configure via adaptiveStrategy.maxStageDurationMs.`
                ));
              }, MAX_STAGE_DURATION_MS);
            }),
          ]);
        } finally {
          // Always clean up heartbeat timer
          if (heartbeatTimer) clearInterval(heartbeatTimer);
        }

        // P1-3: Unified StageResult type handling
        // Supports both new StageResult.rolledBack() and legacy { __alreadyTransitioned } pattern
        const { StageResult } = require('./types');
        const alreadyTransitioned = StageResult.isRolledBack(stageResult) ||
          (stageResult && stageResult.__alreadyTransitioned === true);
        const artifactPath = StageResult.isStageResult(stageResult)
          ? StageResult.getArtifactPath(stageResult)
          : (alreadyTransitioned ? stageResult.artifactPath : stageResult);
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

        // If we succeeded on a retry, record the recovery as a positive experience
        if (attempt > 0) {
          console.log(`[Orchestrator] ✅ Recovery Hook: stage ${stageLabel} succeeded on attempt ${attempt + 1} (recovered from: ${lastErr ? lastErr.message.slice(0, 80) : 'unknown'})`);
          try {
            if (this.experienceStore) {
              const { ExperienceType, ExperienceCategory } = require('./experience-store');
              this.experienceStore.record({
                type: ExperienceType.POSITIVE,
                category: ExperienceCategory.STABLE_PATTERN,
                title: `Stage ${stageLabel} recovered after ${attempt} retry(ies)`,
                content: `Stage ${stageLabel} failed with transient error "${lastErr ? lastErr.message.slice(0, 200) : 'unknown'}" but recovered successfully after ${attempt} retry(ies) with exponential backoff.`,
                skill: 'workflow-orchestration',
                tags: ['recovery-hook', 'transient-error', 'retry-success'],
              });
            }
          } catch (_) { /* experience recording is non-fatal */ }
        }

        // ── Stage Output Report: show artifact summary to user ──────────
        // This makes the pipeline transparent — users see what each stage produced
        // instead of waiting blindly until the workflow completes.
        try {
          const { reportStageOutput } = require('./stage-output-reporter');
          const _outputDir = this._outputDir || PATHS.OUTPUT_DIR;
          reportStageOutput(toState, _outputDir, {
            artifactPath: typeof artifactPath === 'string' ? artifactPath : undefined,
            hookEmit: this.hooks ? this.hooks.emit.bind(this.hooks) : undefined,
          });
        } catch (_reportErr) { /* non-fatal: don't let reporting break the pipeline */ }

        // Success – break out of retry loop
        // Direction 4: Record stage-exit decision with outcome
        if (this.decisionTrail) {
          this.decisionTrail.setOutcome(stageDecisionSeq, attempt > 0 ? `success_after_${attempt}_retries` : 'success');
        }
        return;

      } catch (err) {
        lastErr = err;

        // Classify the error: is it transient (recoverable) or fatal?
        const { recoverable, category } = classifyError(err);

        if (!recoverable || attempt >= MAX_STAGE_RETRIES) {
          // Fatal error OR retry budget exhausted: propagate immediately
          stageStatus = 'error';
          this.obs.recordError(stageLabel, err.message);

          if (attempt > 0) {
          // We retried but still failed – record the failure pattern
          console.warn(`[Orchestrator] ❌ Recovery Hook: stage ${stageLabel} failed after ${attempt + 1} attempt(s). Error category: ${category}. Giving up.`);
          // Direction 4: Record retry-exhausted decision
          if (this.decisionTrail) {
            this.decisionTrail.record({
              category: 'recovery',
              stage: fromState,
              action: 'retry_exhausted',
              reason: `${stageLabel} failed after ${attempt + 1} attempts (${category}: ${err.message.slice(0, 100)})`,
              evidence: { attempts: attempt + 1, category },
              outcome: 'fatal_error',
            });
          }
            try {
              if (this.experienceStore) {
                const { ExperienceType, ExperienceCategory } = require('./experience-store');
                this.experienceStore.record({
                  type: ExperienceType.NEGATIVE,
                  category: ExperienceCategory.PITFALL,
                  title: `Stage ${stageLabel} failed after ${attempt + 1} attempt(s): ${category}`,
                  content: `Stage ${stageLabel} encountered error: "${err.message.slice(0, 200)}". Retried ${attempt} time(s) but did not recover. Error category: ${category}.`,
                  skill: 'workflow-orchestration',
                  tags: ['recovery-hook', 'retry-exhausted', category],
                });
              }
            } catch (_) { /* experience recording is non-fatal */ }
          }

          throw err;
        }

        // Transient error with retries remaining: log and continue to next attempt
        console.warn(`[Orchestrator] ⚠️  Recovery Hook: transient error in stage ${stageLabel} (category: ${category}). Will retry (attempt ${attempt + 1}/${MAX_STAGE_RETRIES + 1}).`);
        // Direction 4: Record retry decision
        if (this.decisionTrail) {
          this.decisionTrail.record({
            category: 'recovery',
            stage: fromState,
            action: 'retry_stage',
            reason: `Transient error (${category}): ${err.message.slice(0, 100)} — retrying`,
            evidence: { attempt: attempt + 1, maxAttempts: MAX_STAGE_RETRIES + 1, category },
          });
        }
        console.warn(`[Orchestrator]    Error: ${err.message.slice(0, 200)}`);
      }
    }

    // Should not reach here (loop always returns or throws), but guard against edge cases
    if (lastErr) {
      stageStatus = 'error';
      this.obs.recordError(stageLabel, lastErr.message);
      throw lastErr;
    }
  } finally {
    this.obs.stageEnd(stageLabel, stageStatus);
    // P1-4: Structured Logger – log stage completion
    if (this.logger) {
      const logFn = stageStatus === 'error' ? 'error' : 'info';
      this.logger[logFn]('Stage', `Stage ended: ${stageLabel} (${stageStatus})`, { fromState, toState, status: stageStatus });
    }
  }
  },

  /**
   * Rebuilds the code graph asynchronously (fire-and-forget).
   *
   * @param {string} trigger - Label for logging (e.g. 'post-developer')
   */
  _rebuildCodeGraphAsync(trigger = 'manual', { patchFiles = null, writeOutput = true, quickScan = false } = {}) {
    setImmediate(async () => {
      try {
        const buildOpts = { writeOutput };
        if (Array.isArray(patchFiles) && patchFiles.length > 0) {
          buildOpts.patchFiles = patchFiles;
        }
        if (quickScan) {
          buildOpts.quickScan = true;
        }
        const modeLabel = quickScan ? 'quick-scan' : (patchFiles ? `${patchFiles.length} patch files` : 'full');
        console.log(`[Orchestrator] 🔄 Code graph update triggered (${trigger}, ${modeLabel})...`);
        const result = await this.codeGraph.build(buildOpts);
        console.log(`[Orchestrator] ✅ Code graph updated: ${result.symbolCount} symbols, ${result.edgeCount} edges${result.patchMode ? ' (patch mode)' : ''}`);
        this.obs.recordCodeGraphResult(result);

        // LSP Enhancement: if an LSP adapter is connected, use it to replace
        // regex-based symbols with compiler-accurate data AND enhance call edges
        // for hotspot symbols via findReferences (Hybrid Strategy).
        // IDE-First: When running inside an IDE, LSP adapter is not connected
        // (skipped for IDE-native LSP). CodeGraph remains regex-based but the
        // AI Agent can use IDE tools (view_code_item, codebase_search) for
        // compiler-accurate data on-demand.
        let lspEnhanced = false;
        try {
          if (this.services && this.services.has('mcpRegistry')) {
            const registry = this.services.resolve('mcpRegistry');
            let lspAdapter;
            try { lspAdapter = registry.get('lsp'); } catch (_) { /* no LSP adapter */ }
            if (lspAdapter && lspAdapter._skippedForIDE) {
              // IDE-First mode: LSP adapter was registered but skipped because
              // IDE already provides LSP. CodeGraph uses regex-based indexing,
              // which is still functional. Agent uses IDE tools for precision.
              console.log(`[Orchestrator] 🏠 LSP enhancement skipped – IDE provides native LSP capabilities.`);
            } else if (lspAdapter && lspAdapter.isConnected) {
              // P1: Inject LSP adapter into CodeGraph for query-time on-demand enrichment
              this.codeGraph.setLSPAdapter(lspAdapter);

              const lspResult = await lspAdapter.enhanceCodeGraph(this.codeGraph, {
                maxFiles: 30,
                enhanceCallEdges: true,
                maxHotspots: 150,
                minCalledBy: 2,
              });
              if (lspResult.enhanced > 0 || lspResult.callEdgesEnhanced > 0) {
                console.log(`[Orchestrator] 🔬 LSP enhanced ${lspResult.enhanced} files with compiler-accurate symbols, ${lspResult.callEdgesEnhanced || 0} hotspot call edges refined.`);
                lspEnhanced = true;
              }
            }
          }
        } catch (lspErr) {
          console.warn(`[Orchestrator] LSP code graph enhancement failed (non-fatal): ${lspErr.message}`);
        }

        // If LSP enhanced the code graph (symbols or call edges), re-write output
        // so the disk file contains the improved data. Without this, LSP changes
        // would only exist in memory and be lost on restart.
        // Skip re-write when writeOutput=false (e.g. post-developer): the FINISHED
        // stage full rebuild will persist the final version anyway.
        if (lspEnhanced && writeOutput) {
          try {
            this.codeGraph._writeOutput();
            console.log(`[Orchestrator] 📄 Code graph re-written after LSP enhancement.`);
          } catch (writeErr) {
            console.warn(`[Orchestrator] Code graph re-write after LSP failed (non-fatal): ${writeErr.message}`);
          }
        } else if (lspEnhanced && !writeOutput) {
          console.log(`[Orchestrator] 📝 LSP enhancement applied in-memory (disk write deferred to FINISHED stage).`);
        }
      } catch (err) {
        console.warn(`[Orchestrator] Code graph update failed (non-fatal): ${err.message}`);
      }
    });
  },

  /**
   * Smart Trigger: determines which evolution modules should run based on current state.
   *
   * This is the core of the "conditional trigger" optimization. Instead of running all
   * evolution modules on every workflow completion, we check if there's meaningful work
   * to do. This avoids unnecessary token consumption and improves performance.
   *
   * Trigger conditions:
   *   - selfReflection: errorRate > 0 OR durationMs > 60s OR has quality gate history
   *   - aefRefinement: has open complaints OR has negative experiences
   *   - autoDeploy: has metrics history (source !== 'defaults')
   *   - mape: has anomaly signals OR has metrics history (>= 3 sessions)
   *   - sleeptime: experienceCount > 20 OR skillCount > 10
   *
   * @returns {{ selfReflection: boolean, aefRefinement: boolean, autoDeploy: boolean, mape: boolean, sleeptime: boolean }}
   */
  _shouldTriggerEvolution() {
    const metrics = this.obs?.getMetricsSnapshot?.() || {};
    const expStats = this.experienceStore?.getStats?.() || {};
    const skillCount = this.skillEvolution?.registry?.size || 0;
    const openComplaints = this.complaintWall?.getOpenComplaints?.() || [];
    const negativeExps = this.experienceStore?.getAll?.()?.filter(e => e.type === 'negative') || [];

    // Check metrics history for MAPE and Auto-Deploy
    let hasMetricsHistory = false;
    let historyLength = 0;
    try {
      const ObsStrategy = require('./observability-strategy');
      const history = ObsStrategy.loadHistory(this._outputDir || PATHS.OUTPUT_DIR);
      historyLength = history.length;
      hasMetricsHistory = historyLength >= 3;
    } catch (_) { /* non-fatal */ }

    // Check for anomaly signals (quick scan without full MAPE cycle)
    let hasAnomalySignals = false;
    try {
      const errorCount = (metrics.errors?.count || 0);
      const tokenTrend = metrics.tokenTrend || 0;
      const durationTrend = metrics.durationTrend || 0;
      hasAnomalySignals = errorCount > 0 || tokenTrend > 0.1 || durationTrend > 0.2;
    } catch (_) { /* non-fatal */ }

    // Determine triggers
    const selfReflection = (metrics.errors?.count || 0) > 0 ||
                           (metrics.totalDurationMs || 0) > 60000 ||
                           hasMetricsHistory;

    const aefRefinement = openComplaints.length > 0 || negativeExps.length > 0;

    const autoDeploy = hasMetricsHistory;

    const mape = hasAnomalySignals || hasMetricsHistory;

    const sleeptime = (expStats.total || 0) > 20 || skillCount > 10;

    // Log trigger decisions in verbose mode
    if (this._verbose) {
      console.log(`[Orchestrator] 🎯 Smart Trigger: selfReflection=${selfReflection}, aefRefinement=${aefRefinement}, autoDeploy=${autoDeploy}, mape=${mape}, sleeptime=${sleeptime}`);
    }

    return {
      selfReflection,
      aefRefinement,
      autoDeploy,
      mape,
      sleeptime,
    };
  },
};

// ─── P3: Cross-Stage Risk Correlation Analysis ──────────────────────────────
// Module-level function (not exported, used internally by _finalizeWorkflow).
//
// Implements the "attack chain" pattern from the white-box audit methodology:
// traverses all recorded risks and detects causal relationships between risks
// in different stages. A risk in Stage A can amplify or enable a risk in Stage B.
//
// Correlation patterns detected:
//   1. Error Cascade:         Missing error handling + unhandled exception = total failure
//   2. Security Amplification: Auth/validation issue + direct data access = data breach
//   3. Quality Erosion:       Multiple rollback failures across stages = systemic weakness
//   4. Architecture-Code Gap: Architecture concern + matching code issue = design debt
//   5. Test Coverage Gap:     Untested risk area + known defect in that area = blind spot

/**
 * Analyses recorded risks for cross-stage causal correlations.
 *
 * @param {{ severity: string, description: string, timestamp: string }[]} risks
 * @param {object} [stageCtx] - StageContextStore for additional stage metadata
 * @returns {{ severity: string, label: string, factors: object[], impact: string, recommendation: string }[]}
 */
function _analyseRiskCorrelations(risks, stageCtx) {
  if (!risks || risks.length < 2) return [];

  const correlations = [];

  // Group risks by inferred stage
  const stageRisks = new Map();
  for (const risk of risks) {
    const stage = _inferStageFromRisk(risk.description);
    if (!stageRisks.has(stage)) stageRisks.set(stage, []);
    stageRisks.get(stage).push(risk);
  }

  const stages = [...stageRisks.keys()];

  // ── Pattern 1: Error Cascade ──────────────────────────────────────────────
  // Missing error handling in one stage + failure in another = cascade risk
  const errorHandlingRisks = risks.filter(r =>
    /error.?handl|exception|unhandled|uncaught|no.?retry|no.?fallback/i.test(r.description)
  );
  const failureRisks = risks.filter(r =>
    /fail|crash|abort|timeout|broken/i.test(r.description) && r.severity === 'high'
  );
  if (errorHandlingRisks.length > 0 && failureRisks.length > 0) {
    const ehStage = _inferStageFromRisk(errorHandlingRisks[0].description);
    const fStage = _inferStageFromRisk(failureRisks[0].description);
    if (ehStage !== fStage) {
      correlations.push({
        severity: 'high',
        label: 'Error Cascade: missing error handling + downstream failure',
        factors: [
          { stage: ehStage, description: errorHandlingRisks[0].description },
          { stage: fStage, description: failureRisks[0].description },
        ],
        impact: 'A failure in one component propagates unchecked to downstream stages, potentially causing total workflow failure.',
        recommendation: 'Add error boundaries and fallback mechanisms at stage boundaries. Ensure each stage can gracefully handle upstream failures.',
      });
    }
  }

  // ── Pattern 2: Security Amplification ─────────────────────────────────────
  // Auth/validation weakness + direct data access = amplified security risk
  const authRisks = risks.filter(r =>
    /auth|validat|sanitiz|inject|xss|csrf|permission|access.?control/i.test(r.description)
  );
  const dataRisks = risks.filter(r =>
    /sql|database|query|file.?access|direct.?access|input|user.?data/i.test(r.description)
  );
  if (authRisks.length > 0 && dataRisks.length > 0) {
    correlations.push({
      severity: 'high',
      label: 'Security Amplification: validation gap + data access exposure',
      factors: [
        { stage: _inferStageFromRisk(authRisks[0].description), description: authRisks[0].description },
        { stage: _inferStageFromRisk(dataRisks[0].description), description: dataRisks[0].description },
      ],
      impact: 'A validation bypass combined with direct data access creates a potential data breach or injection vector.',
      recommendation: 'Implement defense-in-depth: validate at API boundary AND before data access. Never trust upstream validation alone.',
    });
  }

  // ── Pattern 3: Quality Erosion (Multiple Rollbacks) ───────────────────────
  // If multiple stages had rollback failures, the system is showing systemic weakness
  const rollbackRisks = risks.filter(r =>
    /rollback|unresolved.*after|failed.*after.*round|quality.?gate.*fail/i.test(r.description)
  );
  if (rollbackRisks.length >= 2) {
    const affectedStages = [...new Set(rollbackRisks.map(r => _inferStageFromRisk(r.description)))];
    if (affectedStages.length >= 2) {
      correlations.push({
        severity: 'high',
        label: `Quality Erosion: rollback failures across ${affectedStages.length} stages`,
        factors: rollbackRisks.slice(0, 3).map(r => ({
          stage: _inferStageFromRisk(r.description),
          description: r.description,
        })),
        impact: 'Multiple stages failing quality gates indicates a systemic issue – likely the original requirement is ambiguous or the complexity exceeds current capability.',
        recommendation: 'Consider re-analysing the original requirement with tighter scope. Break the task into smaller, independently verifiable subtasks.',
      });
    }
  }

  // ── Pattern 4: Architecture-Code Gap ──────────────────────────────────────
  // Architecture risk + related code issue = design debt confirmed
  const archRisks = stageRisks.get('ARCHITECT') || [];
  const codeRisks = stageRisks.get('CODE') || [];
  if (archRisks.length > 0 && codeRisks.length > 0) {
    // Check for keyword overlap between arch and code risks
    for (const ar of archRisks.slice(0, 3)) {
      const archKeywords = _extractKeywords(ar.description);
      for (const cr of codeRisks.slice(0, 3)) {
        const codeKeywords = _extractKeywords(cr.description);
        const overlap = archKeywords.filter(k => codeKeywords.includes(k));
        if (overlap.length >= 2) {
          correlations.push({
            severity: ar.severity === 'high' || cr.severity === 'high' ? 'high' : 'medium',
            label: `Architecture-Code Gap: shared concern "${overlap.slice(0, 2).join(', ')}"`,
            factors: [
              { stage: 'ARCHITECT', description: ar.description },
              { stage: 'CODE', description: cr.description },
            ],
            impact: `The same concern (${overlap.join(', ')}) appears in both architecture and code risks, confirming the design decision was not fully resolved before implementation.`,
            recommendation: 'Address this at the architecture level first. Code-level fixes for architecture problems create technical debt.',
          });
          break; // One correlation per arch risk is enough
        }
      }
    }
  }

  // ── Pattern 5: Test Coverage Gap ──────────────────────────────────────────
  // Known risk in any stage + test failure in related area = blind spot
  const testRisks = stageRisks.get('TEST') || [];
  const nonTestHighRisks = risks.filter(r =>
    r.severity === 'high' && _inferStageFromRisk(r.description) !== 'TEST'
  );
  if (testRisks.length > 0 && nonTestHighRisks.length > 0) {
    const testKeywords = testRisks.flatMap(r => _extractKeywords(r.description));
    for (const hr of nonTestHighRisks.slice(0, 3)) {
      const hrKeywords = _extractKeywords(hr.description);
      const overlap = hrKeywords.filter(k => testKeywords.includes(k));
      if (overlap.length >= 1) {
        correlations.push({
          severity: 'medium',
          label: `Test Coverage Gap: known risk "${overlap[0]}" with test issues`,
          factors: [
            { stage: _inferStageFromRisk(hr.description), description: hr.description },
            { stage: 'TEST', description: testRisks[0].description },
          ],
          impact: 'A known high-severity risk area also has test failures, suggesting the risk is not adequately covered by the test suite.',
          recommendation: 'Add targeted test cases specifically covering the identified risk area.',
        });
        break; // One coverage gap correlation is enough
      }
    }
  }

  // Deduplicate: max 5 correlations, prioritised by severity
  const severityOrder = { high: 0, medium: 1, low: 2 };
  return correlations
    .sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9))
    .slice(0, 5);
}

/**
 * Infers which stage a risk description belongs to based on keyword heuristics.
 *
 * @param {string} description
 * @returns {string} Stage name (ANALYSE | ARCHITECT | CODE | TEST | UNKNOWN)
 */
function _inferStageFromRisk(description) {
  const d = description.toLowerCase();
  if (d.includes('[archreview]') || d.includes('architecture') || d.includes('coverage')) return 'ARCHITECT';
  if (d.includes('[codereview]') || d.includes('code review') || d.includes('[realtest]') || d.includes('code-development')) return 'CODE';
  if (d.includes('[testreport]') || d.includes('test') || d.includes('[testcase')) return 'TEST';
  if (d.includes('[securitycve]') || d.includes('[codequality]')) return 'CODE';
  if (d.includes('requirement') || d.includes('clarif')) return 'ANALYSE';
  if (d.includes('entropy') || d.includes('ci ')) return 'TEST';
  return 'UNKNOWN';
}

/**
 * Extracts meaningful keywords from a risk description for correlation matching.
 * Filters out common stop words and short tokens.
 *
 * @param {string} description
 * @returns {string[]} Lowercased keywords
 */
function _extractKeywords(description) {
  const STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'must', 'that',
    'this', 'these', 'those', 'with', 'from', 'into', 'for', 'and', 'but',
    'or', 'not', 'no', 'of', 'in', 'on', 'at', 'to', 'by', 'up', 'out',
    'after', 'before', 'above', 'below', 'between', 'through', 'during',
    'issue', 'issues', 'remain', 'remains', 'remaining', 'see', 'also',
    'high', 'medium', 'low', 'severity', 'failed', 'still',
  ]);
  return (description.match(/[a-z][a-z0-9_-]+/gi) || [])
    .map(w => w.toLowerCase())
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w));
}
