/**
 * Experience Query – Search, keyword extraction, and LLM query expansion
 *
 * Extracted from ExperienceStore to enable independent evolution of search
 * algorithms, synonym tables, and keyword expansion strategies.
 *
 * This module provides:
 *   - extractKeywords()       – stopword-aware keyword extraction
 *   - ExperienceQuery mixin   – search(), getContextBlock*(), computeMatchedIds()
 *   - LLM query expansion     – synonym table + LLM fallback
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── P0 Fix: Stopwords + Short-word Whitelist for keyword extraction ────────

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
    if (SHORT_WORD_WHITELIST.has(w)) { result.push(w); continue; }
    if (w.length < 3) continue;
    if (STOPWORDS.has(w)) continue;
    result.push(w);
  }
  return result.slice(0, maxKeywords);
}

// ─── ExperienceQuery Mixin ──────────────────────────────────────────────────
// These methods are designed to be mixed into ExperienceStore.prototype.
// They reference `this.experiences`, `this._synonymTable`, `this._llmCall`, etc.

const ExperienceQueryMixin = {

  /**
   * Searches experiences by keyword, type, category, skill, or tags.
   *
   * @param {object} query
   * @returns {Experience[]}
   */
  search({ keyword = null, type = null, category = null, skill = null, tags = null, sourceFile = null, moduleId = null, limit = 10, scoreSort = false } = {}) {
    const now = Date.now();
    let results = this.experiences.filter(e => !e.expiresAt || new Date(e.expiresAt).getTime() > now);

    if (type) results = results.filter(e => e.type === type);
    if (category) results = results.filter(e => e.category === category);
    // P1 fix: Skill matching with fallback to category/tags when no exact match.
    // This handles the semantic mismatch between workflow stage names (e.g., 'code-development')
    // and technology stack names (e.g., 'unity-csharp') stored in experiences.
    if (skill) {
      const exactMatches = results.filter(e => e.skill === skill);
      if (exactMatches.length > 0) {
        results = exactMatches;
      } else {
        // Fallback: try category matching (architecture-design -> ARCHITECTURE category)
        const skillCategoryMap = {
          'architecture-design': 'architecture',
          'code-development': 'stable_pattern',
          'test-report': 'pitfall',
          'security-audit': 'performance',
        };
        const mappedCategory = skillCategoryMap[skill];
        if (mappedCategory) {
          const categoryMatches = results.filter(e => e.category === mappedCategory);
          if (categoryMatches.length > 0) {
            results = categoryMatches;
          }
          // If category match also fails, keep all results and let keyword scoring do the filtering
        }
      }
    }
    if (sourceFile) results = results.filter(e => e.sourceFile && e.sourceFile.includes(sourceFile));
    if (moduleId) results = results.filter(e => e.moduleId === moduleId);
    if (tags && tags.length > 0) {
      results = results.filter(e =>
        tags.some(tag => e.tags.some(t => t.toLowerCase().includes(tag.toLowerCase())))
      );
    }

    const ZOMBIE_RETRIEVAL_THRESHOLD = 5;
    // P1-2 fix: Pre-compute last-activity timestamps once, outside the scoring loop.
    // Avoids creating hundreds of Date objects per search call.
    const HALF_LIFE_DAYS = 60;
    const nowMs = now; // already in ms

    if (keyword) {
      const keywords = keyword.toLowerCase().split(/\s+/).filter(Boolean);
      results = results
        .map(e => {
          let score = 0;
          const titleLower = e.title.toLowerCase();
          const contentLower = e.content.toLowerCase();
          const tagsLower = e.tags.map(t => t.toLowerCase());
          for (const kw of keywords) {
            if (titleLower.includes(kw)) score += 10;
            if (tagsLower.some(t => t.includes(kw))) score += 6;
            if (contentLower.includes(kw)) score += 2;
          }
          // P1-2 fix: use cached timestamp (or compute once per experience)
          const lastActivity = e._lastActivityTs || (e._lastActivityTs = new Date(e.updatedAt || e.createdAt).getTime());
          const daysSinceActivity = (nowMs - lastActivity) / 86400_000;
          const recencyMultiplier = 1 / (1 + daysSinceActivity / HALF_LIFE_DAYS);
          const hitBoost = Math.log2(1 + (e.hitCount || 0));
          const finalScore = score * recencyMultiplier * (1 + hitBoost * 0.2);
          const isZombie = (e.retrievalCount || 0) >= ZOMBIE_RETRIEVAL_THRESHOLD && e.hitCount === 0;
          return { exp: e, score: isZombie ? finalScore * 0.1 : finalScore, rawScore: score };
        })
        .filter(({ rawScore }) => rawScore > 0)
        .sort((a, b) => scoreSort ? b.score - a.score : b.exp.hitCount - a.exp.hitCount)
        .map(({ exp }) => exp);
    } else {
      results = results
        .map(e => {
          // P1-2 fix: use cached timestamp
          const lastActivity = e._lastActivityTs || (e._lastActivityTs = new Date(e.updatedAt || e.createdAt).getTime());
          const daysSinceActivity = (nowMs - lastActivity) / 86400_000;
          const recencyMultiplier = 1 / (1 + daysSinceActivity / HALF_LIFE_DAYS);
          const decayedScore = (e.hitCount || 0) * recencyMultiplier;
          const isZombie = (e.retrievalCount || 0) >= ZOMBIE_RETRIEVAL_THRESHOLD && e.hitCount === 0;
          return { exp: e, decayedScore: isZombie ? decayedScore * 0.1 : decayedScore };
        })
        .sort((a, b) => b.decayedScore - a.decayedScore)
        .map(({ exp }) => exp);
    }

    return results.slice(0, limit);
  },

  /**
   * Returns a formatted context block with experience IDs.
   *
   * P1 fix: Enhanced skill matching to support both workflow stage names (e.g., 'code-development')
   * and technology stack names (e.g., 'unity-csharp'). When skill is a workflow stage name,
   * it also tries to match experiences by techStack if provided.
   *
   * @param {string} [skill] - Workflow stage skill name (e.g., 'architecture-design', 'code-development')
   * @param {string} [taskDescription]
   * @param {number} [limit=5]
   * @param {object} [options]
   * @param {string[]} [options.techStack] - Detected tech stack names for fallback matching
   * @returns {Promise<{ block: string, ids: string[] }>}
   */
  async getContextBlockWithIds(skill = null, taskDescription = null, limit = 5, options = {}) {
    const ExperienceType = require('./experience-types').ExperienceType;
    if (!skill) return { block: '', ids: [] };

    let scoreSort = true;
    let keyword = null;
    if (taskDescription && taskDescription.trim().length > 0) {
      let taskKeywords = extractKeywords(taskDescription, 10);
      if (taskKeywords.length > 0) {
        try {
          taskKeywords = await this._expandKeywordsWithLlm(taskKeywords, skill);
        } catch (_) { /* Silent fallback */ }
      }
      if (taskKeywords.length > 0) {
        keyword = taskKeywords.join(' ');
        scoreSort = true;
      }
    }

    const perTypeLimit = Math.max(1, Math.ceil(limit / 2));
    let positives = this.search({ type: ExperienceType.POSITIVE, skill, keyword, limit: perTypeLimit, scoreSort });
    let negatives = this.search({ type: ExperienceType.NEGATIVE, skill, keyword, limit: perTypeLimit, scoreSort });

    // P1 fix: If no results found and techStack is provided, try matching by tech stack skill
    const { techStack } = options;
    if (positives.length === 0 && negatives.length === 0 && techStack && techStack.length > 0) {
      // Map tech stack names to skill names (e.g., 'Unity + C#' -> 'unity-csharp')
      const techSkillNames = techStack.map(t => t.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-'));
      for (const techSkill of techSkillNames) {
        const techPositives = this.search({ type: ExperienceType.POSITIVE, skill: techSkill, keyword, limit: perTypeLimit, scoreSort });
        const techNegatives = this.search({ type: ExperienceType.NEGATIVE, skill: techSkill, keyword, limit: perTypeLimit, scoreSort });
        if (techPositives.length > 0 || techNegatives.length > 0) {
          positives = techPositives;
          negatives = techNegatives;
          console.log(`[ExperienceQuery] 🔄 Fallback to tech stack skill "${techSkill}" (${positives.length}+${negatives.length} experiences)`);
          break;
        }
      }
    }
    const ids = [...positives.map(e => e.id), ...negatives.map(e => e.id)];

    for (const id of ids) { this.markRetrieved(id); }

    const lines = ['## Accumulated Experience\n'];
    if (positives.length > 0) {
      lines.push('### ✅ Proven Patterns (use these)');
      for (const exp of positives) {
        lines.push(`\n**[${exp.category}] ${exp.title}**`);
        lines.push(exp.content);
        if (exp.codeExample) { lines.push('```'); lines.push(exp.codeExample); lines.push('```'); }
      }
    }
    if (negatives.length > 0) {
      lines.push('\n### ❌ Known Pitfalls (avoid these)');
      for (const exp of negatives) {
        lines.push(`\n**[${exp.category}] ${exp.title}**`);
        lines.push(exp.content);
        if (exp.codeExample) { lines.push('```'); lines.push(exp.codeExample); lines.push('```'); }
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
  },

  /**
   * P1 DRY fix: getContextBlock delegates to getContextBlockWithIds.
   */
  async getContextBlock(skill = null, taskDescription = null) {
    if (!skill) return '';
    return (await this.getContextBlockWithIds(skill, taskDescription)).block;
  },

  /**
   * Computes which injected experience IDs actually matched the current task context.
   */
  computeMatchedIds(ids, errorContext = '') {
    const ExperienceType = require('./experience-types').ExperienceType;
    if (!ids || ids.length === 0) {
      return { matchedIds: [], matchedCount: 0, totalCount: 0 };
    }

    const errorLower = (errorContext || '').toLowerCase();

    const matchedIds = ids.filter(id => {
      const exp = this._idIndex.get(id);
      if (!exp) return false;
      if (exp.type === ExperienceType.POSITIVE) return true;

      let matchScore = 0;
      const MATCH_THRESHOLD = 2;
      for (const tag of (exp.tags || [])) {
        if (tag.length >= 3 && errorLower.includes(tag.toLowerCase())) matchScore++;
      }
      const categoryTokens = (exp.category || '').toLowerCase().split('_').filter(t => t.length >= 4);
      for (const token of categoryTokens) {
        if (errorLower.includes(token)) matchScore++;
      }
      const titleTokens = (exp.title || '').toLowerCase()
        .replace(/[^\w\s]/g, ' ').split(/\s+/)
        .filter(t => t.length >= 5 && !STOPWORDS.has(t));
      for (const token of titleTokens) {
        if (errorLower.includes(token)) matchScore++;
      }
      return matchScore >= MATCH_THRESHOLD;
    });

    return { matchedIds, matchedCount: matchedIds.length, totalCount: ids.length };
  },

  // ─── LLM Query Expansion ──────────────────────────────────────────────────

  setLlmCall(llmCall) {
    if (typeof llmCall === 'function') {
      this._llmCall = llmCall;
      console.log(`[ExperienceStore] 🧠 LLM query expansion enabled.`);
    }
  },

  async _expandKeywordsWithLlm(keywords, skill = null) {
    if (!keywords || keywords.length === 0) return keywords;

    // Step 1: Synonym Table Lookup (O(1), 0ms)
    const cacheKey = keywords.slice().sort().join('|');
    const tableEntry = this._synonymTable[cacheKey];
    if (tableEntry) {
      // P1-10 fix: If this entry was a recent failure (<10 min), skip LLM retry
      if (tableEntry._failedAt && (Date.now() - tableEntry._failedAt) < 600_000) {
        return keywords;
      }
      if (Array.isArray(tableEntry.expandedTerms) && tableEntry.expandedTerms.length > 0) {
        const merged = [...keywords, ...tableEntry.expandedTerms].slice(0, 20);
        tableEntry.hitCount = (tableEntry.hitCount || 0) + 1;
        this._synonymTableDirty = true;
        console.log(`[ExperienceStore] 📖 Synonym table HIT: [${keywords.join(', ')}] → +${tableEntry.expandedTerms.length} cached terms (hit #${tableEntry.hitCount})`);
        return merged;
      }
    }

    // Step 2: LLM Query Expansion (fallback, ~1-3s)
    if (!this._llmCall) return keywords;

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
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Query expansion timeout')), 8000)
      );
      const response = await Promise.race([this._llmCall(prompt), timeoutPromise]);

      const cleaned = (response || '').replace(/```json?\s*/gi, '').replace(/```/g, '').trim();
      const arrayMatch = cleaned.match(/\[([^\]]+)\]/);
      if (!arrayMatch) {
        console.warn(`[ExperienceStore] ⚠️  Query expansion: could not parse LLM response as JSON array.`);
        // P1-10 fix: cache negative result to avoid retrying on next call
        this._synonymTable[cacheKey] = {
          expandedTerms: [],
          createdAt: new Date().toISOString(),
          hitCount: 0,
          skill: skill || null,
          _failedAt: Date.now(),
        };
        this._synonymTableDirty = true;
        return keywords;
      }

      let expanded;
      try { expanded = JSON.parse(`[${arrayMatch[1]}]`); } catch (_) {
        console.warn(`[ExperienceStore] ⚠️  Query expansion: JSON parse failed.`);
        return keywords;
      }

      const originalSet = new Set(keywords.map(k => k.toLowerCase()));
      const validTerms = expanded
        .filter(term => typeof term === 'string' && term.trim().length > 0)
        .map(term => term.trim().toLowerCase())
        .filter(term => !originalSet.has(term) && !STOPWORDS.has(term));

      if (validTerms.length === 0) return keywords;

      // Step 3: Persist to Synonym Table (write-through)
      this._synonymTable[cacheKey] = {
        expandedTerms: validTerms,
        createdAt: new Date().toISOString(),
        hitCount: 0,
        skill: skill || null,
      };
      this._synonymTableDirty = true;
      this._saveSynonymTable();

      const merged = [...keywords, ...validTerms].slice(0, 20);
      console.log(`[ExperienceStore] 🧠 Query expansion (LLM→table): [${keywords.join(', ')}] → +${validTerms.length} terms: [${validTerms.join(', ')}]`);
      return merged;
    } catch (err) {
      console.warn(`[ExperienceStore] ⚠️  Query expansion failed (${err.message}). Using original keywords.`);
      return keywords;
    }
  },

  // ─── Synonym Table ──────────────────────────────────────────────────────────

  _loadSynonymTable() {
    try {
      if (fs.existsSync(this._synonymTablePath)) {
        const raw = JSON.parse(fs.readFileSync(this._synonymTablePath, 'utf-8'));
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
  },

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
  },

  flushSynonymTable() {
    if (this._synonymTableDirty) { this._saveSynonymTable(); }
  },

  getSynonymStats() {
    const entries = Object.entries(this._synonymTable);
    const entryCount = entries.length;
    const totalHits = entries.reduce((sum, [, e]) => sum + (e.hitCount || 0), 0);
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
    const coldEntries = entries.filter(([, e]) => (e.hitCount || 0) === 0).length;
    const coldStartPct = entryCount > 0 ? Math.round((coldEntries / entryCount) * 100) : 100;
    return { entryCount, totalHits, topEntries, coldStartPct };
  },

  /**
   * Returns the full synonym table for use by other modules (PromptBuilder, ContextLoader).
   * Used to expand queries with synonyms for better recall.
   * @returns {Object} The synonym table object
   */
  getSynonymTable() {
    return this._synonymTable || {};
  },

  importSynonymTable(externalTable) {
    if (!externalTable || typeof externalTable !== 'object' || Array.isArray(externalTable)) {
      return { imported: 0, skipped: 0, total: Object.keys(this._synonymTable).length };
    }
    let imported = 0;
    let skipped = 0;
    for (const [key, entry] of Object.entries(externalTable)) {
      if (this._synonymTable[key]) {
        const existingTerms = new Set(this._synonymTable[key].expandedTerms || []);
        const newTerms = (entry.expandedTerms || []).filter(t => !existingTerms.has(t));
        if (newTerms.length > 0) {
          this._synonymTable[key].expandedTerms.push(...newTerms);
          imported++;
        } else { skipped++; }
      } else {
        this._synonymTable[key] = {
          expandedTerms: entry.expandedTerms || [],
          createdAt: entry.createdAt || new Date().toISOString(),
          hitCount: 0,
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
  },
};

module.exports = {
  extractKeywords,
  ExperienceQueryMixin,
  STOPWORDS,
  SHORT_WORD_WHITELIST,
};
