/**
 * Task Manager – Task decomposition, dependency orchestration, parallel execution
 *
 * Inspired by AgentFlow's task scheduling mechanism:
 *  - Decompose a goal into sub-tasks with dependency relationships
 *  - Prevent duplicate task claiming (anti-conflict)
 *  - Priority: interrupted > recoverable-blocked > retryable-failed > pending
 *  - Full state lifecycle: pending → running → done / blocked / failed / interrupted
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS } = require('./constants');

// ─── Task Status ──────────────────────────────────────────────────────────────

const TaskStatus = {
  PENDING:     'pending',      // Waiting to be claimed
  RUNNING:     'running',      // Currently being executed by an agent
  DONE:        'done',         // Successfully completed
  BLOCKED:     'blocked',      // Waiting for dependency, can be recovered
  FAILED:      'failed',       // Execution failed, may be retried
  EXHAUSTED:   'exhausted',    // Retries exhausted, will not be retried again
  INTERRUPTED: 'interrupted',  // Interrupted mid-execution, highest priority to resume
};

// ─── Task Priority ────────────────────────────────────────────────────────────

const TaskPriority = {
  CRITICAL: 0,   // Interrupted tasks
  HIGH:     1,   // Recoverable blocked tasks
  MEDIUM:   2,   // Retryable failed tasks
  NORMAL:   3,   // Regular pending tasks
};

// ─── Task Manager ─────────────────────────────────────────────────────────────

class TaskManager {
  /**
   * @param {string} [storePath] - Path to persist task list JSON
   */
  constructor(storePath = null) {
    this.storePath = storePath || path.join(PATHS.OUTPUT_DIR, 'tasks.json');
    /** @type {Map<string, Task>} */
    this.tasks = new Map();
    this._load();
  }

  // ─── Public API ───────────────────────────────────────────────────────────────

  /**
   * Adds a new task to the task list.
   *
   * @param {object} options
   * @param {string}   options.id          - Unique task ID (e.g. 'TASK-001')
   * @param {string}   options.title       - Short description
   * @param {string}   options.description - Detailed task description
   * @param {string[]} [options.deps]      - IDs of tasks that must complete first
   * @param {string}   [options.skill]     - Skill name to apply (e.g. 'go_crud')
   * @param {string}   [options.agentRole] - Preferred agent role
   * @returns {Task}
   */
  addTask({ id, title, description, deps = [], skill = null, agentRole = null }) {
    if (this.tasks.has(id)) {
      throw new Error(`[TaskManager] Task "${id}" already exists`);
    }
    const task = {
      id,
      title,
      description,
      deps,
      skill,
      agentRole,
      status: TaskStatus.PENDING,
      priority: TaskPriority.NORMAL,
      retryCount: 0,
      maxRetries: 3,
      claimedBy: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
      notes: [],
    };
    this.tasks.set(id, task);
    this._save();
    // N57 fix: immediately evaluate blocking state for the new task.
    // If its deps are not yet DONE, mark it BLOCKED right away so
    // _getClaimableTasks() never needs to mutate status.
    this._blockPendingWithUnmetDeps();
    console.log(`[TaskManager] Task added: ${id} – "${title}"`);
    return task;
  }

  /**
   * Returns the next claimable task for an agent, respecting priority and dependencies.
   * Priority order: interrupted > recoverable-blocked > retryable-failed > pending
   *
   * @param {string} agentId - ID of the agent claiming the task
   * @returns {Task|null}
   */
  claimNextTask(agentId) {
    const candidates = this._getClaimableTasks();
    if (candidates.length === 0) return null;

    const task = candidates[0]; // Already sorted by priority
    task.status = TaskStatus.RUNNING;
    task.claimedBy = agentId;
    task.startedAt = task.startedAt || new Date().toISOString();
    task.updatedAt = new Date().toISOString();
    this._save();
    console.log(`[TaskManager] Task claimed: ${task.id} by agent "${agentId}"`);
    return task;
  }

  /**
   * Marks a task as successfully completed.
   *
   * Anti-premature-completion guard: a non-empty verificationNote is required.
   * This prevents agents from declaring tasks done without actual testing,
   * inspired by the "long-running agent" pattern where premature completion
   * is one of the two primary failure modes.
   *
   * @param {string} taskId
   * @param {*}      result             - Any serialisable result data
   * @param {string} [verificationNote] - REQUIRED: describe how the change was tested
   * @throws {Error} if verificationNote is missing or empty
   */
  completeTask(taskId, result = null, verificationNote = '') {
    // Anti-premature-completion guard: require a verification note
    if (!verificationNote || verificationNote.trim().length === 0) {
      throw new Error(
        `[TaskManager] Cannot complete task "${taskId}" without a verificationNote. ` +
        `Describe how you tested this change (e.g. "ran unit tests", "verified via browser", "curl tested endpoint"). ` +
        `Declaring a task done without verification is NOT acceptable.`
      );
    }

    const task = this._getTask(taskId);
    task.status = TaskStatus.DONE;
    task.result = result;
    task.verificationNote = verificationNote.trim();
    task.completedAt = new Date().toISOString();
    task.updatedAt = new Date().toISOString();
    this._save();
    console.log(`[TaskManager] Task completed: ${taskId} (verified: "${verificationNote.trim().slice(0, 80)}")`);
    // Unblock any tasks waiting on this one
    this._unblockDependents(taskId);
  }

  /**
   * Marks a task as failed.
   *
   * @param {string} taskId
   * @param {string} errorMessage
   */
  failTask(taskId, errorMessage) {
    const task = this._getTask(taskId);
    task.retryCount += 1;
    task.error = errorMessage;
    task.updatedAt = new Date().toISOString();

    if (task.retryCount < task.maxRetries) {
      task.status = TaskStatus.FAILED;
      task.priority = TaskPriority.MEDIUM;
      // N23 fix: exponential backoff to prevent retry storms.
      // Delay = 2^retryCount seconds (1s, 2s, 4s, ...), capped at 30s.
      const backoffMs = Math.min(Math.pow(2, task.retryCount) * 1000, 30000);
      task.nextRetryAt = new Date(Date.now() + backoffMs).toISOString();
      console.log(`[TaskManager] Task failed (retry ${task.retryCount}/${task.maxRetries}), next retry in ${backoffMs / 1000}s: ${taskId}`);
    } else {
      task.status = TaskStatus.EXHAUSTED;
      task.priority = TaskPriority.MEDIUM;
      task.nextRetryAt = null;
      console.warn(`[TaskManager] Task exhausted retries (${task.maxRetries}), will not be retried: ${taskId}`);
    }
    this._save();
  }

  /**
   * Marks a task as interrupted (highest priority to resume).
   *
   * @param {string} taskId
   * @param {string} [note]
   */
  interruptTask(taskId, note = '') {
    const task = this._getTask(taskId);
    task.status = TaskStatus.INTERRUPTED;
    task.priority = TaskPriority.CRITICAL;
    task.updatedAt = new Date().toISOString();
    if (note) task.notes.push({ timestamp: new Date().toISOString(), note });
    this._save();
    console.warn(`[TaskManager] Task interrupted: ${taskId}`);
  }

  /**
   * Adds a note to a task (for blocking reasons, partial progress, etc.).
   *
   * @param {string} taskId
   * @param {string} note
   */
  addNote(taskId, note) {
    const task = this._getTask(taskId);
    task.notes.push({ timestamp: new Date().toISOString(), note });
    task.updatedAt = new Date().toISOString();
    this._save();
  }

  /**
   * Returns a summary of all tasks grouped by status.
   *
   * @returns {object}
   */
  getSummary() {
    const summary = {
      total: this.tasks.size,
      byStatus: {},
      pendingWithDeps: [],
    };
    for (const status of Object.values(TaskStatus)) {
      summary.byStatus[status] = 0;
    }
    for (const task of this.tasks.values()) {
      summary.byStatus[task.status] = (summary.byStatus[task.status] || 0) + 1;
      if (task.status === TaskStatus.PENDING && task.deps.length > 0) {
        const unmet = task.deps.filter(d => {
          const dep = this.tasks.get(d);
          return !dep || dep.status !== TaskStatus.DONE;
        });
        if (unmet.length > 0) {
          summary.pendingWithDeps.push({ id: task.id, waitingFor: unmet });
        }
      }
    }
    return summary;
  }

  /**
   * Returns all tasks as an array, sorted by priority.
   *
   * @returns {Task[]}
   */
  getAllTasks() {
    return Array.from(this.tasks.values()).sort((a, b) => a.priority - b.priority);
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────────

  /**
   * Returns tasks that can be claimed right now, sorted by priority.
   * A task is claimable if:
   *  - Status is PENDING, FAILED (retryable, past backoff window), or INTERRUPTED
   *  - All dependencies are DONE
   *  - Not currently claimed by another agent
   *
   * N57 fix: this method is now READ-ONLY – it no longer mutates task status.
   * Previously, PENDING tasks with unmet deps were marked BLOCKED here, which
   * created a race condition with _unblockDependents():
   *   1. completeTask() calls _save() → task B is DONE on disk
   *   2. _getClaimableTasks() runs (before _unblockDependents()) → task A (PENDING,
   *      depends on B) is marked BLOCKED and persisted
   *   3. _unblockDependents() runs → task A is set back to PENDING
   * In the worst case (crash between steps 2 and 3), task A is permanently BLOCKED.
   * The fix: PENDING→BLOCKED transitions only happen in _blockPendingWithUnmetDeps(),
   * which is called once during addTask() and after _load(), not during claim queries.
   */
  _getClaimableTasks() {
    const claimable = [];
    const now = Date.now();
    for (const task of this.tasks.values()) {
      if (task.status === TaskStatus.RUNNING) continue;
      if (task.status === TaskStatus.DONE) continue;
      if (task.status === TaskStatus.BLOCKED) continue;
      if (task.status === TaskStatus.EXHAUSTED) continue;

      // N23 fix: respect exponential backoff for FAILED tasks.
      // Skip tasks that are still within their backoff window.
      if (task.status === TaskStatus.FAILED && task.nextRetryAt) {
        if (new Date(task.nextRetryAt).getTime() > now) continue;
      }

      // Check dependencies (read-only – do NOT mutate status here)
      const depsOk = task.deps.every(depId => {
        const dep = this.tasks.get(depId);
        return dep && dep.status === TaskStatus.DONE;
      });

      if (depsOk) {
        claimable.push(task);
      }
      // N57 fix: tasks with unmet deps are simply skipped here.
      // They will be blocked by _blockPendingWithUnmetDeps() at load/add time,
      // and unblocked by _unblockDependents() when their deps complete.
    }
    return claimable.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Scans all PENDING tasks and marks those with unmet dependencies as BLOCKED.
   * Called once after _load() and after addTask() to initialise blocking state.
   * This is the ONLY place where PENDING → BLOCKED transitions happen, keeping
   * _getClaimableTasks() read-only and race-condition-free (N57 fix).
   */
  _blockPendingWithUnmetDeps() {
    let changed = false;
    for (const task of this.tasks.values()) {
      if (task.status !== TaskStatus.PENDING) continue;
      if (task.deps.length === 0) continue;
      const depsOk = task.deps.every(depId => {
        const dep = this.tasks.get(depId);
        return dep && dep.status === TaskStatus.DONE;
      });
      if (!depsOk) {
        task.status = TaskStatus.BLOCKED;
        task.priority = TaskPriority.HIGH;
        task.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) this._save();
  }

  /**
   * When a task completes, check if any blocked tasks can now be unblocked.
   * Only iterates tasks that explicitly depend on completedTaskId (O(dependents) not O(all)).
   *
   * @param {string} completedTaskId
   */
  _unblockDependents(completedTaskId) {
    let changed = false;
    for (const task of this.tasks.values()) {
      if (task.status !== TaskStatus.BLOCKED) continue;
      // Fast-skip: only consider tasks that depend on the completed task
      if (!task.deps.includes(completedTaskId)) continue;
      const depsOk = task.deps.every(depId => {
        const dep = this.tasks.get(depId);
        return dep && dep.status === TaskStatus.DONE;
      });
      if (depsOk) {
        task.status = TaskStatus.PENDING;
        task.priority = TaskPriority.NORMAL;
        task.updatedAt = new Date().toISOString();
        console.log(`[TaskManager] Task unblocked: ${task.id}`);
        changed = true;
      }
    }
    if (changed) this._save();
  }

  _getTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`[TaskManager] Task not found: "${taskId}"`);
    return task;
  }

  _load() {
    try {
      if (fs.existsSync(this.storePath)) {
        const data = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
        for (const task of data) {
          this.tasks.set(task.id, task);
        }
        console.log(`[TaskManager] Loaded ${this.tasks.size} tasks from ${this.storePath}`);
        // N57 fix: after loading, re-evaluate blocking state for all PENDING tasks.
        // This handles the case where a crash occurred between _save() and
        // _unblockDependents() in a previous run, leaving tasks incorrectly PENDING
        // when their deps are not yet DONE.
        this._blockPendingWithUnmetDeps();
      }
    } catch (err) {
      console.warn(`[TaskManager] Could not load tasks: ${err.message}`);
    }
  }

  _save() {
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // N37 fix: atomic write – write to a .tmp file first, then rename over the target.
      // If the process crashes mid-write, the original file remains intact.
      const tmpPath = this.storePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(Array.from(this.tasks.values()), null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.storePath);
    } catch (err) {
      console.warn(`[TaskManager] Could not save tasks: ${err.message}`);
    }
  }
}

module.exports = { TaskManager, TaskStatus, TaskPriority };
