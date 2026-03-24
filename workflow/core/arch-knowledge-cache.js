/**
 * arch-knowledge-cache.js – Distilled Architecture Knowledge Cache
 *
 * Single source of truth that fuses four data sources into one compact
 * cache file (~1000 tokens) for session cold-start injection:
 *
 *   1. AGENTS.md     → project structure fingerprint
 *   2. project-profile → tech stack + architecture pattern
 *   3. code-graph.json → module summary + hotspots
 *   4. task-history.json → recent task context
 *
 * The cache is incrementally maintained via dirty flags.
 * Consumers (memory-manager, agent-generator) read from this cache
 * instead of re-computing each time.
 *
 * File: output/arch-knowledge-cache.json
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { TaskHistory } = require('./task-history');

/** Maximum recent task entries to include in the cache */
const MAX_TASK_ENTRIES = 5;

/** Maximum hotspot entries */
const MAX_HOTSPOT_ENTRIES = 10;

/** Maximum module entries */
const MAX_MODULE_ENTRIES = 8;

/**
 * @typedef {object} ArchKnowledgeCache
 * @property {string} version          - Cache format version
 * @property {string} updatedAt        - ISO timestamp of last rebuild
 * @property {object} dirtyFlags       - Which sources changed since last rebuild
 * @property {object} structure        - From AGENTS.md: package list, top-level dirs
 * @property {object} techStack        - From project-profile: frameworks, arch, data
 * @property {object} codeGraph        - From code-graph.json: modules + hotspots
 * @property {object[]} recentTasks    - From task-history.json: last N task summaries
 * @property {string} distilledSummary - Pre-rendered ~1000 token Markdown block
 */

/**
 * Resolves the cache file path for a given project root.
 * Uses the project's own output/ directory if it exists,
 * otherwise falls back to workflow/output/.
 *
 * @param {string} projectRoot
 * @returns {string}
 */
function _resolveCachePath(projectRoot) {
  const projectOutputDir = path.join(projectRoot, 'output');
  if (fs.existsSync(projectOutputDir)) {
    return path.join(projectOutputDir, 'arch-knowledge-cache.json');
  }
  // Fallback: workflow output directory
  try {
    const { PATHS } = require('./constants');
    return path.join(PATHS.OUTPUT_DIR, 'arch-knowledge-cache.json');
  } catch {
    return path.join(projectRoot, 'output', 'arch-knowledge-cache.json');
  }
}

/**
 * Reads the existing cache from disk, or returns null if absent/corrupt.
 *
 * @param {string} projectRoot
 * @returns {ArchKnowledgeCache|null}
 */
function loadCache(projectRoot) {
  const cachePath = _resolveCachePath(projectRoot);
  try {
    if (!fs.existsSync(cachePath)) return null;
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Collects fresh data from all four sources and rebuilds the cache.
 * Only sections whose dirty flag is set will be re-computed;
 * clean sections are carried forward from the existing cache.
 *
 * @param {string} projectRoot
 * @param {object} [options]
 * @param {boolean} [options.forceAll=false]   - Force rebuild all sections
 * @param {object}  [options.projectProfile]   - Pre-loaded profile (optional)
 * @returns {ArchKnowledgeCache}
 */
function rebuildCache(projectRoot, options = {}) {
  const { forceAll = false, projectProfile = null } = options;

  const existing = loadCache(projectRoot);
  const dirty = forceAll
    ? { structure: true, techStack: true, codeGraph: true, taskHistory: true }
    : _detectDirtyFlags(projectRoot, existing);

  const cache = {
    version: '1.0.0',
    updatedAt: new Date().toISOString(),
    dirtyFlags: { structure: false, techStack: false, codeGraph: false, taskHistory: false },
    structure:    dirty.structure   ? _collectStructure(projectRoot)         : (existing && existing.structure    || {}),
    techStack:    dirty.techStack   ? _collectTechStack(projectRoot, projectProfile) : (existing && existing.techStack    || {}),
    codeGraph:    dirty.codeGraph   ? _collectCodeGraph(projectRoot)         : (existing && existing.codeGraph    || {}),
    recentTasks:  dirty.taskHistory ? _collectTaskHistory(projectRoot)       : (existing && existing.recentTasks  || []),
    distilledSummary: '', // will be rendered below
  };

  // Render the distilled Markdown summary (~1000 tokens)
  cache.distilledSummary = _renderDistilledSummary(cache);

  // Persist
  _saveCache(projectRoot, cache);

  const changedSections = Object.entries(dirty).filter(([, v]) => v).map(([k]) => k);
  if (changedSections.length > 0) {
    console.log(`[ArchKnowledgeCache] Rebuilt sections: ${changedSections.join(', ')}`);
  } else {
    console.log(`[ArchKnowledgeCache] Cache is fresh, no rebuild needed`);
  }

  return cache;
}

/**
 * Returns the pre-rendered distilled summary from cache.
 * If cache doesn't exist, triggers a full rebuild.
 *
 * @param {string} projectRoot
 * @param {object} [options]
 * @param {object} [options.projectProfile] - Pre-loaded profile
 * @returns {string} Markdown block (~1000 tokens)
 */
function getDistilledSummary(projectRoot, options = {}) {
  let cache = loadCache(projectRoot);
  if (!cache || !cache.distilledSummary) {
    cache = rebuildCache(projectRoot, { forceAll: true, ...options });
  }
  return cache.distilledSummary || '';
}

/**
 * Returns the distilled task-history section only (~200 tokens).
 * Used by AGENTS.md and IDE Agent definitions for session cold-start.
 *
 * @param {string} projectRoot
 * @returns {string} Markdown block
 */
function getTaskHistorySummary(projectRoot) {
  const cache = loadCache(projectRoot);
  const tasks = (cache && cache.recentTasks) || _collectTaskHistory(projectRoot);
  return _renderTaskHistorySection(tasks);
}

// ─── Dirty Flag Detection ─────────────────────────────────────────────────────

/**
 * Compares file mtimes against cached updatedAt to detect which sources changed.
 * @param {string} projectRoot
 * @param {ArchKnowledgeCache|null} existing
 * @returns {{ structure: boolean, techStack: boolean, codeGraph: boolean, taskHistory: boolean }}
 */
function _detectDirtyFlags(projectRoot, existing) {
  if (!existing || !existing.updatedAt) {
    return { structure: true, techStack: true, codeGraph: true, taskHistory: true };
  }

  const cacheTime = new Date(existing.updatedAt).getTime();

  const check = (relPath) => {
    try {
      const fullPath = path.join(projectRoot, relPath);
      if (!fs.existsSync(fullPath)) return false;
      return fs.statSync(fullPath).mtimeMs > cacheTime;
    } catch { return false; }
  };

  return {
    structure:   check('AGENTS.md'),
    techStack:   check('output/project-profile.md') || check('workflow.config.js'),
    codeGraph:   check('output/code-graph.json'),
    taskHistory: check('output/task-history.json') || check('workflow/output/task-history.json'),
  };
}

// ─── Data Collectors ──────────────────────────────────────────────────────────

/**
 * Collects project structure fingerprint from AGENTS.md.
 * Extracts package list and top-level directory names.
 */
function _collectStructure(projectRoot) {
  const result = { packages: [], topDirs: [] };
  try {
    const agentsPath = path.join(projectRoot, 'AGENTS.md');
    if (!fs.existsSync(agentsPath)) return result;
    const content = fs.readFileSync(agentsPath, 'utf-8');

    // Extract package names (lines like "- **name**: `dir/`")
    const pkgRe = /^\s*-\s+\*\*(.+?)\*\*:\s+`(.+?)`/gm;
    let m;
    while ((m = pkgRe.exec(content)) !== null) {
      result.packages.push({ name: m[1], dir: m[2] });
    }

    // Extract top-level dirs from the structure tree
    const dirRe = /^├── (\S+)\/?$/gm;
    while ((m = dirRe.exec(content)) !== null) {
      result.topDirs.push(m[1]);
    }
  } catch { /* non-fatal */ }
  return result;
}

/**
 * Collects tech stack info from project-profile.md and/or config.
 */
function _collectTechStack(projectRoot, profileOverride) {
  const result = { frameworks: [], architecture: null, dataLayer: null, testing: [] };

  // Try config-provided profile first
  if (profileOverride) {
    if (profileOverride.frameworks) {
      result.frameworks = profileOverride.frameworks.map(f => f.name || f);
    }
    if (profileOverride.architecture) {
      result.architecture = profileOverride.architecture.pattern || null;
    }
    if (profileOverride.dataLayer) {
      const dl = profileOverride.dataLayer;
      result.dataLayer = {
        orm: (dl.orm || []).slice(0, 3),
        databases: (dl.databases || []).slice(0, 3),
      };
    }
    if (profileOverride.testing && profileOverride.testing.frameworks) {
      result.testing = profileOverride.testing.frameworks.slice(0, 5);
    }
    return result;
  }

  // Fallback: parse project-profile.md
  try {
    const profilePath = path.join(projectRoot, 'output', 'project-profile.md');
    if (!fs.existsSync(profilePath)) return result;
    const content = fs.readFileSync(profilePath, 'utf-8');

    // Extract language distribution
    const langRe = /^-\s+`(\.\w+)`:\s+(\d+)\s+files/gm;
    let m;
    const langs = [];
    while ((m = langRe.exec(content)) !== null) {
      langs.push({ ext: m[1], count: parseInt(m[2], 10) });
    }
    if (langs.length > 0) {
      result.languages = langs.sort((a, b) => b.count - a.count).slice(0, 5);
    }
  } catch { /* non-fatal */ }

  return result;
}

/**
 * Collects module summary + hotspots from code-graph.json.
 */
function _collectCodeGraph(projectRoot) {
  const result = { symbolCount: 0, modules: [], hotspots: [] };
  try {
    const graphPath = path.join(projectRoot, 'output', 'code-graph.json');
    if (!fs.existsSync(graphPath)) return result;
    const raw = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));

    const symbols   = raw.symbols   || [];
    const filePaths = raw.filePaths || [];
    const hotspots  = raw.hotspots  || [];

    result.symbolCount = raw.symbolCount || symbols.length;

    // Module buckets
    const buckets = {};
    for (const sym of symbols) {
      const filePath = filePaths[sym.f] || '';
      const dir = filePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/') || '.';
      if (!buckets[dir]) buckets[dir] = { files: new Set(), classes: 0, functions: 0 };
      buckets[dir].files.add(sym.f);
      if (sym.k === 'class') buckets[dir].classes++;
      else if (sym.k === 'function' || sym.k === 'method') buckets[dir].functions++;
    }
    result.modules = Object.entries(buckets)
      .map(([dir, m]) => ({ dir, files: m.files.size, classes: m.classes, functions: m.functions }))
      .sort((a, b) => (b.classes + b.functions) - (a.classes + a.functions))
      .slice(0, MAX_MODULE_ENTRIES);

    // Hotspots: { f, n, cb, co, c }
    result.hotspots = hotspots.slice(0, MAX_HOTSPOT_ENTRIES).map(hs => ({
      name: hs.n,
      refs: hs.cb,
      calls: hs.co,
      category: hs.c,
      file: (filePaths[hs.f] || '').replace(/\\/g, '/'),
    }));
  } catch { /* non-fatal */ }
  return result;
}

/**
 * Collects recent task history using TaskHistory class.
 * This ensures a single source of truth for task history data.
 */
function _collectTaskHistory(projectRoot) {
  try {
    // Use TaskHistory class for consistent data access
    const candidates = [
      path.join(projectRoot, 'output', 'task-history.json'),
      path.join(projectRoot, 'workflow', 'output', 'task-history.json'),
    ];

    let storePath = null;
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        storePath = p;
        break;
      }
    }

    const taskHistory = new TaskHistory(storePath);
    const recentEntries = taskHistory.getRecent(MAX_TASK_ENTRIES);

    return recentEntries.map(entry => ({
      timestamp: entry.timestamp || null,
      goal:      (entry.goal || '').slice(0, 120),
      outcome:   entry.outcome || 'unknown',
      taskCount: entry.taskCount || 0,
      summary:   (entry.summary || '').slice(0, 150),
    }));
  } catch {
    return [];
  }
}

// ─── Rendering ────────────────────────────────────────────────────────────────

/**
 * Renders the full distilled Markdown summary (~1000 tokens).
 * This is the "single block" that gets injected at session cold-start.
 *
 * @param {ArchKnowledgeCache} cache
 * @returns {string}
 */
function _renderDistilledSummary(cache) {
  const lines = [];

  lines.push('## Architecture Knowledge Cache');
  lines.push('');
  lines.push(`> Auto-distilled. Last updated: ${cache.updatedAt}`);
  lines.push('');

  // ── Module Map ──
  if (cache.codeGraph && cache.codeGraph.modules && cache.codeGraph.modules.length > 0) {
    lines.push('### Module Map');
    lines.push('');
    lines.push('| Module | Files | Classes | Functions |');
    lines.push('|--------|-------|---------|-----------|');
    for (const m of cache.codeGraph.modules) {
      lines.push(`| \`${m.dir}\` | ${m.files} | ${m.classes} | ${m.functions} |`);
    }
    if (cache.codeGraph.symbolCount) {
      lines.push(`> ${cache.codeGraph.symbolCount} symbols total`);
    }
    lines.push('');
  }

  // ── Hotspots ──
  if (cache.codeGraph && cache.codeGraph.hotspots && cache.codeGraph.hotspots.length > 0) {
    lines.push('### 🔥 Hotspots');
    lines.push('');
    for (const hs of cache.codeGraph.hotspots) {
      lines.push(`- **${hs.name}** ← ${hs.refs} refs, ${hs.calls} calls [${hs.category}]`);
    }
    lines.push('');
  }

  // ── Tech Stack ──
  const ts = cache.techStack;
  if (ts) {
    const highlights = [];
    if (ts.frameworks && ts.frameworks.length > 0)   highlights.push(`Frameworks: ${ts.frameworks.join(', ')}`);
    if (ts.architecture)                              highlights.push(`Architecture: ${ts.architecture}`);
    if (ts.dataLayer) {
      const parts = [];
      if (ts.dataLayer.orm && ts.dataLayer.orm.length > 0)       parts.push(ts.dataLayer.orm.join(', '));
      if (ts.dataLayer.databases && ts.dataLayer.databases.length > 0) parts.push(ts.dataLayer.databases.join(', '));
      if (parts.length > 0) highlights.push(`Data: ${parts.join(' + ')}`);
    }
    if (ts.testing && ts.testing.length > 0)          highlights.push(`Testing: ${ts.testing.join(', ')}`);
    if (ts.languages && ts.languages.length > 0)      highlights.push(`Languages: ${ts.languages.map(l => `${l.ext}(${l.count})`).join(', ')}`);
    if (highlights.length > 0) {
      lines.push('### Tech Stack');
      lines.push('');
      for (const h of highlights) lines.push(`- ${h}`);
      lines.push('');
    }
  }

  // ── Recent Tasks ──
  lines.push(_renderTaskHistorySection(cache.recentTasks));

  return lines.filter(l => l !== undefined).join('\n');
}

/**
 * Renders the task-history section as compact Markdown (~200 tokens).
 *
 * @param {object[]} tasks - Recent task entries
 * @returns {string}
 */
function _renderTaskHistorySection(tasks) {
  if (!tasks || tasks.length === 0) return '';

  const lines = [];
  lines.push('### 📖 Recent Tasks');
  lines.push('');

  for (const t of tasks) {
    const icon = t.outcome === 'success' ? '✅'
               : t.outcome === 'partial' ? '⚠️'
               : t.outcome === 'failed'  ? '❌'
               : '❔';
    const date = t.timestamp ? t.timestamp.slice(0, 10) : '????-??-??';
    const summary = t.summary || t.goal || 'No summary';
    lines.push(`${icon} [${date}] ${summary}`);
  }

  lines.push('');
  lines.push('> _Maintain continuity: avoid repeating completed work._');
  lines.push('');
  return lines.join('\n');
}

// ─── Persistence ──────────────────────────────────────────────────────────────

/**
 * Atomically writes the cache to disk.
 */
function _saveCache(projectRoot, cache) {
  const cachePath = _resolveCachePath(projectRoot);
  try {
    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpPath = cachePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2), 'utf-8');
    fs.renameSync(tmpPath, cachePath);
    console.log(`[ArchKnowledgeCache] Cache written: ${cachePath}`);
  } catch (err) {
    console.warn(`[ArchKnowledgeCache] Could not save cache: ${err.message}`);
  }
}

module.exports = {
  loadCache,
  rebuildCache,
  getDistilledSummary,
  getTaskHistorySummary,
  MAX_TASK_ENTRIES,
  MAX_HOTSPOT_ENTRIES,
  MAX_MODULE_ENTRIES,
  // Exported for testing
  _detectDirtyFlags,
  _collectStructure,
  _collectTechStack,
  _collectCodeGraph,
  _collectTaskHistory,
  _renderDistilledSummary,
  _renderTaskHistorySection,
};
