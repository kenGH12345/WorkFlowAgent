/**
 * Central state machine for the multi-agent workflow.
 *
 * Responsibilities:
 *  - Drive state transitions: INIT → ANALYSE → ARCHITECT → CODE → TEST → FINISHED
 *  - Persist every transition to manifest.json (checkpoint / resume)
 *  - Emit hook events at key lifecycle points
 *  - Enforce sequential state ordering
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { WorkflowState, STATE_ORDER, createManifest, createHistoryEntry } = require('./types');
const { PATHS, HOOK_EVENTS } = require('./constants');

class StateMachine {
  /**
   * @param {string} projectId - Unique identifier for this workflow run
   * @param {Function} hookEmitter - async (event: string, payload: object) => void
   * @param {object} [opts]
   * @param {string[]} [opts.stateOrder] - P1-b: Custom state order. Defaults to the
   *   built-in STATE_ORDER (INIT → ANALYSE → ARCHITECT → CODE → TEST → FINISHED).
   *   When custom stages are registered via StageRegistry, pass
   *   buildStateOrder(stageRegistry.getOrder()) to include them in transition validation.
   */
  constructor(projectId, hookEmitter = async () => {}, opts = {}) {
    this.projectId = projectId;
    this.hookEmitter = hookEmitter;
    this.manifest = null;
    // P1-b: use custom state order if provided, otherwise use the default
    this._stateOrder = opts.stateOrder || STATE_ORDER;
    // P2-b: instance-level manifest path. When provided, the StateMachine
    // reads/writes manifest.json from this path instead of the global PATHS.MANIFEST.
    // This enables multiple Orchestrator instances to run in parallel without
    this._manifestPath = opts.manifestPath || PATHS.MANIFEST;
  }

  // ─── Initialisation  }

  // ─── Initialisation ──────────────────────────────────────────────────────────

  /**
   * Initialise the state machine.
   * If manifest.json already exists, resumes from the last recorded state.
   * Otherwise creates a fresh manifest and starts from INIT.
   */
  async init() {
    if (fs.existsSync(this._manifestPath)) {
      this.manifest = this._readManifest();
      // Validate that the restored currentState is a legitimate state in _stateOrder.
      // If the manifest is corrupted (e.g. currentState is undefined/null/invalid),
      // reset to INIT and start fresh rather than propagating a bad state that will
      // cause "Cannot transition: already in terminal state undefined" downstream.
      const restoredState = this.manifest.currentState;
      if (!restoredState || !this._stateOrder.includes(restoredState)) {
        console.warn(`[StateMachine] ⚠️  Invalid currentState "${restoredState}" in manifest. Resetting to ${WorkflowState.INIT}.`);
        this.manifest.currentState = WorkflowState.INIT;
        this._writeManifest();
      } else if (restoredState === WorkflowState.FINISHED) {
        // Previous run completed successfully. Reset to INIT for a fresh run
        // instead of resuming from FINISHED (which would immediately fail on transition).
        console.log(`[StateMachine] Previous run completed (FINISHED). Resetting to ${WorkflowState.INIT} for new run.`);
        this.manifest = createManifest(this.projectId);
        this._writeManifest();
      } else {
        console.log(`[StateMachine] Resuming from state: ${this.manifest.currentState}`);
      }
    } else {
      this.manifest = createManifest(this.projectId);
      this._writeManifest();
      console.log(`[StateMachine] New workflow started. State: ${WorkflowState.INIT}`);
    }
    return this.manifest.currentState;
  }

  // ─── State Queries ────────────────────────────────────────────────────────────

  /** Returns the current workflow state string */
  getState() {
    return this.manifest ? this.manifest.currentState : null;
  }

  /** Returns true if the workflow has completed all stages */
  isFinished() {
    return this.getState() === WorkflowState.FINISHED;
  }

  /**
   * Returns the next state after the current one, or null if already FINISHED.
   */
  getNextState() {
    const idx = this._stateOrder.indexOf(this.getState());
    if (idx === -1 || idx === this._stateOrder.length - 1) return null;
    return this._stateOrder[idx + 1];
  }

  /**
   * Returns the previous state before the current one, or null if already at INIT.
   */
  getPreviousState() {
    const idx = this._stateOrder.indexOf(this.getState());
    if (idx <= 0) return null;
    return this._stateOrder[idx - 1];
  }
  // ─── Transition ───────────────────────────────────────────────────────────────

  /**
   * Advances the state machine to the next state.
   *
   * @param {string|null} artifactPath - File path produced during the current stage
   * @param {string} [note]            - Optional human-readable note
   * @returns {string} The new current state
   * @throws {Error} If already in FINISHED state or transition is invalid
   */
  async transition(artifactPath = null, note = '') {
    const fromState = this.getState();
    const toState = this.getNextState();

    if (!toState) {
      throw new Error(`[StateMachine] Cannot transition: already in terminal state "${fromState}"`);
    }

    // Emit before-transition hook
    await this.hookEmitter(HOOK_EVENTS.BEFORE_STATE_TRANSITION, { fromState, toState, artifactPath });

    // Update manifest
    const entry = createHistoryEntry(fromState, toState, artifactPath, note);
    this.manifest.history.push(entry);
    this.manifest.currentState = toState;
    this.manifest.updatedAt = new Date().toISOString();

    // Record artifact path
    if (artifactPath) {
      this._recordArtifact(toState, artifactPath);
    }

    this._writeManifest();

    console.log(`[StateMachine] Transition: ${fromState} → ${toState}${artifactPath ? ` (artifact: ${artifactPath})` : ''}`);

    // Emit after-transition hook
    await this.hookEmitter(HOOK_EVENTS.AFTER_STATE_TRANSITION, { fromState, toState, artifactPath, manifest: this.manifest });

    // Emit completion hook
    if (toState === WorkflowState.FINISHED) {
      await this.hookEmitter(HOOK_EVENTS.WORKFLOW_COMPLETE, { manifest: this.manifest });
    }

    return toState;
  }

  /**
   * Rolls back the state machine to the previous state.
   * Useful when a downstream stage discovers a fundamental issue that requires
   * re-running an earlier stage (e.g. architecture review fails → re-analyse).
   *
   * @param {string} [reason] - Human-readable reason for rollback
   * @returns {string} The state rolled back to
   * @throws {Error} If already at INIT state (cannot roll back further)
   */
  async rollback(reason = '') {
    const fromState = this.getState();
    const toState = this.getPreviousState();

    if (!toState) {
      throw new Error(`[StateMachine] Cannot rollback: already at initial state "${fromState}"`);
    }

    console.warn(`[StateMachine] ⏪ Rollback: ${fromState} → ${toState}${reason ? ` (reason: ${reason})` : ''}`);

    await this.hookEmitter(HOOK_EVENTS.BEFORE_STATE_TRANSITION, { fromState, toState, rollback: true, reason });

    const entry = createHistoryEntry(fromState, toState, null, `[ROLLBACK] ${reason}`);
    this.manifest.history.push(entry);
    this.manifest.currentState = toState;
    this.manifest.updatedAt = new Date().toISOString();
    this.manifest.lastRollback = { fromState, toState, reason, timestamp: new Date().toISOString() };

    this._writeManifest();

    await this.hookEmitter(HOOK_EVENTS.AFTER_STATE_TRANSITION, { fromState, toState, rollback: true, manifest: this.manifest });

    return toState;
  }

  /**
   * Jumps directly to a specific target state (forward or backward).
   * Use with caution – skipping stages may leave artifacts in an inconsistent state.
   *
   * @param {string} targetState - The WorkflowState to jump to
   * @param {string} [reason]    - Human-readable reason for the jump
   * @returns {string} The new current state
   * @throws {Error} If targetState is not a valid WorkflowState
   */
  async jumpTo(targetState, reason = '') {
    if (!this._stateOrder.includes(targetState)) {
      throw new Error(`[StateMachine] Invalid target state: "${targetState}". Valid states: ${this._stateOrder.join(', ')}`);
    }

    const fromState = this.getState();
    if (fromState === targetState) {
      console.warn(`[StateMachine] jumpTo: already in state "${targetState}". No-op.`);
      return targetState;
    }

    const direction = this._stateOrder.indexOf(targetState) < this._stateOrder.indexOf(fromState) ? '⏪' : '⏩';
    console.warn(`[StateMachine] ${direction} Jump: ${fromState} → ${targetState}${reason ? ` (reason: ${reason})` : ''}`);

    await this.hookEmitter(HOOK_EVENTS.BEFORE_STATE_TRANSITION, { fromState, toState: targetState, jump: true, reason });

    const entry = createHistoryEntry(fromState, targetState, null, `[JUMP] ${reason}`);
    this.manifest.history.push(entry);
    this.manifest.currentState = targetState;
    this.manifest.updatedAt = new Date().toISOString();

    this._writeManifest();

    await this.hookEmitter(HOOK_EVENTS.AFTER_STATE_TRANSITION, { fromState, toState: targetState, jump: true, manifest: this.manifest });

    return targetState;
  }

  // ─── Parallel Sub-task Execution ─────────────────────────────────────────────

  /**
   * Defect B fix: Runs multiple independent sub-tasks in parallel within the
   * current state, without changing the linear state transition structure.
   *
   * Motivation: The current state machine is a strict serial pipeline
   * (INIT → ANALYSE → ARCHITECT → CODE → TEST → FINISHED). In practice, several
   * sub-tasks within a single stage are independent and can run concurrently:
   *
   *   ARCHITECT stage:
   *     CoverageChecker.check()  ──┐
   *                                ├── both read the same file, no data dependency
   *     ArchitectureReviewAgent  ──┘
   *
   *   CODE stage:
   *     TestCaseGenerator        ──┐
   *                                ├── both read the same artifact, no data dependency
   *     CodeReviewAgent          ──┘
   *
   * This method runs all tasks concurrently via Promise.allSettled(), collects
   * results, and returns them in the same order as the input tasks array.
   * It does NOT advance the state machine – state transitions remain the caller's
   * responsibility. This preserves the linear state invariant while eliminating
   * unnecessary serial wait time.
   *
   * Error handling: uses Promise.allSettled() (not Promise.all()) so a single
   * task failure does not cancel sibling tasks. Each result has:
   *   { status: 'fulfilled', value: T }  – task succeeded
   *   { status: 'rejected',  reason: E } – task failed; sibling results still available
   *
   * Usage example:
   *   const [coverageResult, archReviewResult] = await this.stateMachine.runParallel([
   *     { name: 'CoverageCheck', fn: () => coverageChecker.check(outputPath, requirementPath) },
   *     { name: 'ArchReview',    fn: () => archReviewer.review(outputPath, requirementPath) },
   *   ]);
   *   // coverageResult.status === 'fulfilled' → coverageResult.value
   *   // archReviewResult.status === 'rejected' → archReviewResult.reason
   *
   * @param {{ name: string, fn: () => Promise<any> }[]} tasks
   *   Array of named async tasks to run in parallel.
   *   - `name`: human-readable label for logging and error attribution
   *   - `fn`:   zero-argument async function returning the task result
   * @returns {Promise<PromiseSettledResult<any>[]>}
   *   Resolves when ALL tasks complete (fulfilled or rejected).
   *   Results are in the same order as the input tasks array.
   */
  async runParallel(tasks) {
    if (!Array.isArray(tasks) || tasks.length === 0) return [];

    const state = this.getState();
    const names = tasks.map(t => t.name).join(', ');
    console.log(`[StateMachine] ⚡ Parallel execution in state ${state}: [${names}]`);

    const startMs = Date.now();
    const results = await Promise.allSettled(tasks.map(t => t.fn()));
    const elapsedMs = Date.now() - startMs;

    // Log outcome summary
    const summary = results.map((r, i) => {
      const label = tasks[i].name;
      return r.status === 'fulfilled'
        ? `✅ ${label}`
        : `❌ ${label} (${r.reason?.message ?? r.reason})`;
    }).join(', ');
    console.log(`[StateMachine] ⚡ Parallel complete in ${elapsedMs}ms: ${summary}`);

    return results;
  }

  /**
   * Convenience wrapper: runs tasks in parallel and throws if ANY task failed.
   * Use this when all tasks are required and a single failure should abort the stage.
   *
   * @param {{ name: string, fn: () => Promise<any> }[]} tasks
   * @returns {Promise<any[]>} Resolved values in input order
   * @throws {AggregateError} if one or more tasks failed
   */
  async runParallelStrict(tasks) {
    const results = await this.runParallel(tasks);
    const failures = results
      .map((r, i) => ({ ...r, name: tasks[i].name }))
      .filter(r => r.status === 'rejected');

    if (failures.length > 0) {
      const msgs = failures.map(f => `[${f.name}] ${f.reason?.message ?? f.reason}`).join('; ');
      throw new Error(`[StateMachine] runParallelStrict: ${failures.length} task(s) failed – ${msgs}`);
    }

    return results.map(r => r.value);
  }



  /**
   * Appends a risk entry to the manifest.
   *
   * @param {string} level   - 'low' | 'medium' | 'high'
   * @param {string} message - Human-readable risk description
   * @param {boolean} [flush=true] - Whether to write manifest to disk immediately.
   *   Pass false when recording multiple risks in a batch; call flushRisks() after.
   */
  recordRisk(level, message, flush = true) {
    this.manifest.risks.push({ severity: level, description: message, timestamp: new Date().toISOString() });
    // N61 fix: avoid a disk write on every recordRisk() call.
    // _runArchitect() may call recordRisk() many times in a row (once per riskNote
    // from coverage + arch review). Each call previously triggered a full atomic
    // write (serialize + rename). With flush=false, callers can batch multiple risks
    // and call flushRisks() once at the end for a single write.
    if (flush) this._writeManifest();
  }

  /**
   * Flushes any pending risk entries to disk.
   * Call this after a batch of recordRisk(level, msg, false) calls.
   */
  flushRisks() {
    this._writeManifest();
  }

  /**
   * Returns all recorded risks from the manifest.
   *
   * @returns {{ severity: string, description: string, timestamp: string }[]}
   */
  getRisks() {
    return this.manifest ? (this.manifest.risks || []) : [];
  }

  /**
   * P1-b: Updates the state order at runtime. Used when custom stages are registered
   * after construction (via Orchestrator.registerStage()).
   *
   * @param {string[]} newStateOrder - Full state order including INIT and FINISHED
   */
  setStateOrder(newStateOrder) {
    this._stateOrder = newStateOrder;
  }

  /**
   * P1-b: Returns the current state order.
   *
   * @returns {string[]}
   */
  getStateOrder() {
    return [...this._stateOrder];
  }

  // ─── Artifact Helpers ─────────────────────────────────────────────────────────

  /** Returns the artifacts map from the current manifest */
  getArtifacts() {
    return this.manifest ? this.manifest.artifacts : {};
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────────

  _readManifest() {
    const raw = fs.readFileSync(this._manifestPath, 'utf-8');
    return JSON.parse(raw);
  }

  _writeManifest() {
    // Ensure output directory exists
    const dir = path.dirname(this._manifestPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // N33 fix: atomic write – write to a temp file first, then rename.
    // If the process crashes mid-write, the original manifest.json is untouched
    // and the next resume will still find a valid JSON file.
    const tmpPath = this._manifestPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(this.manifest, null, 2), 'utf-8');
    fs.renameSync(tmpPath, this._manifestPath);
  }

  /**
   * Maps a workflow state to its corresponding artifact key and stores the path.
   *
   * @param {string} state
   * @param {string} artifactPath
   */
  _recordArtifact(state, artifactPath) {
    const stateToKey = {
      [WorkflowState.ANALYSE]: 'requirementMd',
      [WorkflowState.ARCHITECT]: 'architectureMd',
      [WorkflowState.CODE]: 'codeDiff',
      [WorkflowState.TEST]: 'testReportMd',
    };
    const key = stateToKey[state];
    if (key) {
      this.manifest.artifacts[key] = artifactPath;
    }
  }
}

module.exports = { StateMachine };
