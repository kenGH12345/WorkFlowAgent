/**
 * Task History – Cross-session task recall memory
 *
 * Persists a compact summary of each completed workflow session's tasks
 * to task-history.json. On subsequent sessions, the most recent N task
 * summaries are injected into agent prompts as "Recall Memory", giving
 * the Agent awareness of what was done in previous sessions.
 *
 * This solves the "every session starts from scratch" problem without
 * adding LLM calls — it's pure local JSON read/write.
 *
 * Design decisions:
 *   - Max 20 entries retained (FIFO eviction beyond cap)
 *   - Each entry is capped at ~200 chars for the summary
 *   - Prompt injection uses at most 5 recent entries (~300-500 tokens)
 *   - Zero LLM calls, zero external dependencies
 *   - Atomic writes (tmp + rename) for crash safety
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** Maximum number of task history entries to retain */
const MAX_HISTORY_ENTRIES = 20;

/** Maximum number of entries to inject into prompt */
const MAX_RECALL_ENTRIES = 5;

/** Maximum summary length per entry (chars) */
const MAX_SUMMARY_CHARS = 200;

class TaskHistory {
  /**
   * @param {string} [storePath] - Path to task-history.json
   */
  constructor(storePath = null) {
    const { PATHS } = require('./constants');
    this.storePath = storePath || path.join(PATHS.OUTPUT_DIR, 'task-history.json');
    /** @type {TaskHistoryEntry[]} */
    this.entries = [];
    this._load();
  }

  /**
   * Records a completed workflow session.
   *
   * @param {object} options
   * @param {string}   options.mode         - 'sequential' | 'task-based'
   * @param {string}   options.goal         - Original requirement/goal
   * @param {string}   [options.projectId]  - Project identifier
   * @param {number}   [options.taskCount]  - Number of tasks executed
   * @param {string[]} [options.taskTitles] - Titles of completed tasks
   * @param {string}   [options.outcome]    - 'success' | 'partial' | 'failed'
   * @param {object}   [options.metrics]    - Key metrics (duration, errors, etc.)
   * @returns {TaskHistoryEntry}
   */
  record(options) {
    const {
      mode,
      goal,
      projectId = null,
      taskCount = 0,
      taskTitles = [],
      outcome = 'success',
      metrics = {},
    } = options;

    const summary = _buildSummary(goal, taskTitles, outcome);

    const entry = {
      id: `TH-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
      timestamp: new Date().toISOString(),
      mode,
      projectId,
      goal: (goal || '').slice(0, 300),
      taskCount,
      taskTitles: taskTitles.slice(0, 10).map(t => (t || '').slice(0, 80)),
      outcome,
      summary,
      metrics: {
        durationMs: metrics.durationMs || null,
        errorCount: metrics.errorCount || 0,
        expRecorded: metrics.expRecorded || 0,
      },
    };

    this.entries.push(entry);

    // FIFO eviction if over capacity
    if (this.entries.length > MAX_HISTORY_ENTRIES) {
      this.entries = this.entries.slice(-MAX_HISTORY_ENTRIES);
    }

    this._save();
    return entry;
  }

  /**
   * Returns a formatted Markdown block for prompt injection.
   * Contains the most recent N task summaries as "Recall Memory".
   *
   * @param {number} [limit=MAX_RECALL_ENTRIES] - Max entries to include
   * @returns {string} Markdown block (empty string if no history)
   */
  getRecallBlock(limit = MAX_RECALL_ENTRIES) {
    if (this.entries.length === 0) return '';

    const recent = this.entries.slice(-limit).reverse(); // newest first

    const lines = [
      '## 📖 Recall Memory (Recent Sessions)',
      '',
      '_Previous workflow sessions for context continuity:_',
      '',
    ];

    for (const entry of recent) {
      const date = entry.timestamp.slice(0, 10);
      const time = entry.timestamp.slice(11, 16);
      const icon = entry.outcome === 'success' ? '✅'
                 : entry.outcome === 'partial' ? '⚠️'
                 : '❌';
      lines.push(`${icon} **[${date} ${time}]** ${entry.summary}`);
      if (entry.taskTitles.length > 0) {
        const taskList = entry.taskTitles.slice(0, 5).map(t => `\`${t}\``).join(', ');
        lines.push(`   Tasks: ${taskList}${entry.taskTitles.length > 5 ? ` (+${entry.taskTitles.length - 5} more)` : ''}`);
      }
      lines.push('');
    }

    lines.push('> _Use this context to maintain continuity with previous work. Do not repeat completed tasks._');

    return lines.join('\n');
  }

  /**
   * Returns raw entries for programmatic access.
   *
   * @param {number} [limit=MAX_RECALL_ENTRIES]
   * @returns {TaskHistoryEntry[]}
   */
  getRecent(limit = MAX_RECALL_ENTRIES) {
    return this.entries.slice(-limit).reverse();
  }

  /**
   * Returns stats about the task history.
   */
  getStats() {
    return {
      totalEntries: this.entries.length,
      successCount: this.entries.filter(e => e.outcome === 'success').length,
      failedCount: this.entries.filter(e => e.outcome === 'failed').length,
      partialCount: this.entries.filter(e => e.outcome === 'partial').length,
      oldestEntry: this.entries.length > 0 ? this.entries[0].timestamp : null,
      newestEntry: this.entries.length > 0 ? this.entries[this.entries.length - 1].timestamp : null,
    };
  }

  // ─── Private: Persistence ─────────────────────────────────────────────────

  _load() {
    try {
      if (fs.existsSync(this.storePath)) {
        const data = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
        if (Array.isArray(data)) {
          this.entries = data;
          console.log(`[TaskHistory] Loaded ${this.entries.length} history entries`);
        }
      }
    } catch (err) {
      console.warn(`[TaskHistory] Could not load task history: ${err.message}`);
    }
  }

  _save() {
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // Atomic write (tmp + rename)
      const tmpPath = this.storePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(this.entries, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.storePath);
    } catch (err) {
      console.warn(`[TaskHistory] Could not save task history: ${err.message}`);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Builds a compact summary string from goal and task titles.
 * @param {string} goal
 * @param {string[]} taskTitles
 * @param {string} outcome
 * @returns {string}
 */
function _buildSummary(goal, taskTitles, outcome) {
  const goalSnippet = (goal || 'Unknown goal').slice(0, 100);
  const taskInfo = taskTitles.length > 0
    ? ` (${taskTitles.length} task${taskTitles.length > 1 ? 's' : ''})`
    : '';
  const outcomeLabel = outcome === 'success' ? 'completed'
                     : outcome === 'partial' ? 'partially completed'
                     : 'failed';
  const raw = `${goalSnippet}${taskInfo} — ${outcomeLabel}`;
  return raw.slice(0, MAX_SUMMARY_CHARS);
}

module.exports = { TaskHistory, MAX_HISTORY_ENTRIES, MAX_RECALL_ENTRIES };
