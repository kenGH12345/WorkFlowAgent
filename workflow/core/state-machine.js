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
   */
  constructor(projectId, hookEmitter = async () => {}) {
    this.projectId = projectId;
    this.hookEmitter = hookEmitter;
    this.manifest = null;
  }

  // ─── Initialisation ──────────────────────────────────────────────────────────

  /**
   * Initialise the state machine.
   * If manifest.json already exists, resumes from the last recorded state.
   * Otherwise creates a fresh manifest and starts from INIT.
   */
  async init() {
    if (fs.existsSync(PATHS.MANIFEST)) {
      this.manifest = this._readManifest();
      console.log(`[StateMachine] Resuming from state: ${this.manifest.currentState}`);
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
    const idx = STATE_ORDER.indexOf(this.getState());
    if (idx === -1 || idx === STATE_ORDER.length - 1) return null;
    return STATE_ORDER[idx + 1];
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

  // ─── Risk Recording ───────────────────────────────────────────────────────────

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

  // ─── Artifact Helpers ─────────────────────────────────────────────────────────

  /** Returns the artifacts map from the current manifest */
  getArtifacts() {
    return this.manifest ? this.manifest.artifacts : {};
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────────

  _readManifest() {
    const raw = fs.readFileSync(PATHS.MANIFEST, 'utf-8');
    return JSON.parse(raw);
  }

  _writeManifest() {
    // Ensure output directory exists
    const dir = path.dirname(PATHS.MANIFEST);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // N33 fix: atomic write – write to a temp file first, then rename.
    // If the process crashes mid-write, the original manifest.json is untouched
    // and the next resume will still find a valid JSON file.
    const tmpPath = PATHS.MANIFEST + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(this.manifest, null, 2), 'utf-8');
    fs.renameSync(tmpPath, PATHS.MANIFEST);
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
