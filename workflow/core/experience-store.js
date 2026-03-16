/**
 * Experience Store – Persistent experience accumulation across sessions
 *
 * Inspired by AgentFlow's experience feedback mechanism:
 *  - Positive experiences: reusable solutions, stable patterns, best practices
 *  - Negative experiences: pitfalls, anti-patterns, known failure modes
 *  - Experiences survive across conversations (never cleared)
 *  - High-frequency positive experiences trigger Skill evolution
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS } = require('./constants');

// ─── Experience Types ─────────────────────────────────────────────────────────

const ExperienceType = {
  POSITIVE: 'positive',  // Reusable, directly applicable
  NEGATIVE: 'negative',  // Pitfall, anti-pattern, avoid
};

// ─── Experience Categories ────────────────────────────────────────────────────

const ExperienceCategory = {
  // ── Original categories ──
  MODULE_USAGE:      'module_usage',      // How to use a specific module/API
  FRAMEWORK_LIMIT:   'framework_limit',   // Known framework limitations
  STABLE_PATTERN:    'stable_pattern',    // Proven stable implementation pattern
  PITFALL:           'pitfall',           // Known failure mode or trap
  PERFORMANCE:       'performance',       // Performance optimization insight
  DEBUG_TECHNIQUE:   'debug_technique',   // Debugging approach that worked
  ARCHITECTURE:      'architecture',      // Architectural decision insight
  ENGINE_API:        'engine_api',        // Engine-specific API usage (Unity/Cocos etc.)
  // ── Extended categories for code scanning ──
  UTILITY_CLASS:     'utility_class',     // Reusable utility/helper class
  INTERFACE_DEF:     'interface_def',     // Interface definition and contract
  COMPONENT:         'component',         // Reusable component (UI, Entity, etc.)
  WORKFLOW_PROCESS:  'workflow_process',  // Business/game workflow and process flow
  FRAMEWORK_MODULE:  'framework_module',  // Framework module (Event, Resource, UI, etc.)
  DATA_STRUCTURE:    'data_structure',    // Custom data structure or collection
  PROCEDURE:         'procedure',         // Game procedure / state machine step
  NETWORK_PROTOCOL:  'network_protocol',  // Network message / protocol definition
  CONFIG_SYSTEM:     'config_system',     // Configuration and data table system
  OBJECT_POOL:       'object_pool',       // Object pool and reference pool usage
  EVENT_SYSTEM:      'event_system',      // Event subscription/dispatch pattern
  RESOURCE_LOAD:     'resource_load',     // Asset/resource loading pattern
  UI_PATTERN:        'ui_pattern',        // UI form/widget usage pattern
  SOUND_SYSTEM:      'sound_system',      // Sound/audio system usage
  ENTITY_SYSTEM:     'entity_system',     // Entity lifecycle and management
  LUA_PATTERN:       'lua_pattern',       // Lua-specific coding pattern
  CSHARP_PATTERN:    'csharp_pattern',    // C#-specific coding pattern
};

// ─── Experience Store ─────────────────────────────────────────────────────────

class ExperienceStore {
  /**
   * @param {string} [storePath] - Path to persist experience JSON
   */
  constructor(storePath = null) {
    this.storePath = storePath || path.join(PATHS.OUTPUT_DIR, 'experiences.json');
    /** @type {Experience[]} */
    this.experiences = [];
    // N65 fix: initialise _dirty so flushDirty() never reads undefined.
    this._dirty = false;
    // In-memory title index for O(1) dedup checks and atomic recordIfAbsent().
    // Built from disk on _load(); kept in sync by record() and batchRecord().
    /** @type {Set<string>} */
    this._titleIndex = new Set();
    this._load();
  }

  // ─── Public API ───────────────────────────────────────────────────────────────

  /**
   * Records a new experience.
   *
   * @param {object} options
   * @param {string}   options.type       - ExperienceType.POSITIVE or NEGATIVE
   * @param {string}   options.category   - ExperienceCategory value
   * @param {string}   options.title      - Short summary (one line)
   * @param {string}   options.content    - Detailed description with context
   * @param {string}   [options.taskId]   - Source task ID
   * @param {string}   [options.skill]    - Related skill name
   * @param {string[]} [options.tags]     - Searchable tags
   * @param {string}   [options.codeExample] - Code snippet demonstrating the experience
   * @returns {Experience}
   */
  record(options) {
    const { type, category, title, content, taskId = null, skill = null, tags = [], codeExample = null } = options;
    const id = `EXP-${Date.now()}-${Math.random().toString(36).slice(2, 9).toUpperCase()}`;
    // Default TTL: negative experiences expire after 90 days, positive after 365 days.
    // Callers can override by passing options.ttlDays = null to disable expiry.
    const ttlDays = options.ttlDays !== undefined
      ? options.ttlDays
      : (type === ExperienceType.NEGATIVE ? 90 : 365);
    const expiresAt = ttlDays != null
      ? new Date(Date.now() + ttlDays * 86400_000).toISOString()
      : null;
    const exp = {
      id,
      type,
      category,
      title,
      content,
      taskId,
      skill,
      tags,
      codeExample,
      sourceFile: options.sourceFile || null,   // Source file path (from code scan)
      namespace: options.namespace || null,      // C# namespace or Lua module
      hitCount: 0,          // How many times this experience was retrieved and used
      evolutionCount: 0,    // How many times this triggered a skill evolution
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt,            // ISO string or null (null = never expires)
    };
    this.experiences.push(exp);
    this._titleIndex.add(exp.title);
    this._save();
    return exp;
  }

  /**
   * Searches experiences by keyword, type, category, skill, or tags.
   * Supports multi-keyword search and relevance scoring for precise hits.
   *
   * @param {object} query
   * @param {string}   [query.keyword]    - Text search in title/content/tags (space-separated for multi-keyword)
   * @param {string}   [query.type]       - Filter by ExperienceType
   * @param {string}   [query.category]   - Filter by ExperienceCategory
   * @param {string}   [query.skill]      - Filter by skill name
   * @param {string[]} [query.tags]       - Filter by tags (any match)
   * @param {string}   [query.sourceFile] - Filter by source file path
   * @param {number}   [query.limit=10]   - Max results
   * @param {boolean}  [query.scoreSort]  - Sort by relevance score instead of hitCount
   * @returns {Experience[]}
   */
  search({ keyword = null, type = null, category = null, skill = null, tags = null, sourceFile = null, limit = 10, scoreSort = false } = {}) {
    const now = Date.now();
    // Filter out expired experiences before any other filtering
    let results = this.experiences.filter(e => !e.expiresAt || new Date(e.expiresAt).getTime() > now);

    if (type) results = results.filter(e => e.type === type);
    if (category) results = results.filter(e => e.category === category);
    if (skill) results = results.filter(e => e.skill === skill);
    if (sourceFile) results = results.filter(e => e.sourceFile && e.sourceFile.includes(sourceFile));
    if (tags && tags.length > 0) {
      results = results.filter(e =>
        tags.some(tag => e.tags.some(t => t.toLowerCase().includes(tag.toLowerCase())))
      );
    }

    if (keyword) {
      // Multi-keyword: split by space, score each result
      const keywords = keyword.toLowerCase().split(/\s+/).filter(Boolean);
      results = results
        .map(e => {
          let score = 0;
          const titleLower = e.title.toLowerCase();
          const contentLower = e.content.toLowerCase();
          const tagsLower = e.tags.map(t => t.toLowerCase());
          for (const kw of keywords) {
            if (titleLower.includes(kw)) score += 10;       // Title match: highest weight
            if (tagsLower.some(t => t.includes(kw))) score += 6; // Tag match: high weight
            if (contentLower.includes(kw)) score += 2;     // Content match: base weight
          }
          return { exp: e, score };
        })
        .filter(({ score }) => score > 0)
        .sort((a, b) => scoreSort ? b.score - a.score : b.exp.hitCount - a.exp.hitCount)
        .map(({ exp }) => exp);
    } else {
      // Sort by hitCount desc (most useful first)
      results = results.sort((a, b) => b.hitCount - a.hitCount);
    }

    return results.slice(0, limit);
  }

  /**
   * Checks if an experience with the same title already exists (dedup).
   *
   * @param {string} title
   * @returns {Experience|null}
   */
  findByTitle(title) {
    return this.experiences.find(e => e.title === title) || null;
  }

  /**
   * Updates an existing experience's content by appending new information.
   * Used for negative experiences where the same pitfall recurs with new context.
   * Only updates if the new content is not already present (avoids duplicate appends).
   *
   * @param {string} title - Title of the experience to update
   * @param {string} additionalContent - New content to append
   * @returns {Experience|null} Updated experience, or null if not found
   */
  appendByTitle(title, additionalContent) {
    const exp = this.findByTitle(title);
    if (!exp) return null;
    // Skip if the additional content is already present (idempotent).
    // N40 fix: 60-char prefix is too short – two different failure contexts that start
    // with the same boilerplate (e.g. "After 2 self-correction round(s)...") would be
    // incorrectly treated as duplicates. Use 120 chars for a more reliable dedup check.
    if (exp.content.includes(additionalContent.slice(0, 120))) return exp;
    exp.content = `${exp.content}\n\n[Update ${new Date().toISOString().slice(0, 10)}] ${additionalContent}`;
    exp.updatedAt = new Date().toISOString();
    this._save();
    return exp;
  }

  /**
   * Atomically records an experience only if no entry with the same title exists.
   * Uses an in-memory title Set as a write-lock so concurrent workers cannot
   * both pass the findByTitle() check and then both call record(), which would
   * produce duplicate entries in the store.
   *
   * This is the preferred method for all conditional writes in _runAgentWorker.
   * It replaces the pattern:
   *   if (!this.experienceStore.findByTitle(title)) { this.experienceStore.record(...) }
   * with a single atomic call:
   *   this.experienceStore.recordIfAbsent(title, options)
   *
   * @param {string} title   - Dedup key (must match options.title)
   * @param {object} options - Same as record()
   * @returns {Experience|null} The new experience, or null if already existed
   */
  recordIfAbsent(title, options) {
    // Fast path: check in-memory title index first (O(1), no array scan)
    if (this._titleIndex.has(title)) return null;
    // Double-check against the full array in case _titleIndex is out of sync
    // (e.g. experiences loaded from disk before _titleIndex was built)
    if (this.findByTitle(title)) {
      this._titleIndex.add(title); // repair index
      return null;
    }
    // Claim the title slot before calling record() so no other concurrent
    // caller can sneak in between the check above and the push below.
    this._titleIndex.add(title);
    return this.record(options);
  }

  /**
   * Batch-records multiple experiences, skipping duplicates by title.
   *
   * @param {object[]} items - Array of experience options
   * @returns {{ added: number, skipped: number }}
   */
  batchRecord(items) {
    let added = 0;
    let skipped = 0;
    // N35 fix: use a per-batch counter to guarantee unique IDs even when multiple
    // items are processed within the same millisecond (Date.now() collision risk).
    let batchSeq = 0;
    for (const item of items) {
      if (this._titleIndex.has(item.title) || this.findByTitle(item.title)) {
        this._titleIndex.add(item.title); // repair index if needed
        skipped++;
        continue;
      }
      // Claim the title slot immediately to prevent concurrent duplicates
      this._titleIndex.add(item.title);
      // Push directly without saving on each record
      const { type, category, title, content, taskId = null, skill = null, tags = [], codeExample = null } = item;
      const id = `EXP-${Date.now()}-${String(batchSeq++).padStart(4, '0')}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
      // Apply the same TTL logic as record() so batch-imported experiences also expire.
      // Previously batchRecord() skipped this, causing batch entries to never expire
      // even when they were negative experiences (pitfalls, anti-patterns).
      const ttlDays = item.ttlDays !== undefined
        ? item.ttlDays
        : (type === ExperienceType.NEGATIVE ? 90 : 365);
      const expiresAt = ttlDays != null
        ? new Date(Date.now() + ttlDays * 86400_000).toISOString()
        : null;
      this.experiences.push({
        id, type, category, title, content, taskId, skill, tags, codeExample,
        sourceFile: item.sourceFile || null,
        namespace: item.namespace || null,
        hitCount: 0, evolutionCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt,
      });
      added++;
    }
    // Single save after all items are processed
    if (added > 0) this._save();
    return { added, skipped };
  }

  /**
   * Marks an experience as "used" (increments hitCount).
   * High hitCount positive experiences are candidates for skill evolution.
   *
   * N59 fix: avoid writing to disk on every markUsed() call.
   * In high-frequency task scenarios (e.g. 100 tasks each calling markUsed()),
   * the previous implementation triggered 100 full JSON serialise+rename cycles.
   * New strategy:
   *   - Only _save() when hitCount reaches EVOLUTION_THRESHOLD (the only moment
   *     that MUST be persisted immediately, because it triggers skill evolution).
   *   - For all other increments, set a dirty flag and defer the save to the next
   *     natural _save() call (e.g. record(), appendByTitle(), batchRecord()).
   *   - Callers that need guaranteed persistence can call flushDirty() explicitly.
   *
   * @param {string} expId
   * @returns {boolean} true if this experience should trigger skill evolution
   */
  markUsed(expId) {
    const exp = this.experiences.find(e => e.id === expId);
    if (!exp) return false;
    exp.hitCount += 1;
    exp.updatedAt = new Date().toISOString();

    // Trigger evolution only exactly at the threshold (not every call after)
    const EVOLUTION_THRESHOLD = 3;
    const shouldEvolve = exp.type === ExperienceType.POSITIVE && exp.hitCount === EVOLUTION_THRESHOLD;

    if (shouldEvolve) {
      // Must persist immediately so the evolution trigger is not lost on crash
      this._save();
    } else {
      // Defer: mark dirty so the next natural _save() will flush this increment
      this._dirty = true;
    }

    return shouldEvolve;
  }

  /**
   * Flushes any pending dirty state to disk.
   * Call this after a batch of markUsed() calls to ensure all hitCount
   * increments are persisted without waiting for the next natural _save().
   */
  flushDirty() {
    if (this._dirty) {
      this._save();
      this._dirty = false;
    }
  }

  /**
   * Purges all expired experiences from the store and persists the result.
   * Call this periodically (e.g. at workflow start) to keep the store lean.
   *
   * @returns {{ purged: number, remaining: number }}
   */
  purgeExpired() {
    const now = Date.now();
    const before = this.experiences.length;
    this.experiences = this.experiences.filter(e => !e.expiresAt || new Date(e.expiresAt).getTime() > now);
    // Rebuild title index after purge
    this._titleIndex = new Set(this.experiences.map(e => e.title));
    const purged = before - this.experiences.length;
    if (purged > 0) {
      this._save();
      console.log(`[ExperienceStore] Purged ${purged} expired experience(s). Remaining: ${this.experiences.length}`);
    }
    return { purged, remaining: this.experiences.length };
  }

  /**
   * Returns a formatted context block for injection into agent prompts.
   * Includes top positive experiences and all negative experiences for a skill.
   *
   * @param {string} [skill] - Filter by skill name. If null, returns empty string
   *   to avoid injecting unrelated cross-skill experiences into agent prompts.
   * @returns {string} Markdown-formatted experience context
   */
  getContextBlock(skill = null) {
    // N22 fix: when skill is null, return empty string instead of querying all experiences.
    // Injecting experiences from all skill domains into a single agent prompt causes
    // irrelevant context noise and may mislead the agent.
    if (!skill) {
      return '';
    }

    const positives = this.search({ type: ExperienceType.POSITIVE, skill, limit: 5, scoreSort: true });
    const negatives = this.search({ type: ExperienceType.NEGATIVE, skill, limit: 5, scoreSort: true });

    const lines = ['## Accumulated Experience\n'];

    if (positives.length > 0) {
      lines.push('### ✅ Proven Patterns (use these)');
      for (const exp of positives) {
        lines.push(`\n**[${exp.category}] ${exp.title}**`);
        lines.push(exp.content);
        if (exp.codeExample) {
          lines.push('```');
          lines.push(exp.codeExample);
          lines.push('```');
        }
      }
    }

    if (negatives.length > 0) {
      lines.push('\n### ❌ Known Pitfalls (avoid these)');
      for (const exp of negatives) {
        lines.push(`\n**[${exp.category}] ${exp.title}**`);
        lines.push(exp.content);
        if (exp.codeExample) {
          lines.push('```');
          lines.push(exp.codeExample);
          lines.push('```');
        }
      }
    }

    if (positives.length === 0 && negatives.length === 0) {
      lines.push('_No accumulated experience yet for this context._');
    }

    // Token guard: cap the context block at 6000 chars to avoid prompt bloat.
    // Experiences are already sorted by relevance (scoreSort=true), so truncation
    // drops the least-relevant entries first.
    const MAX_CONTEXT_CHARS = 6000;
    const raw = lines.join('\n');
    if (raw.length > MAX_CONTEXT_CHARS) {
      return raw.slice(0, MAX_CONTEXT_CHARS) + '\n\n_... (experience context truncated to stay within token budget)_';
    }
    return raw;
  }

  /**
   * Returns statistics about the experience store.
   *
   * @returns {object}
   */
  getStats() {
    const positive = this.experiences.filter(e => e.type === ExperienceType.POSITIVE).length;
    const negative = this.experiences.filter(e => e.type === ExperienceType.NEGATIVE).length;
    const totalEvolutions = this.experiences.reduce((sum, e) => sum + e.evolutionCount, 0);
    const byCategory = {};
    for (const exp of this.experiences) {
      byCategory[exp.category] = (byCategory[exp.category] || 0) + 1;
    }
    return {
      total: this.experiences.length,
      positive,
      negative,
      totalEvolutions,
      byCategory,
    };
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────────

  _load() {
    try {
      if (fs.existsSync(this.storePath)) {
        this.experiences = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
        // Rebuild title index from loaded data
        this._titleIndex = new Set(this.experiences.map(e => e.title));
        console.log(`[ExperienceStore] Loaded ${this.experiences.length} experiences`);
      }
    } catch (err) {
      console.warn(`[ExperienceStore] Could not load experiences: ${err.message}`);
    }
  }

  _save() {
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // N37 fix: atomic write – write to a .tmp file first, then rename over the target.
      const tmpPath = this.storePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(this.experiences, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.storePath);
      // N65 fix: reset _dirty after a successful save so flushDirty() does not
      // trigger a redundant write on the next call.
      this._dirty = false;
    } catch (err) {
      console.warn(`[ExperienceStore] Could not save experiences: ${err.message}`);
    }
  }
}

module.exports = { ExperienceStore, ExperienceType, ExperienceCategory };
