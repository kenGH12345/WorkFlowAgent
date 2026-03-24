/**
 * Experience Evolution – Hit tracking, adaptive thresholds, and evolution triggers
 *
 * Extracted from ExperienceStore to enable independent evolution of the
 * skill-promotion algorithm without touching storage or search logic.
 *
 * This module provides:
 *   - ExperienceEvolutionMixin – markUsed(), markRetrieved(), markUsedBatch(),
 *     triggerEvolutions(), flushDirty()
 *   - _computeEvolutionThreshold() – adaptive threshold based on category + tags
 */

'use strict';

const { ExperienceType, GENERIC_CATEGORIES, FRAMEWORK_CATEGORIES } = require('./experience-types');

// ─── Adaptive Evolution Threshold ────────────────────────────────────────────

/**
 * Computes the adaptive evolution threshold for a given experience entry.
 *
 * Base thresholds by category specificity:
 *   GENERIC    → 3 (fast: broadly applicable, quick to confirm)
 *   FRAMEWORK  → 7 (slow: need diverse domain evidence before promoting)
 *   OTHER      → 5 (moderate: default for unclassified categories)
 *
 * Tag-count modulator: +1 per 3 tags, capped at +3.
 *
 * @param {object} exp - Experience entry with category and tags fields
 * @returns {number} The evolution threshold
 */
function _computeEvolutionThreshold(exp) {
  let base;
  if (GENERIC_CATEGORIES.has(exp.category)) {
    base = 3;
  } else if (FRAMEWORK_CATEGORIES.has(exp.category)) {
    base = 7;
  } else {
    base = 5;
  }
  const tagBonus = Math.min(Math.floor((exp.tags?.length || 0) / 3), 3);
  return base + tagBonus;
}

// ─── P1 Auto-Create Helpers: Infer skill metadata from experience ────────────

/**
 * Infers a skill name from an experience's category and tags.
 * Uses a deterministic naming strategy: category-first_tag (e.g. "architecture-microservices").
 *
 * @param {object} exp - Experience entry
 * @returns {string} Inferred skill name (kebab-case, max 40 chars)
 */
function _inferSkillName(exp) {
  const category = (exp.category || 'general').replace(/_/g, '-');
  const primaryTag = (exp.tags && exp.tags.length > 0)
    ? exp.tags[0].toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-')
    : '';

  let name = primaryTag ? `${category}-${primaryTag}` : category;
  // Sanitise: only lowercase alphanumeric + hyphens, no leading/trailing hyphens
  name = name.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  // Cap length
  if (name.length > 40) name = name.slice(0, 40).replace(/-$/, '');
  return name || 'auto-skill';
}

/**
 * Infers domain tags from an experience's category and tags.
 *
 * @param {object} exp - Experience entry
 * @returns {string[]} Inferred domains
 */
function _inferDomains(exp) {
  const domains = new Set();
  const category = exp.category || '';

  // Map categories to domains
  const CATEGORY_TO_DOMAIN = {
    architecture: 'architecture',
    performance: 'performance',
    pitfall: 'debugging',
    debug_technique: 'debugging',
    stable_pattern: 'patterns',
    module_usage: 'backend',
    framework_limit: 'framework',
    framework_module: 'framework',
    engine_api: 'engine',
    ui_pattern: 'frontend',
    component: 'frontend',
    data_structure: 'data',
    network_protocol: 'networking',
    config_system: 'infrastructure',
    workflow_process: 'workflow',
    code_snippet: 'patterns',
  };

  if (CATEGORY_TO_DOMAIN[category]) {
    domains.add(CATEGORY_TO_DOMAIN[category]);
  }

  // Extract domain hints from tags
  const TAG_TO_DOMAIN = {
    react: 'frontend', vue: 'frontend', angular: 'frontend', css: 'frontend',
    node: 'backend', express: 'backend', api: 'backend', rest: 'backend',
    sql: 'database', mongo: 'database', redis: 'database', orm: 'database',
    docker: 'infrastructure', k8s: 'infrastructure', ci: 'infrastructure',
    security: 'security', auth: 'security', encrypt: 'security',
    test: 'testing', jest: 'testing', mocha: 'testing',
  };

  for (const tag of (exp.tags || [])) {
    const lowerTag = tag.toLowerCase();
    for (const [key, domain] of Object.entries(TAG_TO_DOMAIN)) {
      if (lowerTag.includes(key)) {
        domains.add(domain);
        break;
      }
    }
  }

  return [...domains].slice(0, 5); // Cap at 5 domains
}

/**
 * Infers trigger keywords from an experience's title, tags, and content.
 *
 * @param {object} exp - Experience entry
 * @returns {string[]} Inferred keywords for skill trigger matching
 */
function _inferKeywords(exp) {
  const keywords = new Set();

  // Add all tags as keywords
  for (const tag of (exp.tags || [])) {
    keywords.add(tag.toLowerCase());
  }

  // Extract meaningful words from title (skip stopwords)
  const SKIP = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall',
    'should', 'may', 'might', 'must', 'can', 'could', 'of', 'at', 'by', 'for',
    'with', 'about', 'against', 'between', 'through', 'during', 'before', 'after',
    'above', 'below', 'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off',
    'over', 'under', 'again', 'further', 'then', 'once', 'and', 'but', 'or',
    'nor', 'not', 'so', 'yet', 'both', 'each', 'few', 'more', 'most', 'other',
    'some', 'such', 'no', 'only', 'own', 'same', 'than', 'too', 'very',
    'use', 'using', 'when', 'how', 'what', 'where', 'why', 'which', 'this', 'that']);

  const titleWords = (exp.title || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
  for (const word of titleWords) {
    if (word.length >= 3 && !SKIP.has(word)) {
      keywords.add(word);
    }
  }

  return [...keywords].slice(0, 15); // Cap at 15 keywords
}

// ─── Gotcha vs Anti-Pattern Classification ──────────────────────────────────

/**
 * Environment/version/platform indicator keywords.
 * If an experience's content or tags match any of these, it is classified
 * as a "Gotcha" (specific trap) rather than a generic "Anti-Pattern".
 */
const ENV_SPECIFIC_KEYWORDS = new Set([
  // ── OS / Platform ──
  'windows', 'linux', 'macos', 'darwin', 'win32', 'posix',
  // ── Runtime versions ──
  'node', 'v14', 'v16', 'v18', 'v20', 'v22',
  'python2', 'python3', 'jdk', 'jdk8', 'jdk11', 'jdk17', 'jdk21',
  // ── Version / compatibility signals ──
  'version', 'upgrade', 'deprecated', 'breaking', 'migration',
  'compatibility', 'incompatible', 'legacy',
  // ── Environment ──
  'production', 'staging', 'ci', 'docker', 'container', 'k8s',
  'arm64', 'x86', 'amd64', 'apple silicon', 'm1', 'm2',
  // ── Browser ──
  'chrome', 'firefox', 'safari', 'edge', 'webkit',
]);

/**
 * Determines whether an experience is environment/version/platform-specific.
 *
 * Classification signals (any match → environment-specific):
 *   1. Tags contain an ENV_SPECIFIC_KEYWORD
 *   2. Content/description contains an ENV_SPECIFIC_KEYWORD (word-boundary match)
 *   3. Category is 'framework_limit' (inherently version-bound)
 *
 * @param {object} exp - Experience entry
 * @returns {boolean}
 */
function _isEnvironmentSpecific(exp) {
  // Signal 1: category is inherently version-bound
  if (exp.category === 'framework_limit') return true;

  // Signal 2: tags contain environment keywords
  const tags = exp.tags || [];
  for (const tag of tags) {
    if (ENV_SPECIFIC_KEYWORDS.has(tag.toLowerCase())) return true;
  }

  // Signal 3: content/description contains environment keywords
  const text = ((exp.content || '') + ' ' + (exp.description || '')).toLowerCase();
  if (text.length > 0) {
    for (const kw of ENV_SPECIFIC_KEYWORDS) {
      if (text.includes(kw)) return true;
    }
  }

  return false;
}

// ─── Gap 3: Smart Section Selection for Skill Evolution ──────────────────────

/**
 * Selects the best skill section to write an experience into based on:
 *   1. Experience type (positive → Best Practices, negative → Anti-Patterns)
 *   2. Experience category (pitfall, debug_technique, stable_pattern, etc.)
 *   3. Skill type (troubleshooting → Common Errors, standards → Coding Standards)
 *
 * This replaces the hardcoded 'Best Practices' section, enabling human-written
 * and auto-created skills to accumulate knowledge in the correct sections.
 *
 * @param {object} exp - Experience entry with type, category fields
 * @param {object} skillMeta - SkillMeta from registry (has type field)
 * @returns {string} Section name to evolve into
 */
function _selectEvolutionSection(exp, skillMeta) {
  const expType = exp.type || 'positive';
  const category = exp.category || '';
  const skillType = (skillMeta && skillMeta.type) || 'domain-skill';

  // ── Troubleshooting skills have specialised sections ─────────────────────
  if (skillType === 'troubleshooting') {
    if (category === 'pitfall' || expType === 'negative') return 'Common Errors';
    if (category === 'debug_technique') return 'Fix Recipes';
    return 'Prevention Rules';
  }

  // ── Standards skills have specialised sections ──────────────────────────
  if (skillType === 'standards') {
    if (category === 'stable_pattern') return 'Coding Standards';
    return 'Coding Standards';
  }

  // ── Default domain-skill / other types ──────────────────────────────────
  // Negative / pitfall experiences: distinguish Gotchas from Anti-Patterns.
  // Gotchas are environment/version/platform-specific traps that developers
  // *will* hit unless warned; Anti-Patterns are general programming prohibitions.
  if (expType === 'negative' || category === 'pitfall') {
    if (_isEnvironmentSpecific(exp)) {
      return 'Gotchas';
    }
    return 'Anti-Patterns';
  }

  // Debug techniques → Context Hints (knowledge for future debugging)
  if (category === 'debug_technique') {
    return 'Context Hints';
  }

  // Code snippets and utility classes → Code Snippets (reusable code patterns)
  if (category === 'code_snippet' || category === 'utility_class') {
    return 'Code Snippets';
  }

  // Stable patterns and module usage → Rules (prescriptive knowledge)
  if (category === 'stable_pattern' || category === 'module_usage') {
    return 'Rules';
  }

  // Default: Best Practices (positive/general knowledge)
  return 'Best Practices';
}

// ─── ExperienceEvolution Mixin ──────────────────────────────────────────────
// Mixed into ExperienceStore.prototype. References this.experiences, this._dirty, this._save().

const ExperienceEvolutionMixin = {

  /**
   * Increments the retrieval counter for an experience (zombie detection).
   */
  markRetrieved(expId) {
    const exp = this._idIndex.get(expId);
    if (!exp) return;
    if (!exp.retrievalCount) exp.retrievalCount = 0;
    exp.retrievalCount += 1;
    this._dirty = true;
  },

  /**
   * Marks an experience as "used" (increments hitCount).
   *
   * @param {string} expId
   * @returns {boolean} true if this experience should trigger skill evolution
   */
  markUsed(expId) {
    const exp = this._idIndex.get(expId);
    if (!exp) return false;
    exp.hitCount += 1;
    exp.updatedAt = new Date().toISOString();

    const threshold = _computeEvolutionThreshold(exp);
    // P0-2 fix: Use >= instead of === to prevent threshold skip when markUsed is
    // called multiple times in the same batch (e.g. duplicate IDs in markUsedBatch).
    // The _evolutionTriggered flag ensures evolution fires exactly once per experience.
    const shouldEvolve = exp.type === ExperienceType.POSITIVE
      && exp.hitCount >= threshold
      && !exp._evolutionTriggered;

    if (shouldEvolve) {
      exp._evolutionTriggered = true;
      this._save();
    } else {
      this._dirty = true;
    }

    return shouldEvolve;
  },

  /**
   * Marks multiple experiences as "effectively used" in a batch.
   *
   * @param {string[]} ids
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
  },

  /**
   * Flushes any pending dirty state to disk.
   *
   * @returns {Promise<void>}
   */
  flushDirty() {
    this.flushSynonymTable();
    if (this._dirty) {
      this._dirty = false;
      return this._save();
    }
    return Promise.resolve();
  },

  /**
   * Centralised skill evolution trigger.
   *
   * P1 Enhancement: Auto-create new skills from orphan experiences.
   *
   * Previously, experiences without a `skill` field were silently ignored.
   * Now, when a high-frequency experience has no associated skill, the system:
   *   1. Infers a skill name from the experience's category and tags
   *   2. Checks if a matching skill already exists in the registry
   *   3. If not → registers a new skill via skillEvolution.registerSkill()
   *   4. Evolves the newly created skill with the experience content
   *   5. Emits a 'skill_auto_created' hook event for observability
   *
   * This closes the "last-mile gap" in the evolution pipeline:
   *   Experience → hitCount threshold → evolve EXISTING skill ✅ (was already working)
   *   Experience → hitCount threshold → CREATE NEW skill → evolve ✅ (new path)
   *
   * @param {string[]} triggerExpIds
   * @param {object} skillEvolution - SkillEvolutionEngine instance
   * @param {object} hooks - HookSystem instance
   * @param {string} stageName
   * @returns {Promise<{ evolved: number, created: number }>} Evolution and creation counts
   */
  async triggerEvolutions(triggerExpIds, skillEvolution, hooks, stageName) {
    if (!triggerExpIds || triggerExpIds.length === 0) return { evolved: 0, created: 0 };
    let evolved = 0;
    let created = 0;

    for (const expId of triggerExpIds) {
      const triggerExp = this._idIndex.get(expId);
      if (!triggerExp) continue;

      let skillName = triggerExp.skill;

      // ── P1 Auto-Create: if experience has no associated skill, infer one ──
      if (!skillName) {
        skillName = _inferSkillName(triggerExp);

        // Check if this skill already exists in the registry
        if (skillEvolution.registry.has(skillName)) {
          // Skill exists — just associate the experience with it and evolve
          triggerExp.skill = skillName;
          console.log(`[EvolutionMixin] 🔗 Orphan experience "${triggerExp.title}" auto-linked to existing skill: ${skillName}`);
        } else {
          // Skill doesn't exist — create it!
          const domains = _inferDomains(triggerExp);
          const keywords = _inferKeywords(triggerExp);

          try {
            skillEvolution.registerSkill({
              name: skillName,
              description: `Auto-created skill from high-frequency experience: "${triggerExp.title}"`,
              domains,
              type: 'domain-skill',
              loadLevel: 'task',
              triggers: { keywords, roles: [] },
            });

            triggerExp.skill = skillName;
            created++;
            console.log(`[EvolutionMixin] ✨ Auto-created new skill "${skillName}" from orphan experience (hitCount=${triggerExp.hitCount})`);

            if (hooks) {
              await hooks.emit('skill_auto_created', {
                skillName,
                sourceExpId: expId,
                domains,
                keywords,
                reason: `Auto-created from high-frequency orphan experience (hitCount=${triggerExp.hitCount}) in ${stageName}`,
              }).catch(() => {});
            }
          } catch (createErr) {
            console.warn(`[EvolutionMixin] ⚠️  Auto-create skill "${skillName}" failed: ${createErr.message}`);
            continue; // Skip this experience, don't block others
          }
        }

        // Persist the skill association
        this._dirty = true;
      }

      // Now evolve the skill (whether pre-existing or newly created)
      if (skillName && skillEvolution.registry.has(skillName)) {
        // Gap 3 fix: select the appropriate section based on experience type/category
        // and the skill's type, instead of always writing to 'Best Practices'.
        // This ensures:
        //   - Negative/pitfall experiences go to 'Anti-Patterns' or 'Common Errors'
        //   - Debug experiences go to 'Fix Recipes' or 'Root Cause Analysis'
        //   - Positive patterns go to 'Best Practices' or 'Rules'
        //   - Human-written skills with custom sections get matched correctly
        const skillMeta = skillEvolution.registry.get(skillName);
        const section = _selectEvolutionSection(triggerExp, skillMeta);

        skillEvolution.evolve(skillName, {
          section,
          title: triggerExp.title,
          content: triggerExp.content,
          sourceExpId: expId,
          reason: `High-frequency pattern (hitCount=${triggerExp.hitCount}) – validated by ${stageName} stage success`,
        });
        if (hooks) {
          await hooks.emit('skill_evolved', { skillName, expId }).catch(() => {});
        }
        evolved++;
      }
    }

    if (created > 0) {
      console.log(`[EvolutionMixin] 📊 Evolution summary: ${evolved} evolved, ${created} new skill(s) auto-created.`);
    }

    return { evolved, created };
  },
};

module.exports = {
  ExperienceEvolutionMixin,
  _computeEvolutionThreshold,
  _selectEvolutionSection,
  _isEnvironmentSpecific,
};
