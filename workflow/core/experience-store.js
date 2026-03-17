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

// ─── P0 Fix: Stopwords + Short-word Whitelist for keyword extraction ────────
// Stopwords: common English words that add noise to keyword matching.
// Short-word whitelist: important technical terms < 4 chars that would be
// filtered out by the default `word.length >= 4` rule.

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'have', 'will',
  'been', 'were', 'they', 'their', 'what', 'when', 'where', 'which', 'there',
  'about', 'each', 'make', 'like', 'just', 'over', 'such', 'than', 'into',
  'some', 'could', 'them', 'then', 'should', 'would', 'also', 'after', 'before',
  'more', 'most', 'only', 'other', 'these', 'those', 'does', 'done', 'using',
  'used', 'uses', 'need', 'needs', 'want', 'very', 'well', 'here',
  'implement', 'implementation', 'create', 'creating', 'please', 'ensure',
  'based', 'following', 'include', 'including', 'support', 'system', 'provide',
]);

const SHORT_WORD_WHITELIST = new Set([
  'api', 'jwt', 'sql', 'orm', 'ui', 'db', 'css', 'dom', 'url', 'xml',
  'cli', 'sdk', 'rpc', 'tcp', 'udp', 'ssl', 'tls', 'ssh', 'git', 'npm',
  'vue', 'tsx', 'jsx', 'ssr', 'spa', 'ecs', 'mvp', 'mvc', 'ddd', 'tdd',
  'bdd', 'ci', 'cd', 'io', 'ai', 'ml', 'go', 'lua', 'php', 'c++',
  'aws', 'gcp', 'k8s', 'os', 'gpu', 'cpu', 'ram', 'ssd', 'hdd',
]);

/**
 * Extracts meaningful keywords from a text string.
 * P0 fix: applies stopword filtering and short-word whitelist to improve
 * search precision. Previously used a blanket `word.length >= 4` filter
 * which dropped important short technical terms (API, JWT, SQL, etc.)
 * and kept noise words (this, that, from, with, etc.).
 *
 * @param {string} text - Source text to extract keywords from
 * @param {number} [maxKeywords=10] - Maximum keywords to return
 * @returns {string[]} Deduplicated, filtered keywords
 */
function extractKeywords(text, maxKeywords = 10) {
  if (!text || !text.trim()) return [];
  const words = text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
  const seen = new Set();
  const result = [];
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    // Accept short-word whitelist entries regardless of length
    if (SHORT_WORD_WHITELIST.has(w)) {
      result.push(w);
      continue;
    }
    // Reject words shorter than 3 chars (unless whitelisted above)
    if (w.length < 3) continue;
    // Reject stopwords
    if (STOPWORDS.has(w)) continue;
    // Accept words with 3+ chars that pass stopword filter
    result.push(w);
  }
  return result.slice(0, maxKeywords);
}

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
    // Defect F fix: optional ComplaintWall reference for bidirectional sync.
    // When set, recording a NEGATIVE experience auto-files a complaint.
    /** @type {object|null} */
    this._complaintWall = null;
    // LLM Query Expansion: optional LLM function for semantic keyword expansion.
    // When set via setLlmCall(), getContextBlockWithIds() will expand extracted
    // keywords with LLM-generated synonyms, abbreviations, and related terms
    // before searching. Gracefully degrades to pure extractKeywords()
    // when no LLM is available.
    /** @type {Function|null} async (prompt: string) => string */
    this._llmCall = null;

    // ── Persistent Synonym / Alias Table (LLM Distillation Cache) ──────────
    // Every LLM query expansion result is persisted to a JSON file so that:
    //   1. Repeated queries hit the table instantly (0ms) instead of calling LLM (~1-3s)
    //   2. Knowledge accumulates across sessions (self-growing synonym dictionary)
    //   3. The table can be exported/imported across projects
    //   4. After sufficient accumulation, the system works without LLM entirely
    //
    // Table structure: { [sortedKeywordKey: string]: SynonymEntry }
    //   SynonymEntry = { expandedTerms: string[], createdAt: string, hitCount: number, skill: string|null }
    //
    // Lookup strategy: exact match on sorted keyword key (O(1) via object property access)
    // Write-through: every LLM expansion result is immediately persisted to disk
    /** @type {Object<string, { expandedTerms: string[], createdAt: string, hitCount: number, skill: string|null }>} */
    this._synonymTable = {};
    this._synonymTablePath = path.join(path.dirname(this.storePath), 'synonym-table.json');
    this._synonymTableDirty = false;
    this._loadSynonymTable();

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
    // Defect F fix: when a NEGATIVE experience is recorded and a ComplaintWall is
    // connected, auto-file a complaint so the problem is tracked as an action item.
    // This bridges the "knowledge" system (ExperienceStore) with the "action" system
    // (ComplaintWall), closing the information silo.
    if (exp.type === ExperienceType.NEGATIVE && this._complaintWall) {
      try {
        this._complaintWall.fileFromNegativeExperience(exp);
      } catch (err) {
        // Non-fatal: experience recording succeeds even if complaint filing fails
        console.warn(`[ExperienceStore] ⚠️  Failed to file complaint from negative experience: ${err.message}`);
      }
    }
    // P1-D fix: _save() returns the queue promise. record() now returns a Promise
    // so callers that need guaranteed persistence can `await store.record(...)` or
    // `await store.record(...).then(...)`. Fire-and-forget callers are unaffected
    // (they simply don't await the return value).
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

    // P2 fix: zombie experience auto-demotion.
    // Experiences that have been injected many times (high retrievalCount) but
    // never confirmed effective (hitCount=0) are "zombies" – they waste prompt
    // tokens without providing value. Demote them to the bottom of results.
    // Zombie threshold: retrieved >= 5 times, hitCount === 0.
    const ZOMBIE_RETRIEVAL_THRESHOLD = 5;

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

          // P0 fix: time-decay scoring.
          // Recency matters: a 1-day-old experience with score=4 should rank above
          // a 6-month-old experience with score=6, because the older one may be stale.
          // Formula: recencyMultiplier = 1 / (1 + daysSinceLastUsed / halfLifeDays)
          //   halfLifeDays = 60 → experiences lose 50% recency weight after 60 days of inactivity.
          //   A fresh experience (0 days) gets multiplier=1.0
          //   A 60-day-old experience gets multiplier=0.5
          //   A 180-day-old experience gets multiplier=0.25
          const lastActivity = new Date(e.updatedAt || e.createdAt).getTime();
          const daysSinceActivity = (now - lastActivity) / 86400_000;
          const HALF_LIFE_DAYS = 60;
          const recencyMultiplier = 1 / (1 + daysSinceActivity / HALF_LIFE_DAYS);

          // Blend: keyword relevance × recency × (1 + log(hitCount+1))
          // hitCount contribution is logarithmic to prevent old high-hitCount
          // experiences from permanently dominating the results.
          const hitBoost = Math.log2(1 + (e.hitCount || 0));
          const finalScore = score * recencyMultiplier * (1 + hitBoost * 0.2);

          // P2 fix: zombie demotion – if zombie, slash score by 90%
          const isZombie = (e.retrievalCount || 0) >= ZOMBIE_RETRIEVAL_THRESHOLD && e.hitCount === 0;
          return { exp: e, score: isZombie ? finalScore * 0.1 : finalScore, rawScore: score };
        })
        .filter(({ rawScore }) => rawScore > 0)
        .sort((a, b) => scoreSort ? b.score - a.score : b.exp.hitCount - a.exp.hitCount)
        .map(({ exp }) => exp);
    } else {
      // P0 fix: even without keyword, apply time-decay to hitCount-based sorting.
      // This prevents ancient high-hitCount experiences from permanently topping results.
      results = results
        .map(e => {
          const lastActivity = new Date(e.updatedAt || e.createdAt).getTime();
          const daysSinceActivity = (now - lastActivity) / 86400_000;
          const HALF_LIFE_DAYS = 60;
          const recencyMultiplier = 1 / (1 + daysSinceActivity / HALF_LIFE_DAYS);
          const decayedScore = (e.hitCount || 0) * recencyMultiplier;
          const isZombie = (e.retrievalCount || 0) >= ZOMBIE_RETRIEVAL_THRESHOLD && e.hitCount === 0;
          return { exp: e, decayedScore: isZombie ? decayedScore * 0.1 : decayedScore };
        })
        .sort((a, b) => b.decayedScore - a.decayedScore)
        .map(({ exp }) => exp);
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

    // P2 fix: structured content via updates array.
    // Instead of free-text concatenation, maintain a structured updates[] array
    // that keeps each update as a separate entry with timestamp and content.
    // The main content string is still updated for backward compatibility with
    // existing code that reads exp.content directly (search, getContextBlock, etc.)
    if (!exp.updates) exp.updates = [];
    exp.updates.push({
      date: new Date().toISOString().slice(0, 10),
      content: additionalContent,
    });

    exp.content = `${exp.content}\n\n[Update ${new Date().toISOString().slice(0, 10)}] ${additionalContent}`;
    exp.updatedAt = new Date().toISOString();
    // P1-D fix: return the save-queue promise so callers can await persistence.
    // The return value is the updated experience object wrapped in a thenable:
    // - `store.appendByTitle(t, c)` → still returns the exp object synchronously
    //   for callers that use the return value as a truthy check (e.g. `if (!appendByTitle(...))`).
    // - The save is still fire-and-forget for those callers; they just don't await it.
    // To allow both patterns we keep returning `exp` (not the promise) but ensure
    // _save() is called so the queue is updated.
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
    // P1-D fix: single save after all items are processed; return the save-queue
    // promise so callers can `await store.batchRecord(items)` for guaranteed persistence.
    // Fire-and-forget callers (that only use { added, skipped }) are unaffected.
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
  /**
   * Increments the retrieval counter for an experience.
   * Called when an experience is included in a context block (retrieved),
   * regardless of whether the downstream task succeeds.
   * This enables zombie detection: high retrievalCount + zero hitCount = zombie.
   *
   * @param {string} expId
   */
  markRetrieved(expId) {
    const exp = this.experiences.find(e => e.id === expId);
    if (!exp) return;
    if (!exp.retrievalCount) exp.retrievalCount = 0;
    exp.retrievalCount += 1;
    // Deferred save – flushed by next natural _save() or flushDirty()
    this._dirty = true;
  }

  markUsed(expId) {
    const exp = this.experiences.find(e => e.id === expId);
    if (!exp) return false;
    exp.hitCount += 1;
    exp.updatedAt = new Date().toISOString();

    // Defect I fix: adaptive evolution threshold based on skill specificity.
    //
    // The previous hardcoded EVOLUTION_THRESHOLD = 3 treated all skills equally.
    // But generic skills (async/await best practices) mature faster than domain-
    // specific skills (Cocos Creator resource loading).
    //
    // Adaptive threshold classification:
    //   GENERIC categories (stable_pattern, performance, debug_technique, architecture,
    //     pitfall) → threshold = 3 (fast evolution: patterns are broadly applicable)
    //   FRAMEWORK categories (framework_limit, framework_module, engine_api,
    //     module_usage) → threshold = 7 (slow evolution: need more domain samples)
    //   OTHER / unclassified → threshold = 5 (middle ground)
    //
    // The threshold is further modulated by the experience's tag count:
    //   More tags = more specific context = needs more hits to generalise.
    //   Bonus: +1 threshold per 3 tags (capped at +3).
    const threshold = _computeEvolutionThreshold(exp);
    const shouldEvolve = exp.type === ExperienceType.POSITIVE && exp.hitCount === threshold;

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
   *
   * P1-D fix: returns the save-queue Promise so callers can await completion.
   * Previously flushDirty() called _save() but returned void, meaning the
   * caller had no way to know when the write finished (or if it failed).
   * Now: `await store.flushDirty()` guarantees the write is complete.
   * Fire-and-forget callers that don't await are unaffected.
   *
   * @returns {Promise<void>}
   */
  flushDirty() {
    // Also flush synonym table hitCount changes (accumulated from table lookups)
    this.flushSynonymTable();
    if (this._dirty) {
      this._dirty = false; // reset before save so a concurrent markUsed() re-sets it
      return this._save();
    }
    return Promise.resolve();
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
   * Returns a formatted context block for injection into agent prompts,
   * along with the IDs of all experiences included in the block.
   *
   * This is the preferred method when the caller needs to later call
   * markUsedBatch(ids) to record which experiences were actually effective
   * (i.e. the task succeeded after the context was injected).
   *
   * EvoMap-inspired: instead of marking all retrieved experiences as "used"
   * at retrieval time (which conflates "retrieved" with "effective"), callers
   * can now close the feedback loop by calling markUsedBatch() only when the
   * downstream task actually succeeds. This makes hitCount a true signal of
   * "helped solve a problem" rather than "was retrieved".
   *
   * @param {string} [skill]
   * @param {string} [taskDescription]
   * @param {number} [limit=5] - Max experiences per type (positive/negative).
   *   Improvement 4: deriveStrategy() returns maxExpInjected based on cross-session
   *   hit-rate analysis. Pass orch._adaptiveStrategy?.maxExpInjected ?? 5 here.
   * @returns {{ block: string, ids: string[] }}
   */
  async getContextBlockWithIds(skill = null, taskDescription = null, limit = 5) {
    if (!skill) return { block: '', ids: [] };

    let scoreSort = true;
    let keyword = null;
    if (taskDescription && taskDescription.trim().length > 0) {
      // P0 fix: use extractKeywords() with stopword filtering + short-word whitelist
      // instead of the blanket `word.length >= 4` filter. This improves precision by:
      //   1. Keeping important short terms: API, JWT, SQL, ORM, UI, DB, etc.
      //   2. Removing common noise words: the, with, for, this, that, etc.
      let taskKeywords = extractKeywords(taskDescription, 10);

      // LLM Query Expansion + Synonym Table Lookup:
      // First checks the persistent synonym table (0ms, no LLM needed).
      // Falls back to LLM expansion if no table entry exists.
      // This means expansion works even without LLM after sufficient accumulation.
      // Example: ["redis", "cache"] → ["redis", "cache", "memcached", "caching", "ttl"]
      // Gracefully degrades to original keywords if both table and LLM are unavailable.
      if (taskKeywords.length > 0) {
        try {
          taskKeywords = await this._expandKeywordsWithLlm(taskKeywords, skill);
        } catch (_) {
          // Silent fallback – expansion failure must never break the main flow
        }
      }

      if (taskKeywords.length > 0) {
        keyword = taskKeywords.join(' ');
        scoreSort = true;
      }
    }

    // Use limit to control how many experiences are injected.
    // Improvement 4: deriveStrategy() returns maxExpInjected based on cross-session
    // hit-rate analysis. When hit rate is low (experiences not helping), limit is
    // reduced to cut prompt noise. When hit rate is high, limit is increased.
    const perTypeLimit = Math.max(1, Math.ceil(limit / 2)); // split evenly between positive/negative
    const positives = this.search({ type: ExperienceType.POSITIVE, skill, keyword, limit: perTypeLimit, scoreSort });
    const negatives = this.search({ type: ExperienceType.NEGATIVE, skill, keyword, limit: perTypeLimit, scoreSort });
    const ids = [...positives.map(e => e.id), ...negatives.map(e => e.id)];

    // P2 fix: track retrieval count for zombie detection.
    // Mark each retrieved experience so we can detect zombies (retrieved many
    // times but never confirmed effective via markUsedBatch).
    for (const id of ids) {
      this.markRetrieved(id);
    }

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

    const MAX_CONTEXT_CHARS = 6000;
    const raw = lines.join('\n');
    const block = raw.length > MAX_CONTEXT_CHARS
      ? raw.slice(0, MAX_CONTEXT_CHARS) + '\n\n_... (experience context truncated to stay within token budget)_'
      : raw;

    return { block, ids };
  }

  /**
   * Marks multiple experiences as "effectively used" in a single batch.
   *
   * Call this after a task succeeds to close the feedback loop: the experiences
   * that were injected into the agent's prompt (via getContextBlockWithIds) and
   * whose presence correlated with a successful outcome are credited.
   *
   * This is the EvoMap "validation record" concept: hitCount now means
   * "helped solve N problems" rather than "was retrieved N times".
   *
   * Returns the list of experience IDs that crossed their adaptive evolution
   * threshold (Defect I fix: threshold varies by category and tag count) and
   * should trigger skill evolution.
   *
   * @param {string[]} ids - Experience IDs to mark as used
   * @returns {string[]} IDs that should trigger skill evolution
   */
  markUsedBatch(ids) {
    if (!ids || ids.length === 0) return [];
    const evolutionTriggers = [];
    for (const id of ids) {
      const shouldEvolve = this.markUsed(id);
      if (shouldEvolve) evolutionTriggers.push(id);
    }
    return evolutionTriggers;
  }

  /**
   * Computes which injected experience IDs actually "matched" the current task context.
   *
   * This fixes Defect H (hit-rate measurement bias): the previous implementation
   * counted ALL injected experiences as "hits" whenever a task succeeded, which
   * systematically over-estimated hit rate and made deriveStrategy Rule 4 useless
   * (it would never trigger the "reduce injection" path because hit rate always
   * appeared high).
   *
   * Matching logic (asymmetric by experience type):
   *
   *   POSITIVE experiences (proven patterns):
   *     → Always counted as matched when the task succeeds.
   *     Rationale: positive experiences provide correct direction ("do X"). If the
   *     task succeeded, the agent followed correct patterns – the positive experience
   *     contributed to the outcome regardless of whether a specific error occurred.
   *
   *   NEGATIVE experiences (pitfalls / anti-patterns):
   *     → Only counted as matched when the errorContext contains keywords from the
   *       experience's tags or category.
   *     Rationale: negative experiences warn about specific failure modes ("avoid Y").
   *     If the error context doesn't mention the pitfall, the experience was injected
   *     as noise – it didn't help avoid anything relevant to this task.
   *     If the error context DOES mention the pitfall, the experience was relevant
   *     (the agent was warned about the exact failure mode it encountered).
   *
   * @param {string[]} ids          - Experience IDs that were injected
   * @param {string}   [errorContext=''] - Error/failure text from the current task
   *   (e.g. result.output, result.failureSummary.join(), reviewResult.riskNotes.join())
   *   Pass empty string when there is no error context (e.g. first-run pass with no failures).
   * @returns {{ matchedIds: string[], matchedCount: number, totalCount: number }}
   */
  computeMatchedIds(ids, errorContext = '') {
    if (!ids || ids.length === 0) {
      return { matchedIds: [], matchedCount: 0, totalCount: 0 };
    }

    const errorLower = (errorContext || '').toLowerCase();

    const matchedIds = ids.filter(id => {
      const exp = this.experiences.find(e => e.id === id);
      if (!exp) return false;

      // POSITIVE experiences: always matched on task success
      if (exp.type === ExperienceType.POSITIVE) return true;

      // NEGATIVE experiences: only matched when error context contains relevant keywords.
      // P2 fix: require at least 2 token matches (across tags, category, and title)
      // to reduce false positives. Previously a single generic token like 'module'
      // would trigger a match, causing e.g. "Cannot find module 'lodash'" to falsely
      // match a "Cocos Creator Module Usage" experience.
      let matchScore = 0;
      const MATCH_THRESHOLD = 2; // require at least 2 token matches

      // Check 1: tag keywords in error context
      for (const tag of (exp.tags || [])) {
        if (tag.length >= 3 && errorLower.includes(tag.toLowerCase())) {
          matchScore++;
        }
      }

      // Check 2: category tokens in error context
      // Only count tokens with length >= 4 to avoid single-char category fragments
      const categoryTokens = (exp.category || '').toLowerCase().split('_').filter(t => t.length >= 4);
      for (const token of categoryTokens) {
        if (errorLower.includes(token)) matchScore++;
      }

      // Check 3: significant title words in error context
      const titleTokens = (exp.title || '').toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length >= 5 && !STOPWORDS.has(t));
      for (const token of titleTokens) {
        if (errorLower.includes(token)) matchScore++;
      }

      return matchScore >= MATCH_THRESHOLD;
    });

    return {
      matchedIds,
      matchedCount: matchedIds.length,
      totalCount: ids.length,
    };
  }

  /**
   * Returns a formatted context block for injection into agent prompts.
   * Includes top positive experiences and all negative experiences for a skill.
   *
   * @param {string} [skill] - Filter by skill name. If null, returns empty string
   *   to avoid injecting unrelated cross-skill experiences into agent prompts.
   * @param {string} [taskDescription] - Current task description for relevance scoring.
   *   P1-NEW-2 fix: when provided, experiences are ranked by keyword overlap with the
   *   current task rather than global hitCount. This prevents high-frequency but
   *   task-irrelevant experiences (e.g. from 100 "Hello World" runs) from crowding
   *   out low-frequency but highly relevant experiences for the current task.
   * @returns {string} Markdown-formatted experience context
   */
  /**
   * P1 DRY fix: getContextBlock now delegates to getContextBlockWithIds
   * and returns only the block string. Previously these two methods had ~60 lines
   * of duplicated keyword extraction, search, and Markdown formatting logic.
   * Any future search/formatting improvements now only need to be made in one place.
   *
   * @param {string} [skill]
   * @param {string} [taskDescription]
   * @returns {Promise<string>}
   */
  async getContextBlock(skill = null, taskDescription = null) {
    if (!skill) return '';
    return (await this.getContextBlockWithIds(skill, taskDescription)).block;
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

  /**
   * Defect F fix: Sets the ComplaintWall reference for bidirectional sync.
   * Call this after both ExperienceStore and ComplaintWall are constructed.
   *
   * When set, recording a NEGATIVE experience will auto-file a complaint
   * in the ComplaintWall, ensuring that pitfalls are tracked as action items
   * (not just knowledge entries). The reverse direction (complaint resolved →
   * positive experience) is handled by ComplaintWall.resolve().
   *
   * @param {object} complaintWall - ComplaintWall instance
   */
  setComplaintWall(complaintWall) {
    this._complaintWall = complaintWall;
  }

  /**
   * Sets the LLM function for query expansion.
   * When set, getContextBlockWithIds() will use LLM to expand search keywords
   * with semantically related terms (synonyms, abbreviations, related concepts)
   * before matching against the experience store.
   *
   * @param {Function} llmCall - async (prompt: string) => string
   */
  setLlmCall(llmCall) {
    if (typeof llmCall === 'function') {
      this._llmCall = llmCall;
      console.log(`[ExperienceStore] 🧠 LLM query expansion enabled.`);
    }
  }

  /**
   * LLM Query Expansion – expands a set of keywords with semantically related terms.
   *
   * Given keywords like ["redis", "cache", "performance"], the LLM generates
   * additional search terms like ["memcached", "caching", "latency", "ttl", "invalidation"].
   * This bridges the vocabulary gap between how experiences are stored (author's words)
   * and how they are searched (searcher's words).
   *
   * Design decisions:
   *   - Tiny prompt (<200 tokens) to minimize cost and latency
   *   - JSON array output for reliable parsing
   *   - 3-second timeout to prevent blocking the main workflow
   *   - In-memory cache with 10-minute TTL to avoid redundant calls
   *   - Silent fallback: returns original keywords on any failure
   *
   * @param {string[]} keywords - Original keywords from extractKeywords()
   * @param {string} [skill] - Optional skill context to guide expansion
   * @returns {Promise<string[]>} Expanded keyword list (original + new terms)
   * @private
   */
  async _expandKeywordsWithLlm(keywords, skill = null) {
    if (!keywords || keywords.length === 0) {
      return keywords;
    }

    // ── Step 1: Synonym Table Lookup (O(1), 0ms) ─────────────────────────
    // The synonym table is a persistent LLM distillation cache: every past LLM
    // expansion result is stored as a key→expandedTerms mapping. Over time, this
    // table grows to cover the project's entire vocabulary, eliminating the need
    // for LLM calls entirely.
    const cacheKey = keywords.slice().sort().join('|');
    const tableEntry = this._synonymTable[cacheKey];
    if (tableEntry && Array.isArray(tableEntry.expandedTerms) && tableEntry.expandedTerms.length > 0) {
      // Table hit: merge original keywords + stored expansion terms
      const merged = [...keywords, ...tableEntry.expandedTerms].slice(0, 20);
      // Track hit count for observability (how often is this entry reused?)
      tableEntry.hitCount = (tableEntry.hitCount || 0) + 1;
      this._synonymTableDirty = true;
      console.log(`[ExperienceStore] 📖 Synonym table HIT: [${keywords.join(', ')}] → +${tableEntry.expandedTerms.length} cached terms (hit #${tableEntry.hitCount})`);
      return merged;
    }

    // ── Step 2: LLM Query Expansion (fallback, ~1-3s) ────────────────────
    // No table entry found – call LLM to generate expansion terms, then persist
    // the result to the synonym table for future lookups.
    if (!this._llmCall) {
      // No LLM available and no table entry – return original keywords
      return keywords;
    }

    const skillHint = skill ? `\nDomain context: ${skill}` : '';
    const prompt = `You are a search query expansion engine for a software engineering experience database.

Given these search keywords: [${keywords.join(', ')}]${skillHint}

Generate 5-10 additional search terms that are:
- Synonyms (e.g. "auth" → "authentication", "login")
- Abbreviations or full forms (e.g. "k8s" → "kubernetes", "db" → "database")
- Closely related technical concepts (e.g. "cache" → "ttl", "invalidation", "memcached")

Rules:
- Only return terms highly likely to appear in software engineering experience records
- Do NOT return generic words (the, is, with, etc.)
- Do NOT repeat the original keywords
- Return ONLY a JSON array of strings, no explanation

Example: ["redis", "cache"] → ["memcached", "caching", "ttl", "invalidation", "key-value", "in-memory"]

Output:`;

    try {
      // 3-second timeout to prevent blocking the main workflow
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Query expansion timeout')), 3000)
      );
      const response = await Promise.race([this._llmCall(prompt), timeoutPromise]);

      // Parse JSON array from response (tolerant of markdown code fences)
      const cleaned = (response || '').replace(/```json?\s*/gi, '').replace(/```/g, '').trim();
      const arrayMatch = cleaned.match(/\[([^\]]+)\]/);
      if (!arrayMatch) {
        console.warn(`[ExperienceStore] ⚠️  Query expansion: could not parse LLM response as JSON array.`);
        return keywords;
      }

      let expanded;
      try {
        expanded = JSON.parse(`[${arrayMatch[1]}]`);
      } catch (_) {
        console.warn(`[ExperienceStore] ⚠️  Query expansion: JSON parse failed.`);
        return keywords;
      }

      // Validate and deduplicate
      const originalSet = new Set(keywords.map(k => k.toLowerCase()));
      const validTerms = expanded
        .filter(term => typeof term === 'string' && term.trim().length > 0)
        .map(term => term.trim().toLowerCase())
        .filter(term => !originalSet.has(term) && !STOPWORDS.has(term));

      if (validTerms.length === 0) {
        return keywords;
      }

      // ── Step 3: Persist to Synonym Table (write-through) ─────────────────
      // Store the LLM result so the next identical query hits the table directly.
      // Only expandedTerms are stored (not the full merged array), because the
      // original keywords are always prepended at lookup time.
      this._synonymTable[cacheKey] = {
        expandedTerms: validTerms,
        createdAt: new Date().toISOString(),
        hitCount: 0,
        skill: skill || null,
      };
      this._synonymTableDirty = true;
      this._saveSynonymTable();

      // Merge: original keywords + expanded terms (capped at 20 total)
      const merged = [...keywords, ...validTerms].slice(0, 20);

      console.log(`[ExperienceStore] 🧠 Query expansion (LLM→table): [${keywords.join(', ')}] → +${validTerms.length} terms: [${validTerms.join(', ')}]`);
      return merged;
    } catch (err) {
      // Silent fallback: any failure returns original keywords
      console.warn(`[ExperienceStore] ⚠️  Query expansion failed (${err.message}). Using original keywords.`);
      return keywords;
    }
  }

  // ── Synonym Table Persistence ────────────────────────────────────────────

  /**
   * Loads the persistent synonym table from disk.
   * Called once during construction. If the file doesn't exist, starts with
   * an empty table (cold start – all queries will go to LLM until the table
   * is populated).
   * @private
   */
  _loadSynonymTable() {
    try {
      if (fs.existsSync(this._synonymTablePath)) {
        const raw = JSON.parse(fs.readFileSync(this._synonymTablePath, 'utf-8'));
        // Validate structure: must be a plain object (not array, not null)
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          this._synonymTable = raw;
          const entryCount = Object.keys(raw).length;
          const totalHits = Object.values(raw).reduce((sum, e) => sum + (e.hitCount || 0), 0);
          console.log(`[ExperienceStore] 📖 Synonym table loaded: ${entryCount} entries, ${totalHits} total hits`);
        } else {
          console.warn(`[ExperienceStore] ⚠️  Synonym table file has unexpected format. Starting fresh.`);
          this._synonymTable = {};
        }
      } else {
        console.log(`[ExperienceStore] 📖 No synonym table found. Starting fresh (cold start).`);
      }
    } catch (err) {
      console.warn(`[ExperienceStore] ⚠️  Could not load synonym table: ${err.message}. Starting fresh.`);
      this._synonymTable = {};
    }
  }

  /**
   * Persists the synonym table to disk (write-through on every LLM expansion).
   * Uses atomic write (tmp + rename) to prevent corruption.
   * @private
   */
  _saveSynonymTable() {
    if (!this._synonymTableDirty) return;
    try {
      const dir = path.dirname(this._synonymTablePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmpPath = this._synonymTablePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(this._synonymTable, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this._synonymTablePath);
      this._synonymTableDirty = false;
    } catch (err) {
      console.warn(`[ExperienceStore] ⚠️  Could not save synonym table: ${err.message}`);
    }
  }

  /**
   * Flushes dirty synonym table hit counts to disk.
   * Should be called at session end (alongside flushDirty()) to persist
   * accumulated hitCount increments from table lookups.
   */
  flushSynonymTable() {
    if (this._synonymTableDirty) {
      this._saveSynonymTable();
    }
  }

  /**
   * Returns synonym table statistics for observability and diagnostics.
   * @returns {{ entryCount: number, totalHits: number, topEntries: Array, coldStartPct: number }}
   */
  getSynonymStats() {
    const entries = Object.entries(this._synonymTable);
    const entryCount = entries.length;
    const totalHits = entries.reduce((sum, [, e]) => sum + (e.hitCount || 0), 0);
    // Top 10 most-used synonym entries
    const topEntries = entries
      .sort((a, b) => (b[1].hitCount || 0) - (a[1].hitCount || 0))
      .slice(0, 10)
      .map(([key, val]) => ({
        keywords: key.split('|'),
        expandedTerms: val.expandedTerms,
        hitCount: val.hitCount || 0,
        skill: val.skill,
        createdAt: val.createdAt,
      }));
    // Cold-start percentage: entries with hitCount=0 (never reused)
    const coldEntries = entries.filter(([, e]) => (e.hitCount || 0) === 0).length;
    const coldStartPct = entryCount > 0 ? Math.round((coldEntries / entryCount) * 100) : 100;
    return { entryCount, totalHits, topEntries, coldStartPct };
  }

  /**
   * Imports synonym entries from an external synonym table (e.g. from another project).
   * Merges without overwriting existing entries. This enables cross-project knowledge transfer.
   *
   * @param {Object<string, { expandedTerms: string[], createdAt: string, hitCount: number, skill: string|null }>} externalTable
   * @returns {{ imported: number, skipped: number, total: number }}
   */
  importSynonymTable(externalTable) {
    if (!externalTable || typeof externalTable !== 'object' || Array.isArray(externalTable)) {
      return { imported: 0, skipped: 0, total: Object.keys(this._synonymTable).length };
    }
    let imported = 0;
    let skipped = 0;
    for (const [key, entry] of Object.entries(externalTable)) {
      if (this._synonymTable[key]) {
        // Existing entry: merge expandedTerms (union) but don't reset hitCount
        const existingTerms = new Set(this._synonymTable[key].expandedTerms || []);
        const newTerms = (entry.expandedTerms || []).filter(t => !existingTerms.has(t));
        if (newTerms.length > 0) {
          this._synonymTable[key].expandedTerms.push(...newTerms);
          imported++;
        } else {
          skipped++;
        }
      } else {
        // New entry: import with hitCount reset to 0
        this._synonymTable[key] = {
          expandedTerms: entry.expandedTerms || [],
          createdAt: entry.createdAt || new Date().toISOString(),
          hitCount: 0,  // Reset: imported entries start fresh in this project
          skill: entry.skill || null,
        };
        imported++;
      }
    }
    if (imported > 0) {
      this._synonymTableDirty = true;
      this._saveSynonymTable();
      console.log(`[ExperienceStore] 📖 Synonym table import: ${imported} entries imported, ${skipped} skipped.`);
    }
    return { imported, skipped, total: Object.keys(this._synonymTable).length };
  }

  // ─── P1: Centralized Evolution Triggers ───────────────────────────────────────

  /**
   * P1 fix: centralizes the skill evolution trigger logic that was previously
   * duplicated 4 times in orchestrator-stages.js (_runArchitect, _runDeveloper,
   * _runRealTestLoop × 2). Each call site had the same 10-line block:
   *   for (const expId of triggers) {
   *     const exp = this.experienceStore.experiences.find(...);
   *     if (exp && exp.skill) { this.skillEvolution.evolve(...); ... }
   *   }
   *
   * Now: orchestrator-stages.js calls experienceStore.triggerEvolutions(triggers, ...)
   * and this method handles the find + evolve + hook-emit logic in one place.
   *
   * @param {string[]} triggerExpIds - Experience IDs that crossed their evolution threshold
   * @param {object} skillEvolution  - SkillEvolutionEngine instance
   * @param {object} hooks           - HookSystem instance for emitting SKILL_EVOLVED
   * @param {string} stageName       - Stage name for logging (e.g. 'ARCHITECT', 'CODE', 'TEST')
   * @returns {Promise<number>} Number of evolutions triggered
   */
  async triggerEvolutions(triggerExpIds, skillEvolution, hooks, stageName) {
    if (!triggerExpIds || triggerExpIds.length === 0) return 0;
    let evolved = 0;
    for (const expId of triggerExpIds) {
      const triggerExp = this.experiences.find(e => e.id === expId);
      if (triggerExp && triggerExp.skill) {
        skillEvolution.evolve(triggerExp.skill, {
          section: 'Best Practices',
          title: triggerExp.title,
          content: triggerExp.content,
          sourceExpId: expId,
          reason: `High-frequency pattern (hitCount=${triggerExp.hitCount}) – validated by ${stageName} stage success`,
        });
        if (hooks) {
          await hooks.emit('skill_evolved', { skillName: triggerExp.skill, expId }).catch(() => {});
        }
        evolved++;
      }
    }
    return evolved;
  }

  // ─── P1: Cross-project Experience Export/Import ───────────────────────────────

  /**
   * Exports experiences that are portable across projects.
   *
   * Supports two modes:
   *   1. Universal export: extracts project-agnostic experiences (generic patterns,
   *      performance insights, debug techniques, architecture decisions, pitfalls)
   *   2. Full export: exports all experiences matching the filter criteria
   *
   * The exported format includes a metadata header with source project info
   * and a compatibility version number for forward/backward compat.
   *
   * @param {object} [options]
   * @param {boolean}  [options.universalOnly=false]  - Only export project-agnostic experiences
   * @param {string[]} [options.categories]           - Filter by specific categories
   * @param {number}   [options.minHitCount=0]        - Only export experiences with >= N hits
   * @param {string}   [options.projectId]            - Source project identifier (metadata)
   * @param {boolean}  [options.stripProjectSpecifics=true] - Remove sourceFile, namespace, taskId
   * @returns {{ version: number, exportedAt: string, sourceProject: string|null, count: number, experiences: object[] }}
   */
  exportPortable({
    universalOnly = false,
    categories = null,
    minHitCount = 0,
    projectId = null,
    stripProjectSpecifics = true,
  } = {}) {
    let candidates = this.experiences.filter(e => {
      // Filter out expired
      if (e.expiresAt && new Date(e.expiresAt).getTime() < Date.now()) return false;
      // Min hit count filter
      if (e.hitCount < minHitCount) return false;
      // Category filter
      if (categories && categories.length > 0 && !categories.includes(e.category)) return false;
      return true;
    });

    if (universalOnly) {
      // Only export experiences from universal (project-agnostic) categories
      candidates = candidates.filter(e => UNIVERSAL_CATEGORIES.has(e.category));
    }

    const exported = candidates.map(e => {
      const entry = { ...e };
      if (stripProjectSpecifics) {
        // Remove project-specific fields that don't transfer
        delete entry.sourceFile;
        delete entry.namespace;
        delete entry.taskId;
      }
      // Reset hit metrics for the importing project (they need to earn trust again)
      entry.hitCount = 0;
      entry.retrievalCount = 0;
      entry.evolutionCount = 0;
      // Mark as imported
      entry._importedFrom = projectId || 'unknown';
      entry._importedAt = null; // set during import
      return entry;
    });

    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      sourceProject: projectId || null,
      count: exported.length,
      experiences: exported,
    };
  }

  /**
   * Imports experiences from an exported file or another project's experience store.
   *
   * Conflict resolution strategies:
   *   - 'skip': skip if an experience with the same title already exists (default)
   *   - 'merge': if same title exists, append imported content as an update
   *   - 'overwrite': replace existing experience with the imported one
   *
   * @param {string|object} source - File path to exported JSON, or the export object directly
   * @param {object} [options]
   * @param {string}  [options.conflictStrategy='skip'] - How to handle title collisions
   * @param {boolean} [options.resetTTL=true]           - Reset TTL for imported experiences
   * @param {string[]} [options.filterCategories]       - Only import specific categories
   * @param {number}  [options.ttlDays]                 - Override TTL for imported experiences
   * @returns {{ imported: number, skipped: number, merged: number, errors: string[] }}
   */
  importFrom(source, {
    conflictStrategy = 'skip',
    resetTTL = true,
    filterCategories = null,
    ttlDays = null,
  } = {}) {
    let exportData;
    if (typeof source === 'string') {
      // File path
      try {
        const raw = fs.readFileSync(source, 'utf-8');
        exportData = JSON.parse(raw);
      } catch (err) {
        return { imported: 0, skipped: 0, merged: 0, errors: [`Failed to read import file: ${err.message}`] };
      }
    } else {
      exportData = source;
    }

    if (!exportData || !Array.isArray(exportData.experiences)) {
      return { imported: 0, skipped: 0, merged: 0, errors: ['Invalid export format: missing experiences array'] };
    }

    let imported = 0;
    let skipped = 0;
    let merged = 0;
    const errors = [];

    for (const exp of exportData.experiences) {
      try {
        // Category filter
        if (filterCategories && filterCategories.length > 0 && !filterCategories.includes(exp.category)) {
          skipped++;
          continue;
        }

        const existing = this.findByTitle(exp.title);

        if (existing) {
          if (conflictStrategy === 'skip') {
            skipped++;
            continue;
          } else if (conflictStrategy === 'merge') {
            // Append imported content as an update
            const importNote = `[Imported from ${exp._importedFrom || 'external'} on ${new Date().toISOString().slice(0, 10)}]\n${exp.content}`;
            this.appendByTitle(exp.title, importNote);
            // Merge tags (union)
            if (exp.tags && exp.tags.length > 0) {
              const tagSet = new Set([...(existing.tags || []), ...exp.tags]);
              existing.tags = [...tagSet];
            }
            merged++;
            continue;
          } else if (conflictStrategy === 'overwrite') {
            // Remove existing, then add imported
            const idx = this.experiences.indexOf(existing);
            if (idx !== -1) {
              this.experiences.splice(idx, 1);
              this._titleIndex.delete(existing.title);
            }
          }
        }

        // Generate new ID for the imported experience
        const newId = `EXP-${Date.now()}-IMP-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

        // Compute TTL
        const effectiveTtl = ttlDays !== undefined && ttlDays !== null
          ? ttlDays
          : (resetTTL
            ? (exp.type === ExperienceType.NEGATIVE ? 90 : 365)
            : null);
        const expiresAt = effectiveTtl != null
          ? new Date(Date.now() + effectiveTtl * 86400_000).toISOString()
          : exp.expiresAt || null;

        const importedExp = {
          ...exp,
          id: newId,
          hitCount: 0,
          retrievalCount: 0,
          evolutionCount: 0,
          createdAt: exp.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          expiresAt,
          _importedFrom: exp._importedFrom || exportData.sourceProject || 'external',
          _importedAt: new Date().toISOString(),
        };

        this.experiences.push(importedExp);
        this._titleIndex.add(importedExp.title);
        imported++;
      } catch (err) {
        errors.push(`Failed to import "${exp.title}": ${err.message}`);
      }
    }

    if (imported > 0 || merged > 0) {
      this._save();
    }

    console.log(`[ExperienceStore] 📦 Import complete: ${imported} imported, ${skipped} skipped, ${merged} merged, ${errors.length} error(s). Source: ${exportData.sourceProject || 'external'}`);
    return { imported, skipped, merged, errors };
  }

  /**
   * Extracts universal (project-agnostic) experiences and saves them to a shared
   * directory that other projects can import from.
   *
   * Universal experiences are those in categories that are inherently cross-project:
   *   - stable_pattern, performance, debug_technique, architecture, pitfall,
   *     workflow_process, interface_def, data_structure
   *
   * This method is the "supply side" of cross-project knowledge sharing:
   *   Project A: store.extractUniversalExperiences('./shared/universal-experiences.json')
   *   Project B: store.importFrom('./shared/universal-experiences.json')
   *
   * @param {string} outputPath - File path to write the universal experiences JSON
   * @param {object} [options]
   * @param {number}  [options.minHitCount=1] - Only export experiences confirmed effective at least once
   * @param {string}  [options.projectId]     - Source project identifier for traceability
   * @returns {{ exported: number, path: string }}
   */
  extractUniversalExperiences(outputPath, { minHitCount = 1, projectId = null } = {}) {
    const exportData = this.exportPortable({
      universalOnly: true,
      minHitCount,
      projectId,
      stripProjectSpecifics: true,
    });

    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const tmpPath = outputPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(exportData, null, 2), 'utf-8');
    fs.renameSync(tmpPath, outputPath);

    console.log(`[ExperienceStore] 🌐 Extracted ${exportData.count} universal experience(s) → ${outputPath}`);
    return { exported: exportData.count, path: outputPath };
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────────

  _load() {
    try {
      if (fs.existsSync(this.storePath)) {
        this.experiences = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
        // Rebuild title index from loaded data
        this._titleIndex = new Set(this.experiences.map(e => e.title));
        console.log(`[ExperienceStore] Loaded ${this.experiences.length} experiences`);

        // P2-1 fix: auto-purge expired entries on load so the store stays lean
        // without requiring explicit purgeExpired() calls from callers.
        // Previously purgeExpired() was only called when explicitly invoked, meaning
        // long-running task-based workflows could accumulate thousands of entries
        // (e.g. 100 tasks/day × 90 days = 9000+ entries), causing slow JSON parsing
        // and O(n) search scans on every getContextBlock() call.
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

        // P2-1 fix: enforce a hard capacity cap (MAX_CAPACITY = 500 entries).
        // When the cap is exceeded, evict the oldest entries with the lowest hitCount
        // first (least useful + least recent). This prevents unbounded growth in
        // long-running deployments where TTL alone is insufficient (e.g. all entries
        // have ttlDays=null or very long TTLs).
        const MAX_CAPACITY = 500;
        if (this.experiences.length > MAX_CAPACITY) {
          // Sort by hitCount asc, then createdAt asc (oldest low-value entries first)
          this.experiences.sort((a, b) => {
            if (a.hitCount !== b.hitCount) return a.hitCount - b.hitCount;
            return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          });
          const evicted = this.experiences.length - MAX_CAPACITY;
          this.experiences = this.experiences.slice(evicted);
          this._titleIndex = new Set(this.experiences.map(e => e.title));
          console.log(`[ExperienceStore] Capacity cap enforced: evicted ${evicted} low-value experience(s). Remaining: ${this.experiences.length}`);
          // Persist the trimmed store immediately so the next load sees the clean state
          this._save();
        }
      }
    } catch (err) {
      console.warn(`[ExperienceStore] Could not load experiences: ${err.message}`);
    }
  }

  _save() {
    // P2-NEW-3 fix: serialise concurrent writes via a promise-chain queue.
    // Problem: multiple parallel workers (runTaskBased) all share the same
    // ExperienceStore instance. When two workers both call _save() concurrently,
    // the second fs.renameSync can overwrite the first worker's write, silently
    // losing the first worker's new entries.
    //
    // Solution: chain each _save() call onto a single promise queue so that
    // writes are always sequential, regardless of how many workers call _save()
    // simultaneously. The queue is a simple promise chain (no external deps).
    //
    // Note: fs.writeFileSync + fs.renameSync are synchronous, so within a single
    // Node.js event-loop tick they cannot interleave. The race condition only
    // occurs across async boundaries (e.g. two workers awaiting different LLM
    // calls, then both resolving and calling _save() in the same microtask batch).
    // The queue ensures the second _save() waits for the first to finish.
    if (!this._saveQueue) {
      this._saveQueue = Promise.resolve();
    }
    this._saveQueue = this._saveQueue.then(() => {
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
    });
    // Return the queue tail so callers that need to await persistence can do so.
    return this._saveQueue;
  }
}

// ─── Defect I fix: Adaptive Evolution Threshold ──────────────────────────────
//
// Different skills mature at different speeds. A generic "async/await best
// practices" pattern is broadly applicable and can be promoted after just 3 hits.
// A domain-specific "Cocos Creator resource loading" pattern needs more diverse
// hits (from different tasks) before it's trustworthy enough to evolve into a
// permanent skill.
//
// This function computes the evolution threshold for an individual experience
// based on two signals:
//   1. Category specificity (generic vs. domain-specific)
//   2. Tag count (more tags = more specific context = harder to generalise)
//
// The threshold determines how many times an experience must be confirmed
// effective (via markUsed → hitCount) before it triggers skill evolution.

// ─── P1: Universal (Project-Agnostic) Categories ──────────────────────────────
// Categories whose experiences are inherently transferable across projects.
// Used by exportPortable({ universalOnly: true }) and extractUniversalExperiences().
// These are the categories where the knowledge is about SOFTWARE ENGINEERING
// principles, not about a specific project's codebase.

const UNIVERSAL_CATEGORIES = new Set([
  ExperienceCategory.STABLE_PATTERN,
  ExperienceCategory.PERFORMANCE,
  ExperienceCategory.DEBUG_TECHNIQUE,
  ExperienceCategory.ARCHITECTURE,
  ExperienceCategory.PITFALL,
  ExperienceCategory.WORKFLOW_PROCESS,
  ExperienceCategory.INTERFACE_DEF,
  ExperienceCategory.DATA_STRUCTURE,
]);

/**
 * Categories classified by specificity level.
 *
 * GENERIC: broadly applicable patterns that transfer across projects.
 *   Evolution quickly because each hit confirms a universal truth.
 *
 * FRAMEWORK: tied to a specific framework/engine/library.
 *   Evolution slowly because each hit might be the same narrow use case,
 *   and premature promotion risks encoding version-specific quirks as
 *   permanent "best practices".
 *
 * The unclassified middle ground gets a moderate threshold.
 */
const GENERIC_CATEGORIES = new Set([
  ExperienceCategory.STABLE_PATTERN,
  ExperienceCategory.PERFORMANCE,
  ExperienceCategory.DEBUG_TECHNIQUE,
  ExperienceCategory.ARCHITECTURE,
  ExperienceCategory.PITFALL,
  ExperienceCategory.WORKFLOW_PROCESS,
]);

const FRAMEWORK_CATEGORIES = new Set([
  ExperienceCategory.FRAMEWORK_LIMIT,
  ExperienceCategory.FRAMEWORK_MODULE,
  ExperienceCategory.ENGINE_API,
  ExperienceCategory.MODULE_USAGE,
]);

/**
 * Computes the adaptive evolution threshold for a given experience entry.
 *
 * Base thresholds by category specificity:
 *   GENERIC    → 3 (fast: broadly applicable, quick to confirm)
 *   FRAMEWORK  → 7 (slow: need diverse domain evidence before promoting)
 *   OTHER      → 5 (moderate: default for unclassified categories)
 *
 * Tag-count modulator:
 *   Each 3 tags adds +1 to the threshold (capped at +3).
 *   Rationale: more tags = more specific context = needs more diverse hits
 *   to confirm the pattern generalises beyond that specific context.
 *
 * Examples:
 *   { category: 'stable_pattern',  tags: [] }        → threshold = 3
 *   { category: 'stable_pattern',  tags: [a,b,c,d] } → threshold = 3 + 1 = 4
 *   { category: 'engine_api',      tags: [] }         → threshold = 7
 *   { category: 'engine_api',      tags: [a,b,c,d,e,f,g,h,i] } → threshold = 7 + 3 = 10
 *   { category: 'component',       tags: [a,b] }     → threshold = 5
 *
 * @param {object} exp - Experience entry with category and tags fields
 * @returns {number} The evolution threshold (minimum hitCount to trigger evolution)
 */
function _computeEvolutionThreshold(exp) {
  // Determine base threshold from category specificity
  let base;
  if (GENERIC_CATEGORIES.has(exp.category)) {
    base = 3;  // Fast evolution for generic patterns
  } else if (FRAMEWORK_CATEGORIES.has(exp.category)) {
    base = 7;  // Slow evolution for framework-specific knowledge
  } else {
    base = 5;  // Moderate default
  }

  // Tag-count modulator: +1 per 3 tags, capped at +3
  const tagBonus = Math.min(Math.floor((exp.tags?.length || 0) / 3), 3);

  return base + tagBonus;
}

module.exports = {
  ExperienceStore,
  ExperienceType,
  ExperienceCategory,
  UNIVERSAL_CATEGORIES,
  STOPWORDS,
  SHORT_WORD_WHITELIST,
  extractKeywords,
};
