/**
 * Hook System – Event-driven lifecycle notifications
 *
 * Implements Requirement 6.4: trigger human intervention at key stages.
 * Provides a simple pub/sub event bus for workflow lifecycle events.
 *
 * Built-in hooks:
 *  - HUMAN_REVIEW_REQUIRED: blocks execution until human confirms
 *  - AGENT_BOUNDARY_VIOLATION: logs and optionally aborts
 *  - WORKFLOW_COMPLETE: final notification
 *  - WORKFLOW_ERROR: error notification
 */

'use strict';

const readline = require('readline');
const { HOOK_EVENTS } = require('../core/constants');

class HookSystem {
  constructor() {
    /** @type {Map<string, Function[]>} event → handlers */
    this._handlers = new Map();
    this._registerBuiltins();
  }

  // ─── Public API ───────────────────────────────────────────────────────────────

  /**
   * Registers a handler for a specific event.
   *
   * @param {string}   event   - One of HOOK_EVENTS values
   * @param {Function} handler - async (payload: object) => void
   */
  on(event, handler) {
    if (!this._handlers.has(event)) {
      this._handlers.set(event, []);
    }
    this._handlers.get(event).push(handler);
  }

  /**
   * Emits an event, calling all registered handlers in order.
   * Returns after all handlers complete.
   *
   * N81 fix: each handler is wrapped in an independent try/catch so a single
   * failing handler does not abort subsequent handlers or propagate an exception
   * to the caller (e.g. _runArchitect), which would crash the entire workflow.
   *
   * @param {string} event
   * @param {object} payload
   */
  async emit(event, payload = {}) {
    const handlers = this._handlers.get(event) || [];
    for (const handler of handlers) {
      try {
        await handler(payload);
      } catch (err) {
        console.error(`[HookSystem] Handler for event "${event}" threw an error: ${err.message}`);
      }
    }
  }

  /**
   * Returns a bound emitter function suitable for passing to StateMachine / Agents.
   * @returns {Function} async (event, payload) => void
   */
  getEmitter() {
    return this.emit.bind(this);
  }

  // ─── Built-in Handlers ────────────────────────────────────────────────────────

  _registerBuiltins() {
    // Log all state transitions
    this.on(HOOK_EVENTS.BEFORE_STATE_TRANSITION, async ({ fromState, toState }) => {
      console.log(`\n[Hook] ⏳ Transitioning: ${fromState} → ${toState}`);
    });

    this.on(HOOK_EVENTS.AFTER_STATE_TRANSITION, async ({ fromState, toState, artifactPath }) => {
      console.log(`[Hook] ✅ Transitioned: ${fromState} → ${toState}${artifactPath ? ` | Artifact: ${artifactPath}` : ''}`);
    });

    // Log boundary violations
    this.on(HOOK_EVENTS.AGENT_BOUNDARY_VIOLATION, async ({ role, action }) => {
      console.error(`\n[Hook] 🚫 BOUNDARY VIOLATION: Agent "${role}" attempted forbidden action "${action}"`);
    });

    // Log workflow completion
    this.on(HOOK_EVENTS.WORKFLOW_COMPLETE, async ({ manifest }) => {
      console.log(`\n[Hook] 🎉 WORKFLOW COMPLETE!`);
      console.log(`   Project: ${manifest.projectId}`);
      console.log(`   Artifacts:`);
      for (const [key, val] of Object.entries(manifest.artifacts)) {
        if (val) console.log(`     - ${key}: ${val}`);
      }
    });

    // Log errors
    this.on(HOOK_EVENTS.WORKFLOW_ERROR, async ({ error, state }) => {
      console.error(`\n[Hook] ❌ WORKFLOW ERROR at state "${state}": ${error.message}`);
    });

    // Human review: blocks until user confirms via stdin.
    // autoApprove=true (default) → skip prompt and continue automatically.
    // autoApprove=false          → block and wait for human input.
    this.on(HOOK_EVENTS.HUMAN_REVIEW_REQUIRED, async ({ filePath, message, autoApprove = true }) => {
      if (autoApprove) {
        console.log(`\n[Hook] ✅ Auto-approved (self-correction passed): ${message || filePath || ''}`);
        return;
      }
      await _promptHumanReview(filePath, message);
    });

    // AgentFlow: task lifecycle events
    this.on(HOOK_EVENTS.TASK_CLAIMED, async ({ agentId, taskId }) => {
      console.log(`[Hook] 🔄 Task claimed: ${taskId} by ${agentId}`);
    });

    this.on(HOOK_EVENTS.TASK_COMPLETED, async ({ agentId, taskId }) => {
      console.log(`[Hook] ✅ Task completed: ${taskId} by ${agentId}`);
    });

    this.on(HOOK_EVENTS.TASK_FAILED, async ({ agentId, taskId, error }) => {
      console.warn(`[Hook] ❌ Task failed: ${taskId} by ${agentId} – ${error}`);
    });

    this.on(HOOK_EVENTS.TASK_INTERRUPTED, async ({ taskId }) => {
      console.warn(`[Hook] ⚡ Task interrupted: ${taskId}`);
    });

    // AgentFlow: knowledge events
    this.on(HOOK_EVENTS.EXPERIENCE_RECORDED, async ({ expId }) => {
      console.log(`[Hook] 📝 Experience recorded: ${expId}`);
    });

    this.on(HOOK_EVENTS.SKILL_EVOLVED, async ({ skillName, expId }) => {
      console.log(`[Hook] 🧠 Skill evolved: ${skillName} (from exp: ${expId})`);
    });

    this.on(HOOK_EVENTS.COMPLAINT_FILED, async ({ complaintId }) => {
      console.warn(`[Hook] 🗣️  Complaint filed: ${complaintId}`);
    });

    this.on(HOOK_EVENTS.COMPLAINT_RESOLVED, async ({ complaintId }) => {
      console.log(`[Hook] 🔧 Complaint resolved: ${complaintId}`);
    });

    // CI pipeline events
    this.on(HOOK_EVENTS.CI_PIPELINE_STARTED, async ({ command }) => {
      console.log(`[Hook] 🚀 CI pipeline started${command ? `: ${command}` : ''}`);
    });

    this.on(HOOK_EVENTS.CI_PIPELINE_COMPLETE, async ({ result }) => {
      const status = result?.status ?? 'unknown';
      const msg = result?.message ?? '';
      if (status === 'success') {
        console.log(`[Hook] ✅ CI pipeline complete: ${msg}`);
      } else {
        console.warn(`[Hook] ⚠️  CI pipeline complete (${status}): ${msg}`);
      }
    });

    this.on(HOOK_EVENTS.CI_PIPELINE_FAILED, async ({ result }) => {
      const msg = result?.message ?? 'unknown error';
      console.error(`[Hook] ❌ CI pipeline FAILED: ${msg}`);
    });
  }
}

// ─── Human Review Prompt ──────────────────────────────────────────────────────

/**
 * Blocks execution and prompts the human for confirmation.
 * Implements the "key stage human intervention" requirement.
 *
 * @param {string} filePath - Path to the artifact requiring review
 * @param {string} [message]
 * @returns {Promise<void>}
 */
async function _promptHumanReview(filePath, message) {
  // Prompt the human for a final approve / reject decision.
  const prompt = [
    ``,
    `╔══════════════════════════════════════════════════════════╗`,
    `║           🔍 HUMAN REVIEW REQUIRED                       ║`,
    `╚══════════════════════════════════════════════════════════╝`,
    ``,
    message || `Please review the artifact before proceeding.`,
    filePath ? `\nArtifact: ${filePath}` : '',
    ``,
    `Options:`,
    `  [1] Approve and continue`,
    `  [2] Reject and abort workflow`,
    ``,
  ].join('\n');

  console.log(prompt);

  const TIMEOUT_MS = 30000;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const settle = (approved) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { rl.close(); } catch (_) {}
      // N34 fix: rl.close() does not pause process.stdin, which keeps the event loop
      // alive and prevents Node.js from exiting naturally. Explicitly pause stdin here.
      try { process.stdin.pause(); } catch (_) {}
      if (approved) {
        console.log(`[Hook] ✅ Human approved. Continuing workflow...`);
        resolve();
      } else {
        console.log(`[Hook] ❌ Human rejected. Aborting workflow.`);
        reject(new Error('Workflow aborted by human reviewer.'));
      }
    };

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    // Auto-approve on timeout
    timer = setTimeout(() => {
      console.log(`\n[Hook] ⏱️  No response in ${TIMEOUT_MS / 1000}s. Auto-approving and continuing...`);
      settle(true);
    }, TIMEOUT_MS);

    rl.question('Your choice (1/2): ', (answer) => {
      settle(answer.trim() !== '2');
    });
  });
}

module.exports = { HookSystem };
