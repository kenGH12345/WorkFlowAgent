/**
 * EventJournal – Append-only Event Sourcing Log (P2-1)
 *
 * Implements a lightweight, append-only event journal that captures every
 * HookSystem event emitted during a workflow session. Provides:
 *
 *   - Structured observability: every LLM call, state transition, artifact,
 *     and error is recorded with full payload
 *   - Replay foundation: events can be replayed to reconstruct session state
 *   - Debugging: query past events by type, stage, or time range
 *   - Audit trail: immutable, append-only — events are never modified or deleted
 *
 * Design references:
 *   - Restate's deterministic journal (append-only, idempotent replay)
 *   - OpenHands EventStream (event-driven agent lifecycle)
 *   - Martin Fowler's Event Sourcing pattern (state = f(events))
 *   - Kafka's log-centric design (append-only, sequential, partitioned)
 *
 * Storage format: JSONL (JSON Lines) — one JSON object per line.
 *   Advantages over single-JSON-array:
 *     - O(1) append (no need to parse or rewrite the file)
 *     - Crash-safe (partial writes only corrupt the last line, not the file)
 *     - Streamable (can tail -f for live monitoring)
 *     - Easy to compress/archive per-session
 *
 * Integration: The EventJournal subscribes to HookSystem as a universal
 * listener. When `attachToHookSystem(hooks)` is called, it wraps the original
 * `emit()` to capture all events without modifying any existing emitters.
 *
 * @module event-journal
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Event Categories ───────────────────────────────────────────────────────

/**
 * Event categories for filtering and querying.
 * Each HookSystem event is mapped to a category for structured access.
 */
const EventCategory = {
  LIFECYCLE:     'lifecycle',      // workflow start/end, state transitions
  STAGE:         'stage',          // stage started/ended/heartbeat/timeout
  LLM:           'llm',            // LLM calls, prompt traces
  ARTIFACT:      'artifact',       // artifact produced, file operations
  AGENT:         'agent',          // task claimed/completed/failed, boundary violations
  EXPERIENCE:    'experience',     // experience recorded, skill evolved
  CI:            'ci',             // CI pipeline events
  GIT:           'git',            // git branch/PR events
  ERROR:         'error',          // workflow errors, pipeline failures
  DRYRUN:        'dryrun',         // dry-run sandbox events
  PROMPT:        'prompt',         // prompt variant A/B testing
  CODE_GRAPH:    'code_graph',     // code graph built/queried
  COMPLAINT:     'complaint',      // complaint filed/resolved
  NEGOTIATION:   'negotiation',    // agent negotiation events
  SYSTEM:        'system',         // journal start/stop, internal events
};

/**
 * Maps HOOK_EVENTS names to EventCategory values.
 * Events not in this map default to 'system'.
 */
const EVENT_CATEGORY_MAP = {
  before_state_transition:    EventCategory.LIFECYCLE,
  after_state_transition:     EventCategory.LIFECYCLE,
  workflow_complete:          EventCategory.LIFECYCLE,
  workflow_error:             EventCategory.ERROR,
  stage_started:              EventCategory.STAGE,
  stage_ended:                EventCategory.STAGE,
  stage_artifact_produced:    EventCategory.ARTIFACT,
  stage_heartbeat:            EventCategory.STAGE,
  stage_timeout:              EventCategory.STAGE,
  llm_call_recorded:          EventCategory.LLM,
  task_claimed:               EventCategory.AGENT,
  task_completed:             EventCategory.AGENT,
  task_failed:                EventCategory.AGENT,
  task_interrupted:           EventCategory.AGENT,
  experience_recorded:        EventCategory.EXPERIENCE,
  skill_evolved:              EventCategory.EXPERIENCE,
  skill_auto_created:         EventCategory.EXPERIENCE,
  complaint_filed:            EventCategory.COMPLAINT,
  complaint_resolved:         EventCategory.COMPLAINT,
  ci_pipeline_started:        EventCategory.CI,
  ci_pipeline_complete:       EventCategory.CI,
  ci_pipeline_failed:         EventCategory.CI,
  code_graph_built:           EventCategory.CODE_GRAPH,
  code_graph_queried:         EventCategory.CODE_GRAPH,
  git_branch_created:         EventCategory.GIT,
  git_branch_pushed:          EventCategory.GIT,
  git_pr_created:             EventCategory.GIT,
  git_pr_merged:              EventCategory.GIT,
  dryrun_started:             EventCategory.DRYRUN,
  dryrun_op_recorded:         EventCategory.DRYRUN,
  dryrun_report_saved:        EventCategory.DRYRUN,
  dryrun_applied:             EventCategory.DRYRUN,
  prompt_variant_promoted:    EventCategory.PROMPT,
  prompt_variant_rolledback:  EventCategory.PROMPT,
  html_report_generated:      EventCategory.ARTIFACT,
  file_lock_conflict:         EventCategory.ERROR,
  agent_boundary_violation:   EventCategory.ERROR,
  human_review_required:      EventCategory.LIFECYCLE,
  negotiate_request:          EventCategory.NEGOTIATION,
  negotiate_response:         EventCategory.NEGOTIATION,
};

// ─── EventJournal ───────────────────────────────────────────────────────────

class EventJournal {

  /**
   * @param {object} opts
   * @param {string} opts.outputDir     - Directory for journal files (default: workflow/output)
   * @param {string} [opts.sessionId]   - Unique session identifier (auto-generated if omitted)
   * @param {boolean} [opts.enabled=true] - Set false to create a no-op journal
   * @param {number} [opts.flushIntervalMs=5000] - Batch flush interval in ms
   * @param {number} [opts.maxBufferSize=50]     - Max events before force-flush
   */
  constructor(opts = {}) {
    this._enabled = opts.enabled !== false;
    this._sessionId = opts.sessionId || this._generateSessionId();
    this._outputDir = opts.outputDir || path.join(__dirname, '..', 'output');
    this._flushIntervalMs = opts.flushIntervalMs || 5000;
    this._maxBufferSize = opts.maxBufferSize || 50;

    // Monotonically increasing sequence number for event ordering
    this._seq = 0;

    // In-memory buffer for batch writes (avoids per-event I/O)
    this._buffer = [];

    // Track current stage for automatic stage context injection
    this._currentStage = null;

    // Journal file path
    this._journalPath = path.join(
      this._outputDir,
      `event-journal-${this._sessionId}.jsonl`
    );

    // Periodic flush timer
    this._flushTimer = null;

    // Stats
    this._stats = {
      totalEvents: 0,
      eventsByCategory: {},
      firstEventTs: null,
      lastEventTs: null,
      flushCount: 0,
      errors: 0,
    };

    if (this._enabled) {
      this._ensureOutputDir();
      this._startFlushTimer();
      // Record journal-start as the first event
      this._appendInternal('journal_start', EventCategory.SYSTEM, {
        sessionId: this._sessionId,
        journalPath: this._journalPath,
        startedAt: new Date().toISOString(),
      });
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * Appends an event to the journal.
   *
   * @param {string} eventType  - Event type name (e.g. 'stage_started')
   * @param {object} [data={}]  - Event payload (must be JSON-serializable)
   * @param {object} [meta={}]  - Additional metadata (stage, category override)
   */
  append(eventType, data = {}, meta = {}) {
    if (!this._enabled) return;

    const category = meta.category || EVENT_CATEGORY_MAP[eventType] || EventCategory.SYSTEM;
    this._appendInternal(eventType, category, data, meta);
  }

  /**
   * Attaches the journal to a HookSystem instance as a universal event subscriber.
   *
   * Implementation: wraps HookSystem.emit() to intercept all events without
   * modifying any existing handler registrations.
   *
   * @param {object} hookSystem - HookSystem instance with emit() method
   */
  attachToHookSystem(hookSystem) {
    if (!this._enabled || !hookSystem || typeof hookSystem.emit !== 'function') return;

    const journal = this;
    const originalEmit = hookSystem.emit.bind(hookSystem);

    hookSystem.emit = async function journalWrappedEmit(event, payload = {}) {
      // Track current stage from lifecycle events
      if (event === 'stage_started' && payload.stage) {
        journal._currentStage = payload.stage;
      } else if (event === 'stage_ended' && payload.stage) {
        journal._currentStage = null;
      } else if (event === 'before_state_transition' && payload.toState) {
        journal._currentStage = `${payload.fromState}→${payload.toState}`;
      }

      // Capture the event into the journal
      const safePayload = journal._sanitizePayload(payload);
      journal.append(event, safePayload, { stage: journal._currentStage });

      // Call the original emit (preserve all existing behavior)
      return originalEmit(event, payload);
    };

    console.log(`[EventJournal] 📖 Attached to HookSystem — capturing all events to ${path.basename(this._journalPath)}`);
  }

  /**
   * Queries journal events from the current session's in-memory buffer + disk.
   *
   * @param {object} [filter]
   * @param {string} [filter.event]     - Filter by event type
   * @param {string} [filter.category]  - Filter by event category
   * @param {string} [filter.stage]     - Filter by stage name
   * @param {number} [filter.since]     - Filter events after this timestamp (ms)
   * @param {number} [filter.until]     - Filter events before this timestamp (ms)
   * @param {number} [filter.limit=100] - Max events to return
   * @returns {Array<object>} Matching events (newest first)
   */
  query(filter = {}) {
    const events = this._readAllEvents();
    const limit = filter.limit || 100;

    let filtered = events;

    if (filter.event) {
      filtered = filtered.filter(e => e.event === filter.event);
    }
    if (filter.category) {
      filtered = filtered.filter(e => e.category === filter.category);
    }
    if (filter.stage) {
      filtered = filtered.filter(e => e.stage === filter.stage);
    }
    if (filter.since) {
      filtered = filtered.filter(e => e.ts >= filter.since);
    }
    if (filter.until) {
      filtered = filtered.filter(e => e.ts <= filter.until);
    }

    // Return newest first, limited
    return filtered.reverse().slice(0, limit);
  }

  /**
   * Returns a human-readable summary of the journal for this session.
   * @returns {string} Markdown-formatted summary
   */
  getSummary() {
    const stats = this.getStats();
    const durationMs = stats.lastEventTs && stats.firstEventTs
      ? stats.lastEventTs - stats.firstEventTs
      : 0;
    const durationStr = durationMs > 0
      ? `${(durationMs / 1000).toFixed(1)}s`
      : 'n/a';

    let md = `## 📖 Event Journal Summary\n\n`;
    md += `- **Session**: \`${this._sessionId}\`\n`;
    md += `- **Total events**: ${stats.totalEvents}\n`;
    md += `- **Duration**: ${durationStr}\n`;
    md += `- **Journal file**: \`${path.basename(this._journalPath)}\`\n\n`;

    if (Object.keys(stats.eventsByCategory).length > 0) {
      md += `### Events by Category\n\n`;
      md += `| Category | Count |\n|----------|-------|\n`;
      for (const [cat, count] of Object.entries(stats.eventsByCategory).sort((a, b) => b[1] - a[1])) {
        md += `| ${cat} | ${count} |\n`;
      }
    }

    return md;
  }

  /**
   * Returns statistics about the journal.
   * @returns {object}
   */
  getStats() {
    return { ...this._stats, sessionId: this._sessionId };
  }

  /**
   * Flushes the in-memory buffer to disk and stops the flush timer.
   * Must be called during workflow shutdown.
   */
  async close() {
    if (!this._enabled) return;

    // Record journal-end event
    this._appendInternal('journal_end', EventCategory.SYSTEM, {
      sessionId: this._sessionId,
      totalEvents: this._stats.totalEvents,
      endedAt: new Date().toISOString(),
    });

    // Final flush
    this._flush();

    // Stop timer
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }

    console.log(`[EventJournal] 📖 Closed. ${this._stats.totalEvents} events written to ${path.basename(this._journalPath)}`);
  }

  /**
   * Returns the journal file path.
   * @returns {string}
   */
  get journalPath() {
    return this._journalPath;
  }

  /**
   * Returns the session ID.
   * @returns {string}
   */
  get sessionId() {
    return this._sessionId;
  }

  // ─── Internal Methods ───────────────────────────────────────────────────

  /**
   * Appends an event to the internal buffer.
   * @private
   */
  _appendInternal(eventType, category, data, meta = {}) {
    const now = Date.now();
    const entry = {
      seq: this._seq++,
      ts: now,
      iso: new Date(now).toISOString(),
      event: eventType,
      category,
      stage: meta.stage || this._currentStage || null,
      sessionId: this._sessionId,
      data,
    };

    this._buffer.push(entry);

    // Update stats
    this._stats.totalEvents++;
    this._stats.eventsByCategory[category] = (this._stats.eventsByCategory[category] || 0) + 1;
    if (!this._stats.firstEventTs) this._stats.firstEventTs = now;
    this._stats.lastEventTs = now;

    // Auto-flush when buffer is full
    if (this._buffer.length >= this._maxBufferSize) {
      this._flush();
    }
  }

  /**
   * Sanitizes a payload for safe JSON serialization.
   * Removes circular references, functions, and large objects.
   * Truncates long strings to avoid journal bloat.
   * @private
   */
  _sanitizePayload(payload) {
    if (!payload || typeof payload !== 'object') return payload;

    const MAX_STRING_LEN = 500;
    const MAX_DEPTH = 3;

    const sanitize = (obj, depth) => {
      if (depth > MAX_DEPTH) return '[depth-limited]';
      if (obj === null || obj === undefined) return obj;
      if (typeof obj === 'function') return '[function]';
      if (typeof obj === 'string') {
        return obj.length > MAX_STRING_LEN
          ? obj.slice(0, MAX_STRING_LEN) + `...[truncated:${obj.length}]`
          : obj;
      }
      if (typeof obj !== 'object') return obj;
      if (obj instanceof Error) {
        return { message: obj.message, name: obj.name, stack: (obj.stack || '').slice(0, 300) };
      }
      if (Array.isArray(obj)) {
        return obj.slice(0, 20).map(item => sanitize(item, depth + 1));
      }

      const result = {};
      const keys = Object.keys(obj);
      for (const key of keys.slice(0, 30)) {
        try {
          result[key] = sanitize(obj[key], depth + 1);
        } catch (_) {
          result[key] = '[unserializable]';
        }
      }
      if (keys.length > 30) result['...'] = `${keys.length - 30} more keys`;
      return result;
    };

    return sanitize(payload, 0);
  }

  /**
   * Flushes the in-memory buffer to disk (JSONL append).
   * @private
   */
  _flush() {
    if (this._buffer.length === 0) return;

    const lines = this._buffer.map(entry => {
      try {
        return JSON.stringify(entry);
      } catch (err) {
        this._stats.errors++;
        return JSON.stringify({
          seq: entry.seq,
          ts: entry.ts,
          event: entry.event,
          category: 'error',
          stage: entry.stage,
          sessionId: entry.sessionId,
          data: { error: `Serialization failed: ${err.message}` },
        });
      }
    });

    try {
      fs.appendFileSync(this._journalPath, lines.join('\n') + '\n', 'utf-8');
      this._stats.flushCount++;
    } catch (err) {
      this._stats.errors++;
      console.warn(`[EventJournal] ⚠️ Failed to flush ${lines.length} events: ${err.message}`);
    }

    this._buffer = [];
  }

  /**
   * Reads all events from the journal file + current buffer.
   * @private
   * @returns {Array<object>}
   */
  _readAllEvents() {
    const events = [];

    // Read from disk
    if (fs.existsSync(this._journalPath)) {
      try {
        const content = fs.readFileSync(this._journalPath, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            events.push(JSON.parse(line));
          } catch (_) { /* skip malformed lines */ }
        }
      } catch (err) {
        console.warn(`[EventJournal] ⚠️ Failed to read journal: ${err.message}`);
      }
    }

    // Add unflushed buffer events
    events.push(...this._buffer);

    return events;
  }

  /**
   * Generates a short, unique session ID.
   * Format: YYYYMMDD-HHmmss-xxxx (date + time + random suffix)
   * @private
   */
  _generateSessionId() {
    const now = new Date();
    const Y = now.getFullYear();
    const M = String(now.getMonth() + 1).padStart(2, '0');
    const D = String(now.getDate()).padStart(2, '0');
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    const rand = crypto.randomBytes(2).toString('hex');
    return `${Y}${M}${D}-${h}${m}${s}-${rand}`;
  }

  /**
   * Ensures the output directory exists.
   * @private
   */
  _ensureOutputDir() {
    try {
      if (!fs.existsSync(this._outputDir)) {
        fs.mkdirSync(this._outputDir, { recursive: true });
      }
    } catch (_) { /* non-fatal */ }
  }

  /**
   * Starts the periodic flush timer.
   * @private
   */
  _startFlushTimer() {
    if (this._flushTimer) return;
    this._flushTimer = setInterval(() => {
      this._flush();
    }, this._flushIntervalMs);

    // Ensure timer doesn't keep Node.js process alive
    if (this._flushTimer.unref) {
      this._flushTimer.unref();
    }
  }
}

// ─── Static Helpers ─────────────────────────────────────────────────────────

/**
 * Loads and parses an existing journal file from disk.
 * Useful for post-session analysis.
 *
 * @param {string} journalPath - Path to a .jsonl journal file
 * @param {object} [filter]    - Optional filter (same as EventJournal.query)
 * @returns {Array<object>} Parsed events
 */
function loadJournal(journalPath, filter = {}) {
  if (!fs.existsSync(journalPath)) return [];

  const content = fs.readFileSync(journalPath, 'utf-8');
  let events = content
    .split('\n')
    .filter(l => l.trim())
    .map(line => {
      try { return JSON.parse(line); }
      catch (_) { return null; }
    })
    .filter(Boolean);

  // Apply filters
  if (filter.event)    events = events.filter(e => e.event === filter.event);
  if (filter.category) events = events.filter(e => e.category === filter.category);
  if (filter.stage)    events = events.filter(e => e.stage === filter.stage);
  if (filter.since)    events = events.filter(e => e.ts >= filter.since);
  if (filter.until)    events = events.filter(e => e.ts <= filter.until);
  if (filter.limit)    events = events.slice(-filter.limit);

  return events;
}

/**
 * Lists all journal files in the output directory, sorted by date (newest first).
 *
 * @param {string} outputDir - Path to the output directory
 * @returns {Array<{path: string, sessionId: string, size: number, modified: Date}>}
 */
function listJournals(outputDir) {
  if (!fs.existsSync(outputDir)) return [];

  return fs.readdirSync(outputDir)
    .filter(f => f.startsWith('event-journal-') && f.endsWith('.jsonl'))
    .map(f => {
      const fullPath = path.join(outputDir, f);
      const stat = fs.statSync(fullPath);
      const sessionId = f.replace('event-journal-', '').replace('.jsonl', '');
      return { path: fullPath, sessionId, size: stat.size, modified: stat.mtime };
    })
    .sort((a, b) => b.modified - a.modified);
}

module.exports = { EventJournal, EventCategory, EVENT_CATEGORY_MAP, loadJournal, listJournals };
