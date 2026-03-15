/**
 * Config Loader – Loads project-specific workflow configuration
 *
 * Looks for `workflow.config.js` (or `workflow.config.json`) in:
 *  1. The directory passed as argument
 *  2. The parent of the workflow/ directory (i.e. project root)
 *  3. process.cwd()
 *
 * If no config file is found, built-in defaults are used so the workflow
 * still works out-of-the-box for any project.
 *
 * Config file format (workflow.config.js):
 * ```js
 * module.exports = {
 *   // File extensions to scan for code symbols and experience generation
 *   sourceExtensions: ['.cs', '.lua'],
 *
 *   // Directories to ignore during scanning
 *   ignoreDirs: ['node_modules', '.git', 'Library', 'Temp', 'Packages'],
 *
 *   // Built-in skills to register on startup
 *   builtinSkills: [
 *     { name: 'my-skill', description: '...', domains: ['domain1'] },
 *   ],
 *
 *   // Classification rules for experience generation
 *   // Each rule: { ext: '.cs'|'.lua'|'*', test: (path, content) => bool, result: {...} | fn }
 *   classificationRules: [...],
 *
 *   // Default skill name used when no rule matches (per extension)
 *   defaultSkills: { '.cs': 'csharp-dev', '.lua': 'lua-scripting' },
 * };
 * ```
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Default Configuration ────────────────────────────────────────────────────

/**
 * Minimal built-in defaults – work for any project without a config file.
 * Projects override these by providing a workflow.config.js.
 */
const DEFAULT_CONFIG = {
  sourceExtensions: ['.js', '.ts', '.py', '.go', '.java', '.cs', '.lua'],
  ignoreDirs: ['node_modules', '.git', 'dist', 'build', 'output', '.vs', 'obj'],
  builtinSkills: [
    { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow', 'orchestration'] },
    { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality', 'review'] },
    { name: 'api-design',             description: 'REST/RPC API design rules and patterns', domains: ['backend', 'api'] },
  ],
  classificationRules: [],   // No project-specific rules by default
  defaultSkills: {},         // Falls back to extension-based naming
};

// ─── Loader ───────────────────────────────────────────────────────────────────

/**
 * Searches for a workflow config file starting from the given directory,
 * then walking up to the project root (parent of workflow/).
 *
 * @param {string} [startDir] - Directory to start searching from
 * @returns {{ config: object, configPath: string|null }}
 */
function loadConfig(startDir) {
  const searchDirs = _buildSearchDirs(startDir);
  const candidates = ['workflow.config.js', 'workflow.config.json'];

  for (const dir of searchDirs) {
    for (const filename of candidates) {
      const fullPath = path.join(dir, filename);
      if (fs.existsSync(fullPath)) {
        try {
          // Clear require cache so hot-reload works in watch mode
          delete require.cache[require.resolve(fullPath)];
          const userConfig = require(fullPath);
          const merged = _mergeConfig(DEFAULT_CONFIG, userConfig);
          console.log(`[ConfigLoader] Loaded config from: ${fullPath}`);
          return { config: merged, configPath: fullPath };
        } catch (err) {
          console.warn(`[ConfigLoader] Failed to load config at ${fullPath}: ${err.message}`);
        }
      }
    }
  }

  console.log(`[ConfigLoader] No workflow.config.js found. Using built-in defaults.`);
  return { config: { ...DEFAULT_CONFIG }, configPath: null };
}

/**
 * Builds the list of directories to search for a config file.
 *
 * Priority rules:
 *  - If startDir is explicitly provided → ONLY search startDir.
 *    This prevents accidentally picking up a config from a different project
 *    when the workflow is invoked with --path pointing to another directory.
 *  - If startDir is NOT provided → search: cwd → workflow parent dir → workflow dir
 *    (covers the common case where the user runs from the project root)
 */
function _buildSearchDirs(startDir) {
  const dirs = [];

  if (startDir) {
    // Explicit project root: only look there, nowhere else
    dirs.push(path.resolve(startDir));
    return dirs;
  }

  // No explicit root: try cwd first, then the workflow's own parent (= project root
  // when workflow/ is a sub-folder of the project), then the workflow dir itself
  const cwd = process.cwd();
  const workflowParent = path.resolve(__dirname, '..', '..');
  const workflowDir    = path.resolve(__dirname, '..');

  const seen = new Set();
  for (const d of [cwd, workflowParent, workflowDir]) {
    if (!seen.has(d)) { seen.add(d); dirs.push(d); }
  }

  return dirs;
}

/**
 * Deep-merges user config on top of defaults.
 * Arrays are replaced (not concatenated) so users have full control.
 */
function _mergeConfig(defaults, user) {
  const result = { ...defaults };

  for (const key of Object.keys(user)) {
    if (user[key] === undefined || user[key] === null) continue;

    if (Array.isArray(user[key])) {
      // Arrays replace defaults entirely
      result[key] = user[key];
    } else if (typeof user[key] === 'object' && user[key] !== null && !Array.isArray(user[key])) {
      result[key] = { ...defaults[key], ...user[key] };
    } else {
      result[key] = user[key];
    }
  }

  return result;
}

// ─── Singleton Cache ──────────────────────────────────────────────────────────

let _cachedConfig = null;
let _cachedConfigPath = null;

/**
 * Returns the cached config, loading it on first call.
 * Pass `forceReload = true` to bypass the cache (useful in tests).
 *
 * N43 fix: when a projectRoot is explicitly provided, bypass the module-level singleton
 * cache entirely and load fresh. This prevents multiple Orchestrator/MemoryManager
 * instances from racing to clear and repopulate the shared cache, which could cause
 * one instance to silently use another instance's config.
 *
 * The module-level cache is only used for the "no projectRoot" case (CLI / single-instance
 * scenarios) where sharing a cached config is safe and desirable.
 *
 * @param {string}  [projectRoot] - Project root to search from
 * @param {boolean} [forceReload] - Bypass cache (legacy parameter, still respected)
 * @returns {object} Merged configuration object
 */
function getConfig(projectRoot, forceReload = false) {
  // When a projectRoot is explicitly provided, always load fresh to avoid cross-instance
  // cache pollution. Each Orchestrator/MemoryManager gets its own isolated config.
  if (projectRoot) {
    const { config, configPath } = loadConfig(projectRoot);
    // Only update the module-level cache if it is currently empty (first caller wins).
    // This preserves backward-compatible behaviour for code that calls getConfigPath()
    // after getConfig(projectRoot) without caring about multi-instance isolation.
    if (!_cachedConfig) {
      _cachedConfig = config;
      _cachedConfigPath = configPath;
    }
    return config;
  }

  // No projectRoot: use the module-level singleton (safe for single-instance use).
  if (_cachedConfig && !forceReload) return _cachedConfig;

  const { config, configPath } = loadConfig(undefined);
  _cachedConfig = config;
  _cachedConfigPath = configPath;
  return config;
}

/**
 * Returns the path of the loaded config file, or null if using defaults.
 */
function getConfigPath() {
  return _cachedConfigPath;
}

/**
 * Clears the singleton cache (useful for testing or hot-reload scenarios).
 */
function clearConfigCache() {
  _cachedConfig = null;
  _cachedConfigPath = null;
}

module.exports = { loadConfig, getConfig, getConfigPath, clearConfigCache, DEFAULT_CONFIG };
