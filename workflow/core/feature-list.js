/**
 * Feature List Manager – Structured feature acceptance tracking
 *
 * Inspired by the "long-running agent" pattern described in Anthropic's research:
 *   - All features start as `passes: false` to prevent premature completion
 *   - Each feature has end-to-end acceptance steps (like a human tester would follow)
 *   - Agents MUST NOT delete or modify acceptance steps – only update `passes` field
 *   - JSON format is intentional: models are less likely to accidentally overwrite JSON
 *     compared to Markdown files
 *
 * Feature lifecycle:
 *   not_started → in_progress → passes:true (done) | passes:false (failed/blocked)
 *
 * Usage:
 *   const fl = new FeatureList('./output/feature-list.json');
 *   fl.addFeature({ id: 'F001', category: 'functional', description: '...', steps: [...] });
 *   fl.startFeature('F001');
 *   fl.completeFeature('F001', 'Verified by Puppeteer: clicked button, saw response');
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { PATHS } = require('./constants');

// ─── Feature Status ───────────────────────────────────────────────────────────

const FeatureStatus = {
  NOT_STARTED:  'not_started',   // Initial state – passes: false
  IN_PROGRESS:  'in_progress',   // Agent is currently working on it
  DONE:         'done',          // passes: true, verified
  FAILED:       'failed',        // Attempted but verification failed
  BLOCKED:      'blocked',       // Cannot proceed due to dependency
};

// ─── Feature Category ─────────────────────────────────────────────────────────

const FeatureCategory = {
  FUNCTIONAL:    'functional',    // Core user-facing functionality
  UI:            'ui',            // Visual / layout features
  PERFORMANCE:   'performance',   // Speed, memory, load time
  SECURITY:      'security',      // Auth, permissions, data safety
  INTEGRATION:   'integration',   // Third-party / API integration
  ACCESSIBILITY: 'accessibility', // A11y requirements
  OTHER:         'other',
};

// ─── Feature List Manager ─────────────────────────────────────────────────────

class FeatureList {
  /**
   * @param {string} [storePath] - Path to persist feature list JSON
   */
  constructor(storePath = null) {
    this.storePath = storePath || path.join(PATHS.OUTPUT_DIR, 'feature-list.json');
    /** @type {Map<string, Feature>} */
    this.features = new Map();
    this._load();
  }

  // ─── Public API ───────────────────────────────────────────────────────────────

  /**
   * Adds a new feature to the list.
   * All features start with `passes: false` – this is intentional and MUST NOT be
   * changed at creation time. Only `completeFeature()` can set passes to true.
   *
   * @param {object}   options
   * @param {string}   options.id          - Unique feature ID (e.g. 'F001')
   * @param {string}   options.category    - Feature category (see FeatureCategory)
   * @param {string}   options.description - Human-readable feature description
   * @param {string[]} options.steps       - End-to-end acceptance steps (like a human tester)
   * @param {number}   [options.priority]  - Priority (lower = higher priority, default: 100)
   * @param {string[]} [options.deps]      - IDs of features that must be done first
   * @returns {Feature}
   */
  addFeature({ id, category, description, steps, priority = 100, deps = [] }) {
    if (this.features.has(id)) {
      throw new Error(`[FeatureList] Feature "${id}" already exists`);
    }
    if (!steps || steps.length === 0) {
      throw new Error(`[FeatureList] Feature "${id}" must have at least one acceptance step`);
    }

    const feature = {
      id,
      category: category || FeatureCategory.FUNCTIONAL,
      description,
      steps,           // Acceptance steps – MUST NOT be deleted or modified by agents
      passes: false,   // Always starts false – only completeFeature() can set to true
      status: FeatureStatus.NOT_STARTED,
      priority,
      deps,
      verificationNote: null,
      failureReason: null,
      claimedBy: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
    };

    this.features.set(id, feature);
    this._save();
    console.log(`[FeatureList] Feature added: ${id} – "${description.slice(0, 60)}"`);
    return feature;
  }

  /**
   * Marks a feature as in-progress (agent has started working on it).
   *
   * @param {string} featureId
   * @param {string} [agentId]
   * @returns {Feature}
   */
  startFeature(featureId, agentId = null) {
    const feature = this._getFeature(featureId);
    if (feature.status === FeatureStatus.DONE) {
      throw new Error(`[FeatureList] Feature "${featureId}" is already done`);
    }
    feature.status = FeatureStatus.IN_PROGRESS;
    feature.claimedBy = agentId;
    feature.startedAt = feature.startedAt || new Date().toISOString();
    feature.updatedAt = new Date().toISOString();
    this._save();
    console.log(`[FeatureList] Feature started: ${featureId}${agentId ? ` by "${agentId}"` : ''}`);
    return feature;
  }

  /**
   * Marks a feature as successfully completed (passes: true).
   *
   * Anti-premature-completion guard:
   *  - verificationNote is REQUIRED and must describe how each acceptance step was verified
   *  - This mirrors the article's requirement: "only mark passes:true after careful testing"
   *
   * @param {string} featureId
   * @param {string} verificationNote - REQUIRED: describe how acceptance steps were verified
   * @returns {Feature}
   * @throws {Error} if verificationNote is missing or empty
   */
  completeFeature(featureId, verificationNote) {
    if (!verificationNote || verificationNote.trim().length === 0) {
      throw new Error(
        `[FeatureList] Cannot complete feature "${featureId}" without a verificationNote. ` +
        `Describe how you verified each acceptance step. ` +
        `Marking a feature as done without verification is NOT acceptable.`
      );
    }

    const feature = this._getFeature(featureId);
    feature.passes = true;
    feature.status = FeatureStatus.DONE;
    feature.verificationNote = verificationNote.trim();
    feature.failureReason = null;
    feature.completedAt = new Date().toISOString();
    feature.updatedAt = new Date().toISOString();
    this._save();
    console.log(`[FeatureList] Feature completed: ${featureId} ✓ (verified: "${verificationNote.trim().slice(0, 80)}")`);
    return feature;
  }

  /**
   * Marks a feature as failed (passes remains false).
   *
   * @param {string} featureId
   * @param {string} failureReason - What went wrong
   * @returns {Feature}
   */
  failFeature(featureId, failureReason) {
    const feature = this._getFeature(featureId);
    feature.passes = false;
    feature.status = FeatureStatus.FAILED;
    feature.failureReason = failureReason || 'Unknown failure';
    feature.updatedAt = new Date().toISOString();
    this._save();
    console.warn(`[FeatureList] Feature failed: ${featureId} – ${failureReason}`);
    return feature;
  }

  /**
   * Marks a feature as blocked (waiting for dependency or external factor).
   *
   * @param {string} featureId
   * @param {string} reason
   * @returns {Feature}
   */
  blockFeature(featureId, reason) {
    const feature = this._getFeature(featureId);
    feature.status = FeatureStatus.BLOCKED;
    feature.failureReason = reason;
    feature.updatedAt = new Date().toISOString();
    this._save();
    return feature;
  }

  /**
   * Returns the next feature to work on (highest priority, not started or failed).
   * Respects dependency order: only returns features whose deps are all done.
   *
   * @returns {Feature|null}
   */
  getNextFeature() {
    const candidates = Array.from(this.features.values())
      .filter(f => {
        if (f.status === FeatureStatus.DONE) return false;
        if (f.status === FeatureStatus.IN_PROGRESS) return false;
        if (f.status === FeatureStatus.BLOCKED) return false;
        // Check deps
        const depsOk = f.deps.every(depId => {
          const dep = this.features.get(depId);
          return dep && dep.status === FeatureStatus.DONE;
        });
        return depsOk;
      })
      .sort((a, b) => a.priority - b.priority);

    return candidates[0] || null;
  }

  /**
   * Returns a progress summary.
   *
   * @returns {ProgressSummary}
   */
  getSummary() {
    const all = Array.from(this.features.values());
    const done = all.filter(f => f.status === FeatureStatus.DONE);
    const inProgress = all.filter(f => f.status === FeatureStatus.IN_PROGRESS);
    const failed = all.filter(f => f.status === FeatureStatus.FAILED);
    const blocked = all.filter(f => f.status === FeatureStatus.BLOCKED);
    const notStarted = all.filter(f => f.status === FeatureStatus.NOT_STARTED);

    return {
      total: all.length,
      done: done.length,
      inProgress: inProgress.length,
      failed: failed.length,
      blocked: blocked.length,
      notStarted: notStarted.length,
      completionRate: all.length > 0 ? Math.round((done.length / all.length) * 100) : 0,
      byCategory: this._groupByCategory(all),
      nextFeature: this.getNextFeature()?.id || null,
    };
  }

  /**
   * Returns all features as an array, sorted by priority.
   *
   * @returns {Feature[]}
   */
  getAllFeatures() {
    return Array.from(this.features.values()).sort((a, b) => a.priority - b.priority);
  }

  /**
   * Returns features filtered by status.
   *
   * @param {string} status - One of FeatureStatus values
   * @returns {Feature[]}
   */
  getFeaturesByStatus(status) {
    return Array.from(this.features.values())
      .filter(f => f.status === status)
      .sort((a, b) => a.priority - b.priority);
  }

  /**
   * Generates a feature list from a plain description array.
   * Useful for Init Agent to quickly populate the feature list from a spec.
   *
   * Each item in the descriptions array can be:
   *  - A string: treated as description, steps auto-generated as ["Verify: <description>"]
   *  - An object: { description, steps, category, priority, deps }
   *
   * @param {Array<string|object>} descriptions
   * @param {string} [defaultCategory]
   * @returns {Feature[]}
   */
  bulkAdd(descriptions, defaultCategory = FeatureCategory.FUNCTIONAL) {
    const added = [];
    descriptions.forEach((item, index) => {
      const id = `F${String(index + 1).padStart(3, '0')}`;
      if (this.features.has(id)) return; // Skip if already exists

      if (typeof item === 'string') {
        added.push(this.addFeature({
          id,
          category: defaultCategory,
          description: item,
          steps: [`Navigate to the relevant UI or endpoint`, `Verify: ${item}`, `Confirm no errors in console or logs`],
          priority: index + 1,
        }));
      } else {
        added.push(this.addFeature({
          id: item.id || id,
          category: item.category || defaultCategory,
          description: item.description,
          steps: item.steps || [`Verify: ${item.description}`],
          priority: item.priority !== undefined ? item.priority : index + 1,
          deps: item.deps || [],
        }));
      }
    });
    return added;
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────────

  _getFeature(featureId) {
    const feature = this.features.get(featureId);
    if (!feature) throw new Error(`[FeatureList] Feature not found: "${featureId}"`);
    return feature;
  }

  _groupByCategory(features) {
    const groups = {};
    for (const f of features) {
      if (!groups[f.category]) groups[f.category] = { total: 0, done: 0 };
      groups[f.category].total++;
      if (f.status === FeatureStatus.DONE) groups[f.category].done++;
    }
    return groups;
  }

  _load() {
    try {
      if (fs.existsSync(this.storePath)) {
        const data = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
        const items = Array.isArray(data) ? data : (data.features || []);
        for (const feature of items) {
          this.features.set(feature.id, feature);
        }
        console.log(`[FeatureList] Loaded ${this.features.size} features from ${this.storePath}`);
      }
    } catch (err) {
      console.warn(`[FeatureList] Could not load features: ${err.message}`);
    }
  }

  _save() {
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // Atomic write: write to .tmp first, then rename
      const tmpPath = this.storePath + '.tmp';
      fs.writeFileSync(
        tmpPath,
        JSON.stringify(Array.from(this.features.values()), null, 2),
        'utf-8'
      );
      fs.renameSync(tmpPath, this.storePath);
    } catch (err) {
      console.warn(`[FeatureList] Could not save features: ${err.message}`);
    }
  }
}

module.exports = { FeatureList, FeatureStatus, FeatureCategory };
