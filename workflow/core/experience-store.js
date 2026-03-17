/**
 * Experience Store – Persistent experience accumulation across sessions
 *
 * Refactored into focused modules:
 *   - experience-types.js     – ExperienceType, ExperienceCategory, category constants
 *   - experience-query.js     – Search, keyword extraction, LLM query expansion, synonym table
 *   - experience-evolution.js – Hit tracking, adaptive thresholds, evolution triggers
 *   - experience-transfer.js  – Cross-project export/import
 *   - experience-store.js     – Core storage (this file), constructor, CRUD, mixin assembly
 *
 * All external consumers continue to require('./experience-store') – the public API is unchanged.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS } = require('./constants');
const { ExperienceType, ExperienceCategory, UNIVERSAL_CATEGORIES } = require('./experience-types');
const { extractKeywords, ExperienceQueryMixin, STOPWORDS, SHORT_WORD_WHITELIST } = require('./experience-query');
const { ExperienceEvolutionMixin } = require('./experience-evolution');
const { ExperienceTransferMixin } = require('./experience-transfer');

// ─── Experience Store ─────────────────────────────────────────────────────────

class ExperienceStore {
  /**
   * @param {string} [storePath] - Path to persist experience JSON
   */
  constructor(storePath = null) {
    this.storePath = storePath || path.join(PATHS.OUTPUT_DIR, 'experiences.json');
    /** @type {Experience[]} */
    this.experiences = [];
    this._dirty = false;
    /** @type {Set<string>} */
    this._titleIndex = new Set();
    /** @type {object|null} */
    this._complaintWall = null;
    /** @type {Function|null} */
    this._llmCall = null;

    // Synonym table (managed by ExperienceQueryMixin)
    this._synonymTable = {};
    this._synonymTablePath = path.join(path.dirname(this.storePath), 'synonym-table.json');
    this._synonymTableDirty = false;
    this._loadSynonymTable();

    this._load();
  }

  // ─── Core Storage API ─────────────────────────────────────────────────────

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
   * @param {string}   [options.codeExample] - Code snippet
   * @returns {Experience}
   */
  record(options) {
    const { type, category, title, content, taskId = null, skill = null, tags = [], codeExample = null } = options;
    const id = `EXP-${Date.now()}-${Math.random().toString(36).slice(2, 9).toUpperCase()}`;
    const ttlDays = options.ttlDays !== undefined
      ? options.ttlDays
      : (type === ExperienceType.NEGATIVE ? 90 : 365);
    const expiresAt = ttlDays != null
      ? new Date(Date.now() + ttlDays * 86400_000).toISOString()
      : null;
    const exp = {
      id, type, category, title, content, taskId, skill, tags, codeExample,
      sourceFile: options.sourceFile || null,
      namespace: options.namespace || null,
      hitCount: 0,
      evolutionCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt,
    };
    this.experiences.push(exp);
    this._titleIndex.add(exp.title);

    // Defect F fix: auto-file complaint from negative experience
    if (exp.type === ExperienceType.NEGATIVE && this._complaintWall) {
      try {
        this._complaintWall.fileFromNegativeExperience(exp);
      } catch (err) {
        console.warn(`[ExperienceStore] ⚠️  Failed to file complaint from negative experience: ${err.message}`);
      }
    }
    this._save();
    return exp;
  }

  /**
   * Checks if an experience with the same title already exists.
   *
   * @param {string} title
   * @returns {Experience|null}
   */
  findByTitle(title) {
    return this.experiences.find(e => e.title === title) || null;
  }

  /**
   * Updates an existing experience by appending new content.
   *
   * @param {string} title
   * @param {string} additionalContent
   * @returns {Experience|null}
   */
  appendByTitle(title, additionalContent) {
    const exp = this.findByTitle(title);
    if (!exp) return null;
    // N40 fix: 120-char prefix dedup check
    if (exp.content.includes(additionalContent.slice(0, 120))) return exp;

    if (!exp.updates) exp.updates = [];
    exp.updates.push({
      date: new Date().toISOString().slice(0, 10),
      content: additionalContent,
    });
    exp.content = `${exp.content}\n\n[Update ${new Date().toISOString().slice(0, 10)}] ${additionalContent}`;
    exp.updatedAt = new Date().toISOString();
    this._save();
    return exp;
  }

  /**
   * Atomically records if absent (dedup by title).
   *
   * @param {string} title
   * @param {object} options - Same as record()
   * @returns {Experience|null}
   */
  recordIfAbsent(title, options) {
    if (this._titleIndex.has(title)) return null;
    if (this.findByTitle(title)) {
      this._titleIndex.add(title);
      return null;
    }
    this._titleIndex.add(title);
    return this.record(options);
  }

  /**
   * Batch-records multiple experiences, skipping duplicates.
   *
   * @param {object[]} items
   * @returns {{ added: number, skipped: number }}
   */
  batchRecord(items) {
    let added = 0;
    let skipped = 0;
    let batchSeq = 0;
    for (const item of items) {
      if (this._titleIndex.has(item.title) || this.findByTitle(item.title)) {
        this._titleIndex.add(item.title);
        skipped++;
        continue;
      }
      this._titleIndex.add(item.title);
      const { type, category, title, content, taskId = null, skill = null, tags = [], codeExample = null } = item;
      const id = `EXP-${Date.now()}-${String(batchSeq++).padStart(4, '0')}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
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
    if (added > 0) this._save();
    return { added, skipped };
  }

  /**
   * Purges all expired experiences.
   *
   * @returns {{ purged: number, remaining: number }}
   */
  purgeExpired() {
    const now = Date.now();
    const before = this.experiences.length;
    this.experiences = this.experiences.filter(e => !e.expiresAt || new Date(e.expiresAt).getTime() > now);
    this._titleIndex = new Set(this.experiences.map(e => e.title));
    const purged = before - this.experiences.length;
    if (purged > 0) {
      this._save();
      console.log(`[ExperienceStore] Purged ${purged} expired experience(s). Remaining: ${this.experiences.length}`);
    }
    return { purged, remaining: this.experiences.length };
  }

  /**
   * Returns all experiences in the store.
   * Used by AEF Self-Refinement analysis to scan for negative experience patterns.
   *
   * @returns {Experience[]}
   */
  getAll() {
    return this.experiences;
  }

  /**
   * Returns statistics about the experience store.
   */
  getStats() {
    const positive = this.experiences.filter(e => e.type === ExperienceType.POSITIVE).length;
    const negative = this.experiences.filter(e => e.type === ExperienceType.NEGATIVE).length;
    const totalEvolutions = this.experiences.reduce((sum, e) => sum + e.evolutionCount, 0);
    const byCategory = {};
    for (const exp of this.experiences) {
      byCategory[exp.category] = (byCategory[exp.category] || 0) + 1;
    }
    return { total: this.experiences.length, positive, negative, totalEvolutions, byCategory };
  }

  /**
   * Sets the ComplaintWall reference for bidirectional sync.
   *
   * @param {object} complaintWall
   */
  setComplaintWall(complaintWall) {
    this._complaintWall = complaintWall;
  }

  // ─── Private: Persistence ─────────────────────────────────────────────────

  _load() {
    try {
      if (fs.existsSync(this.storePath)) {
        this.experiences = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
        this._titleIndex = new Set(this.experiences.map(e => e.title));
        console.log(`[ExperienceStore] Loaded ${this.experiences.length} experiences`);

        // P2-1 fix: auto-purge expired on load
        const now = Date.now();
        const beforePurge = this.experiences.length;
        this.experiences = this.experiences.filter(
          e => !e.expiresAt || new Date(e.expiresAt).getTime() > now
        );
        const purged = beforePurge - this.experiences.length;
        if (purged > 0) {
          this._titleIndex = new Set(this.experiences.map(e => e.title));
          console.log(`[ExperienceStore] Auto-purged ${purged} expired experience(s) on load. Remaining: ${this.experiences.length}`);
        }

        // P2-1 fix: enforce capacity cap
        const MAX_CAPACITY = 500;
        if (this.experiences.length > MAX_CAPACITY) {
          this.experiences.sort((a, b) => {
            if (a.hitCount !== b.hitCount) return a.hitCount - b.hitCount;
            return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          });
          const evicted = this.experiences.length - MAX_CAPACITY;
          this.experiences = this.experiences.slice(evicted);
          this._titleIndex = new Set(this.experiences.map(e => e.title));
          console.log(`[ExperienceStore] Capacity cap enforced: evicted ${evicted} low-value experience(s). Remaining: ${this.experiences.length}`);
          this._save();
        }
      }
    } catch (err) {
      console.warn(`[ExperienceStore] Could not load experiences: ${err.message}`);
    }
  }

  _save() {
    // P2-NEW-3 fix: serialise concurrent writes via promise-chain queue
    if (!this._saveQueue) {
      this._saveQueue = Promise.resolve();
    }
    this._saveQueue = this._saveQueue.then(() => {
      try {
        const dir = path.dirname(this.storePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        // N37 fix: atomic write (tmp + rename)
        const tmpPath = this.storePath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(this.experiences, null, 2), 'utf-8');
        fs.renameSync(tmpPath, this.storePath);
        this._dirty = false;
      } catch (err) {
        console.warn(`[ExperienceStore] Could not save experiences: ${err.message}`);
      }
    });
    return this._saveQueue;
  }
}

// ─── Apply Mixins ─────────────────────────────────────────────────────────────
// Mixins add methods to ExperienceStore.prototype so all instances share them.
// This keeps each concern in its own file while maintaining a single class API.

Object.assign(ExperienceStore.prototype, ExperienceQueryMixin);
Object.assign(ExperienceStore.prototype, ExperienceEvolutionMixin);
Object.assign(ExperienceStore.prototype, ExperienceTransferMixin);

// ─── Backward-Compatible Exports ────────────────────────────────────────────
// All existing require('./experience-store') consumers continue to work unchanged.

module.exports = {
  ExperienceStore,
  ExperienceType,
  ExperienceCategory,
  UNIVERSAL_CATEGORIES,
  STOPWORDS,
  SHORT_WORD_WHITELIST,
  extractKeywords,
};