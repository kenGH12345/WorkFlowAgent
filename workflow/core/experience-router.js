/**
 * Experience Router — Cross-Project Experience Deep Integration (P2-1, Karpathy)
 *
 * Problem: ExperienceTransferMixin provides low-level export/import primitives,
 * but there's no intelligent layer that:
 *   1. Automatically identifies which experiences are worth migrating
 *   2. Pre-loads relevant experiences from a shared knowledge base at workflow start
 *   3. Scores experience relevance based on the current project's tech stack
 *   4. Maintains a cross-project experience index for O(1) lookup
 *
 * This module provides the "intelligent routing layer" on top of ExperienceTransferMixin.
 * It acts as a bridge between multiple project experience stores.
 *
 * Design:
 *   - File-based shared registry: ~/.codexforge/experience-registry.json
 *   - Each project registers itself and its high-value experiences on workflow completion
 *   - On workflow start, the router checks the registry for relevant experiences
 *   - Relevance scoring: tech stack overlap × experience quality × recency
 *   - Zero network dependencies (file-based only, future: shared DB/API)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Constants ──────────────────────────────────────────────────────────────

const REGISTRY_DIR = path.join(os.homedir(), '.codexforge');
const REGISTRY_PATH = path.join(REGISTRY_DIR, 'experience-registry.json');
const MAX_REGISTRY_PROJECTS = 100; // Cap the registry to prevent unbounded growth
const DEFAULT_RELEVANCE_THRESHOLD = 0.3; // Min score to auto-import an experience
const MAX_AUTO_IMPORT = 20; // Max experiences to auto-import per workflow start

// ─── Registry Schema ────────────────────────────────────────────────────────

/**
 * Registry entry for a project's experience catalog.
 * @typedef {object} ProjectRegistryEntry
 * @property {string}   projectId
 * @property {string}   projectRoot    - Absolute path to project root
 * @property {string[]} techStack      - Detected tech stack tags (e.g. ['node', 'react', 'typescript'])
 * @property {string}   experiencePath - Path to the exported experience file
 * @property {number}   experienceCount - Number of exportable experiences
 * @property {string}   lastUpdated    - ISO timestamp
 * @property {number}   qualityScore   - Average experience quality (0-1)
 */

// ─── Experience Router ──────────────────────────────────────────────────────

class ExperienceRouter {
  /**
   * @param {object} opts
   * @param {string}   opts.projectId
   * @param {string}   opts.projectRoot
   * @param {string[]} [opts.techStack]   - Current project's tech stack tags
   * @param {object}   [opts.experienceStore] - Reference to the current project's ExperienceStore
   * @param {string}   [opts.registryPath] - Override the default registry path (for testing)
   */
  constructor({ projectId, projectRoot, techStack = [], experienceStore = null, registryPath = null }) {
    this._projectId = projectId;
    this._projectRoot = projectRoot;
    this._techStack = new Set(techStack.map(t => t.toLowerCase()));
    this._experienceStore = experienceStore;
    this._registryPath = registryPath || REGISTRY_PATH;
    this._registry = null; // Lazy-loaded
  }

  // ─── Registry Management ────────────────────────────────────────────────

  /**
   * Loads the cross-project experience registry.
   * @returns {ProjectRegistryEntry[]}
   */
  _loadRegistry() {
    if (this._registry) return this._registry;
    try {
      if (fs.existsSync(this._registryPath)) {
        const raw = fs.readFileSync(this._registryPath, 'utf-8');
        this._registry = JSON.parse(raw);
        if (!Array.isArray(this._registry)) this._registry = [];
      } else {
        this._registry = [];
      }
    } catch {
      this._registry = [];
    }
    return this._registry;
  }

  /**
   * Saves the registry to disk.
   */
  _saveRegistry() {
    try {
      const dir = path.dirname(this._registryPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // Trim to MAX_REGISTRY_PROJECTS (keep most recently updated)
      if (this._registry.length > MAX_REGISTRY_PROJECTS) {
        this._registry.sort((a, b) => new Date(b.lastUpdated) - new Date(a.lastUpdated));
        this._registry = this._registry.slice(0, MAX_REGISTRY_PROJECTS);
      }
      const tmpPath = this._registryPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(this._registry, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this._registryPath);
    } catch (err) {
      console.warn(`[ExperienceRouter] ⚠️ Failed to save registry: ${err.message}`);
    }
  }

  // ─── Project Registration ───────────────────────────────────────────────

  /**
   * Registers (or updates) the current project in the cross-project registry.
   * Called at workflow completion to publish high-value experiences.
   *
   * @param {object} opts
   * @param {string} opts.experiencePath - Path to the exported universal experiences file
   * @param {number} opts.experienceCount
   * @param {number} [opts.qualityScore=0.5]
   */
  registerProject({ experiencePath, experienceCount, qualityScore = 0.5 }) {
    const registry = this._loadRegistry();
    const existing = registry.findIndex(e => e.projectId === this._projectId);

    const entry = {
      projectId: this._projectId,
      projectRoot: this._projectRoot,
      techStack: [...this._techStack],
      experiencePath,
      experienceCount,
      lastUpdated: new Date().toISOString(),
      qualityScore: Math.max(0, Math.min(1, qualityScore)),
    };

    if (existing >= 0) {
      registry[existing] = entry;
    } else {
      registry.push(entry);
    }

    this._registry = registry;
    this._saveRegistry();
    console.log(`[ExperienceRouter] 📋 Project "${this._projectId}" registered with ${experienceCount} experience(s).`);
  }

  // ─── Discovery & Scoring ────────────────────────────────────────────────

  /**
   * Discovers and scores experiences from other projects that are relevant
   * to the current project.
   *
   * @param {object} [opts]
   * @param {number} [opts.threshold=0.3]     - Minimum relevance score (0-1)
   * @param {number} [opts.maxResults=20]     - Maximum experiences to return
   * @returns {{ project: string, score: number, experiences: object[] }[]}
   */
  discoverRelevant({ threshold = DEFAULT_RELEVANCE_THRESHOLD, maxResults = MAX_AUTO_IMPORT } = {}) {
    const registry = this._loadRegistry();
    const results = [];

    for (const entry of registry) {
      // Skip self
      if (entry.projectId === this._projectId) continue;

      // Skip entries with no experience file
      if (!entry.experiencePath || !fs.existsSync(entry.experiencePath)) continue;

      // ── Score: Tech Stack Overlap ──────────────────────────────────
      const entryTechStack = new Set((entry.techStack || []).map(t => t.toLowerCase()));
      let overlapCount = 0;
      for (const tag of this._techStack) {
        if (entryTechStack.has(tag)) overlapCount++;
      }
      const maxPossible = Math.max(this._techStack.size, entryTechStack.size, 1);
      const techOverlap = overlapCount / maxPossible; // 0-1

      // ── Score: Quality ─────────────────────────────────────────────
      const quality = entry.qualityScore || 0.5;

      // ── Score: Recency ─────────────────────────────────────────────
      const ageMs = Date.now() - new Date(entry.lastUpdated).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      const recency = Math.max(0, 1 - ageDays / 365); // 0-1, decays over a year

      // ── Composite Score ────────────────────────────────────────────
      const score = (techOverlap * 0.5) + (quality * 0.3) + (recency * 0.2);

      if (score >= threshold) {
        try {
          const raw = fs.readFileSync(entry.experiencePath, 'utf-8');
          const exportData = JSON.parse(raw);
          const experiences = exportData.experiences || [];
          if (experiences.length > 0) {
            results.push({
              project: entry.projectId,
              score: Math.round(score * 100) / 100,
              experienceCount: experiences.length,
              techStack: entry.techStack,
              experiences,
            });
          }
        } catch {
          // Skip corrupt export files
        }
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    // Limit total experiences
    let totalExp = 0;
    const trimmed = [];
    for (const r of results) {
      const remaining = maxResults - totalExp;
      if (remaining <= 0) break;
      if (r.experiences.length > remaining) {
        r.experiences = r.experiences.slice(0, remaining);
        r.experienceCount = r.experiences.length;
      }
      totalExp += r.experiences.length;
      trimmed.push(r);
    }

    return trimmed;
  }

  // ─── Auto-Import ────────────────────────────────────────────────────────

  /**
   * Automatically discovers and imports relevant experiences from other projects
   * into the current project's ExperienceStore.
   *
   * Called at workflow start to pre-populate the experience store with
   * cross-project knowledge.
   *
   * @param {object} [opts]
   * @param {number} [opts.threshold=0.3]
   * @param {number} [opts.maxImport=20]
   * @param {string} [opts.conflictStrategy='skip']
   * @returns {{ imported: number, sources: string[], skipped: number }}
   */
  autoImport({ threshold = DEFAULT_RELEVANCE_THRESHOLD, maxImport = MAX_AUTO_IMPORT, conflictStrategy = 'skip' } = {}) {
    if (!this._experienceStore) {
      console.warn(`[ExperienceRouter] ⚠️ No ExperienceStore provided; skipping auto-import.`);
      return { imported: 0, sources: [], skipped: 0 };
    }

    const relevant = this.discoverRelevant({ threshold, maxResults: maxImport });
    let totalImported = 0;
    let totalSkipped = 0;
    const sources = [];

    for (const source of relevant) {
      const result = this._experienceStore.importFrom(
        { version: 1, sourceProject: source.project, experiences: source.experiences },
        { conflictStrategy, resetTTL: true }
      );
      totalImported += result.imported;
      totalSkipped += result.skipped;
      if (result.imported > 0) {
        sources.push(`${source.project}(${result.imported})`);
      }
    }

    if (totalImported > 0) {
      console.log(`[ExperienceRouter] 🌐 Auto-imported ${totalImported} experience(s) from ${sources.length} project(s): ${sources.join(', ')}`);
    } else if (relevant.length > 0) {
      console.log(`[ExperienceRouter] ℹ️ Found ${relevant.length} relevant project(s) but no new experiences to import (all skipped/duplicates).`);
    }

    return { imported: totalImported, sources, skipped: totalSkipped };
  }

  // ─── Publish ──────────────────────────────────────────────────────────

  /**
   * Publishes the current project's high-value experiences to the shared registry.
   * Called at workflow completion (FINISHED state).
   *
   * @param {object} [opts]
   * @param {number} [opts.minHitCount=2] - Minimum hit count for export
   * @param {string} [opts.outputDir]     - Directory to write the export file
   * @returns {{ published: number, path: string }}
   */
  publish({ minHitCount = 2, outputDir = null } = {}) {
    if (!this._experienceStore) {
      return { published: 0, path: null };
    }

    const exportDir = outputDir || path.join(REGISTRY_DIR, 'exports');
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }

    const exportPath = path.join(exportDir, `${this._projectId}-experiences.json`);
    const result = this._experienceStore.extractUniversalExperiences(exportPath, {
      minHitCount,
      projectId: this._projectId,
    });

    // Calculate quality score from experience store stats
    const stats = this._experienceStore.getStats();
    const qualityScore = stats.total > 0
      ? Math.min(1, (stats.positive / stats.total) * 0.7 + Math.min(stats.total / 50, 1) * 0.3)
      : 0.5;

    // Register in the cross-project registry
    this.registerProject({
      experiencePath: exportPath,
      experienceCount: result.exported,
      qualityScore,
    });

    return { published: result.exported, path: exportPath };
  }

  // ─── Diagnostics ──────────────────────────────────────────────────────

  /**
   * Returns the registry summary for diagnostic display.
   */
  getRegistrySummary() {
    const registry = this._loadRegistry();
    return {
      totalProjects: registry.length,
      currentProject: this._projectId,
      techStack: [...this._techStack],
      projects: registry.map(e => ({
        id: e.projectId,
        techStack: e.techStack,
        experienceCount: e.experienceCount,
        qualityScore: e.qualityScore,
        lastUpdated: e.lastUpdated,
        isSelf: e.projectId === this._projectId,
      })),
    };
  }
}

module.exports = { ExperienceRouter, REGISTRY_DIR, REGISTRY_PATH };
