/**
 * Code Graph – Structured code index with call relationships.
 *
 * Builds a queryable, structured index of the project codebase without
 * requiring vector embeddings. Extends the existing scanCodeSymbols()
 * thick tool with:
 *
 *  1. Symbol index  – class/function/module with file location + line number
 *  2. Function body summary – first comment block + parameter names
 *  3. Call graph    – which functions call which (static analysis, best-effort)
 *  4. Module graph  – which files import/require which
 *  5. Query API     – search by name, keyword, file, or caller/callee
 *
 * Output:
 *  - output/code-graph.json  (full machine-readable index)
 *  - output/code-graph.md    (human-readable summary for AGENTS.md injection)
 *
 * Design: zero external dependencies, pure Node.js regex-based analysis.
 * Supports: .js, .ts, .cs, .lua, .go, .py, .dart
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { Worker }       = require('worker_threads');
const { translateMdFile } = require('./i18n-translator');

// ─── Worker Threads Configuration ─────────────────────────────────────────────
// P3: For projects exceeding this threshold, file reading + regex extraction
// is distributed across multiple worker threads for parallel CPU utilisation.
// Below this threshold, the main thread handles everything (lower overhead).
const WORKER_FILE_THRESHOLD = 500;
const WORKER_SCRIPT = path.join(__dirname, 'code-graph-worker.js');

// ─── Non-Code Directories (always skipped to save I/O on large projects) ──────
// These directories almost never contain scannable source files, so we skip them
// during recursive traversal to avoid wasting I/O on million-file projects.
const NON_CODE_DIRS = new Set([
  // Media & resources (NOTE: 'assets' intentionally NOT included – Unity keeps code under Assets/)
  'images', 'img', 'icons', 'fonts', 'media', 'videos', 'audio', 'textures', 'sprites',
  // Documentation & static content
  'docs', 'doc', 'documentation', 'wiki', 'static', 'public',
  // Data & fixtures
  'data', 'fixtures', 'samples', 'testdata', 'test-data', 'mock', 'mocks', '__mocks__',
  // Generated / third-party
  'generated', 'gen', 'auto-generated', 'third_party', 'thirdparty', '3rdparty', 'external',
  // Logs & temp
  'logs', 'log', 'tmp', 'temp', 'cache', '.cache',
  // IDE / tooling
  '.idea', '.vscode', '.vs', '.settings',
  // Localization (bulk files)
  'locales', 'locale', 'i18n', 'l10n', 'translations',
]);

// ─── Symbol Types (single source of truth: code-graph-types.js) ───────────────
const { SymbolKind } = require('./code-graph-types');

// ─── Process-level singleton cache (P1 optimisation) ─────────────────────────
// Prevents redundant disk I/O + JSON.parse when multiple CodeGraph instances
// are created in the same process (e.g. ContextLoader, Orchestrator, devtools).
// Cache key = absolute path to code-graph.json.
// Invalidated when build() writes a new version (via _invalidateCache).
const _processCache = new Map();

// ─── P2: Module description inference (used by toMarkdown) ────────────────────
// Infers a one-line description for a directory module from its path segments.
// This is a lightweight heuristic – no file I/O or AI needed.
function _inferModuleDescription(dirPath) {
  const segments = dirPath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.length === 0) return 'Root module';
  const last = segments[segments.length - 1].toLowerCase();
  const KNOWN_MODULES = {
    core: 'Core business logic',
    utils: 'Utility functions and helpers',
    helpers: 'Helper functions and utilities',
    models: 'Data models and entities',
    views: 'View components and UI',
    components: 'Reusable UI components',
    services: 'Service layer',
    controllers: 'Controller layer',
    routes: 'Routing configuration',
    middleware: 'Middleware handlers',
    hooks: 'Hook adapters and extensions',
    commands: 'Command handlers',
    tools: 'Tool implementations',
    config: 'Configuration management',
    tests: 'Test suites',
    api: 'API endpoints',
    store: 'State management',
    adapters: 'Adapter/integration layer',
    output: 'Output artifacts',
    lib: 'Library code',
    src: 'Source code',
    scripts: 'Build and utility scripts',
    screens: 'Screen/page components',
    widgets: 'Widget components',
    providers: 'Provider/DI components',
  };
  if (KNOWN_MODULES[last]) return KNOWN_MODULES[last];
  // Fallback: CamelCase-split the last segment
  const words = last.replace(/[-_]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ─── CodeGraph ────────────────────────────────────────────────────────────────

class CodeGraph {
  /**
   * @param {object} options
   * @param {string}   options.projectRoot  - Root directory to scan
   * @param {string}   options.outputDir    - Where to write output files
   * @param {string[]} [options.extensions] - File extensions to scan
   * @param {string[]} [options.ignoreDirs] - Directories to skip
   * @param {string[]} [options.scopeDirs]  - Only scan these sub-directories (for large monorepos)
   * @param {object}   [options.techProfile] - P2-1: Tech profile from ProjectProfiler. When provided,
   *   enables intelligent optimisations: skip irrelevant language parsers, boost
   *   framework-specific symbol detection, and enrich module descriptions.
   *
   * Three-layer automatic filtering (always active, no config needed):
   *   Layer 1: .gitignore patterns → skips node_modules/, dist/, build/, etc.
   *   Layer 2: NON_CODE_DIRS set → skips images/, fonts/, docs/, data/, etc.
   *   Layer 3: Extension check → only collects files matching `extensions`
   *
   * @deprecated options.maxFiles - No longer truncates. A warning is logged if >50K files found.
   * @deprecated options.useGitignore - Always true. .gitignore is always parsed.
   * @deprecated options.skipNonCodeDirs - Always true. Non-code dirs are always skipped.
   */
  constructor({
    projectRoot,
    outputDir,
    extensions = ['.js', '.ts', '.cs', '.lua', '.go', '.py', '.dart'],
    ignoreDirs = ['node_modules', '.git', 'build', 'dist', 'output', 'Library', 'Temp', 'obj', 'Packages', '.dart_tool'],
    llmCall        = null,
    scopeDirs      = [],
    techProfile    = null,
    // ── Deprecated options (kept for backward-compat, silently ignored) ──
    // maxFiles, useGitignore, skipNonCodeDirs are no longer needed.
    // The three-layer filter (gitignore + NON_CODE_DIRS + extension check)
    // already ensures only real code files are collected. maxFiles was
    // harmful because it randomly truncated valid code files.
    maxFiles: _deprecated_maxFiles,
    useGitignore: _deprecated_useGitignore,
    skipNonCodeDirs: _deprecated_skipNonCodeDirs,
  } = {}) {
    this._root       = projectRoot;
    this._outputDir  = outputDir;
    this._extensions = new Set(extensions);
    this._ignoreDirs = new Set(ignoreDirs);
    this._llmCall    = llmCall;
    this._scopeDirs  = Array.isArray(scopeDirs) ? scopeDirs : [];

    // P2-1: Tech profile fusion – when available, enables cross-engine optimisations
    this._techProfile = techProfile;

    // ── IDE-First Architecture (ADR-37) ──────────────────────────────────────
    // When running inside an IDE (Cursor, VS Code, etc.), CodeGraph serves as a
    // FALLBACK for code search. The AI Agent should prefer IDE-native tools:
    //   - codebase_search (semantic) over CodeGraph.search() (TF-IDF)
    //   - grep_search (ripgrep) over CodeGraph substring search
    //   - view_code_item (compiler-accurate) over CodeGraph.querySymbol() (regex)
    //
    // CodeGraph remains ESSENTIAL for unique capabilities no IDE provides:
    //   - Hotspot analysis (which files/symbols change most frequently)
    //   - Module summary (high-level codebase overview for prompt injection)
    //   - Reusable symbols digest (exported functions/classes for dev context)
    //   - Call graph / dependency graph (inter-module relationships)
    //
    // This flag is informational — it doesn't change CodeGraph behavior, but is
    // exposed for logging and diagnostics. The actual routing happens via:
    //   - SmartContextSelector (reduces CODE_GRAPH priority when IDE detected)
    //   - PromptBuilder (injects IDE Tool Guidance telling Agent to prefer IDE tools)
    try {
      const { ideHasSemanticSearch } = require('./ide-detection');
      this._ideSearchAvailable = ideHasSemanticSearch();
      if (this._ideSearchAvailable) {
        console.log(`[CodeGraph] 🏠 IDE semantic search available — CodeGraph operates in fallback mode for search`);
        console.log(`[CodeGraph]    Unique capabilities still active: hotspot, module summary, reusable symbols, call graph`);
      }
    } catch (_) {
      this._ideSearchAvailable = false;
    }

    // Warn threshold: if collected files exceed this, log a warning (but never truncate).
    // This replaces the old maxFiles hard-truncation which randomly discarded valid code files.
    this._warnFileThreshold = 50000;

    // Always parse .gitignore – this is a core safety mechanism, not optional.
    // It prevents scanning node_modules/, dist/, build/, etc.
    const gitignorePatterns = this._loadGitignoreDirs(projectRoot);
    for (const p of gitignorePatterns) {
      this._ignoreDirs.add(p);
    }
    if (gitignorePatterns.length > 0) {
      console.log(`[CodeGraph] 📋 Loaded ${gitignorePatterns.length} directory patterns from .gitignore`);
    }

    /** @type {Map<string, SymbolEntry>} symbolId → entry */
    this._symbols = new Map();
    /** @type {Map<string, string[]>} symbolId → list of called symbolIds */
    this._callEdges = new Map();
    /** @type {Map<string, string[]>} filePath → list of imported filePaths */
    this._importEdges = new Map();

    /** @type {Map<string, number>} relPath → mtimeMs. P1-5: Populated during build
     *  to avoid re-statting all files in _saveCache(). */
    this._fileMtimes = new Map();
    this._calledByIndex = null;      // P1-2: Cached reverse-index (symbolId → callers)
    this._importanceWeights = null;   // P1-2: Cached importance weights

    // ── P0 Symbol Importance Weights ─────────────────────────────────────────
    // Maps symbolId → importance weight (0-1).  Computed from cross-file
    // calledBy count + importedBy count.  Used as a search ranking boost.
    /** @type {Map<string, number>|null} symbolId → normalised importance weight (0-1) */
    this._importanceWeights = null;

    // ── P1 Semantic Search: Inverted Token Index ─────────────────────────────
    // Maps lowercase word token → Set<symbolId>.  Built lazily on first search
    // or explicitly after build/load.  Enables O(1) token lookup instead of
    // O(N) full scan for every search query.
    /** @type {Map<string, Set<string>>|null} token → Set<symbolId> */
    this._tokenIndex = null;

    // ── P1 LSP On-Demand Enrichment ──────────────────────────────────────────
    // When an LSPAdapter is injected (via setLSPAdapter), query-time enrichment
    // can leverage compiler-accurate type info from the language server.
    /** @type {object|null} LSPAdapter instance (optional) */
    this._lspAdapter = null;
    /** @type {Map<string, object>} symbolId → LSP hover cache */
    this._lspCache = new Map();

    /** @type {boolean} Flag: true when _loadFromDisk() detected v1 format on disk */
    this._needsFormatUpgrade = false;
    /** @type {Promise|null} In-flight format upgrade write (prevents duplicate writes) */
    this._upgradePromise = null;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Scan the project and build the code graph.
   *
   * @param {object} [options]
   * @param {boolean} [options.incremental=true] - When true, reuse cached data and
   *   only re-process files whose mtime has changed since the last build. Falls
   *   back to a full rebuild when no valid cache is found.
   * @param {boolean} [options.force=false] - Force a full rebuild even if cache exists.
   * @param {string[]} [options.patchFiles] - When provided (relative paths), skip full
   *   scan and only re-process these specific files in-place. The in-memory data
   *   structures are patched directly without clear+restore, making this O(N) where
   *   N = number of changed files, not the total project size. Falls back to normal
   *   incremental build if in-memory data is empty.
   * @param {boolean} [options.writeOutput=true] - Whether to write code-graph.json/md
   *   to disk after building. Set to false for intermediate builds (e.g. post-developer)
   *   where a final FINISHED build will write output anyway.
   * @param {boolean} [options.quickScan=false] - When true AND in-memory data exists,
   *   perform a fast mtime-only scan to detect changed files, then use patch mode.
   *   Much faster than full incremental: skips clear+restore+full-scan. Ideal for
   *   post-developer rebuilds where the graph is already in memory.
   * @returns {{ symbolCount: number, fileCount: number, edgeCount: number, graphPath: string, incremental: boolean, changedFiles: number, patchMode: boolean }}
   */
  async build({ incremental = true, force = false, patchFiles = null, writeOutput = true, quickScan = false } = {}) {
    // ── Patch Mode: in-place update for known changed files ──────────────
    // When patchFiles is provided AND we already have in-memory data, bypass
    // the expensive full scan/clear/restore cycle entirely. This is the fast
    // path for post-developer rebuilds where only a few files changed.
    if (Array.isArray(patchFiles) && patchFiles.length > 0 && this._symbols.size > 0) {
      return this._patchBuild(patchFiles, writeOutput);
    }

    // ── Quick Scan Mode: auto-detect changed files via mtime comparison ──
    // When quickScan is true AND we have in-memory data AND a valid cache exists,
    // compare file mtimes against cache to find changed files, then use patch mode.
    // This avoids the expensive clear+restore cycle of normal incremental build.
    if (quickScan && this._symbols.size > 0 && !force) {
      const cachePath = path.join(this._outputDir, '.code-graph-cache.json');
      const detected = this._detectChangedFilesByMtime(cachePath);
      if (detected !== null) {
        // detected is an array of relative paths; may be empty if nothing changed
        if (detected.length === 0) {
          console.log(`[CodeGraph] ⚡ Quick scan: no files changed since last build – skipping`);
          return {
            symbolCount:  this._symbols.size,
            fileCount:    0,
            edgeCount:    [...this._callEdges.values()].reduce((n, v) => n + v.length, 0),
            graphPath:    null,
            incremental:  true,
            changedFiles: 0,
            patchMode:    true,
          };
        }
        return this._patchBuild(detected, writeOutput);
      }
      // detected === null means cache is invalid; fall through to normal build
      console.log(`[CodeGraph] ⚠️  Quick scan: no valid cache found, falling back to normal build`);
    }

    console.log('');
    console.log(`[CodeGraph] 🔍 Building code graph for: ${this._root}`);
    this._symbols.clear();
    this._callEdges.clear();
    this._importEdges.clear();

    // If scopeDirs is specified, only scan those sub-directories.
    // Each entry can be:
    //   1. An exact relative path (e.g. 'src/core') – used directly.
    //   2. A keyword (e.g. 'lua') – matches any top-level directory whose
    //      name contains the keyword (case-insensitive), so 'lua' will
    //      also match 'XLua', 'tolua', 'lua_modules', etc.
    let files;
    if (this._scopeDirs.length > 0) {
      files = [];
      const matchedDirs = [];
      for (const entry of this._scopeDirs) {
        const absDir = path.resolve(this._root, entry);
        if (fs.existsSync(absDir) && fs.statSync(absDir).isDirectory()) {
          // Exact path match
          matchedDirs.push(entry);
          files.push(...this._collectFiles(absDir));
        } else {
          // Fall back to keyword-contains matching against top-level dirs
          const keyword = entry.toLowerCase();
          let found = false;
          try {
            const topLevelEntries = fs.readdirSync(this._root, { withFileTypes: true });
            for (const dirent of topLevelEntries) {
              if (!dirent.isDirectory()) continue;
              if (this._ignoreDirs.has(dirent.name)) continue;
              if (dirent.name.toLowerCase().includes(keyword)) {
                found = true;
                const matched = path.join(this._root, dirent.name);
                matchedDirs.push(dirent.name);
                files.push(...this._collectFiles(matched));
              }
            }
          } catch (_) { /* ignore readdir errors */ }
          if (!found) {
            console.warn(`[CodeGraph] ⚠️  scopeDirs entry matched no directory: "${entry}"`);
          }
        }
      }
      console.log(`[CodeGraph] 📂 Scoped scan (matched): ${matchedDirs.join(', ')}`);
    } else {
      files = this._collectFiles(this._root);
    }
    // Warn if an unusually large number of code files were found.
    // This is informational only – NO truncation. Every collected file is a
    // valid code file (after .gitignore + NON_CODE_DIRS + extension filtering).
    if (files.length >= this._warnFileThreshold) {
      console.warn(`[CodeGraph] ⚠️  Large project detected: ${files.length} code files. First full build may take a while.`);
      console.warn(`[CodeGraph]    💡 Tip: use codeGraph.scopeDirs in workflow.config.js to limit scan scope for faster init.`);
    }

    // ── Incremental scan logic ─────────────────────────────────────────────
    const cachePath = path.join(this._outputDir, '.code-graph-cache.json');
    let cache = null;
    let isIncremental = false;
    let changedFiles = [];
    let removedFiles = [];
    let unchangedFiles = [];

    if (incremental && !force) {
      cache = this._loadCache(cachePath);
    }

    if (cache) {
      // Determine which files changed, were added, or removed
      const currentFileSet = new Set(files.map(f => path.relative(this._root, f).replace(/\\/g, '/')));
      const cachedFileSet = new Set(Object.keys(cache.fileMtimes || {}));

      for (const filePath of files) {
        const relPath = path.relative(this._root, filePath).replace(/\\/g, '/');
        const cachedMtime = cache.fileMtimes?.[relPath];
        if (cachedMtime == null) {
          // New file
          changedFiles.push(filePath);
        } else {
          try {
            const stat = fs.statSync(filePath);
            // P1-5: Capture mtime during comparison to avoid re-statting in _saveCache
            this._fileMtimes.set(relPath, stat.mtimeMs);
            if (stat.mtimeMs > cachedMtime) {
              changedFiles.push(filePath);
            } else {
              unchangedFiles.push(filePath);
            }
          } catch (_) {
            changedFiles.push(filePath);
          }
        }
      }

      // Detect removed files
      for (const cachedRel of cachedFileSet) {
        if (!currentFileSet.has(cachedRel)) {
          removedFiles.push(cachedRel);
        }
      }

      // If >50% files changed, fall back to full rebuild (not worth incremental overhead)
      const changeRatio = changedFiles.length / Math.max(files.length, 1);
      if (changeRatio > 0.5) {
        console.log(`[CodeGraph] 📊 ${changedFiles.length}/${files.length} files changed (${(changeRatio * 100).toFixed(0)}%) – full rebuild is more efficient`);
        cache = null; // Force full rebuild path
        changedFiles = [];
        removedFiles = [];
        unchangedFiles = [];
      } else {
        isIncremental = true;
      }
    }

    if (isIncremental && cache) {
      // ── Incremental path ──────────────────────────────────────────────────
      console.log(`[CodeGraph] 🔄 Incremental build: ${changedFiles.length} changed, ${removedFiles.length} removed, ${unchangedFiles.length} unchanged`);

      // 1. Restore cached symbols, call edges, import edges for unchanged files
      this._restoreFromCache(cache, removedFiles, changedFiles);

      // 2. Single-pass read: extract symbols + imports, cache word tokens for call edges
      // P0: Read each file only ONCE (was: twice). P1: Cache lightweight word tokens
      // instead of full content (~80% less memory than caching raw strings).
      // P1-4: Use async parallel I/O (Promise.all) for changed files too.
      const tokenCache = new Map(); // relPath → Set<string>
      const INC_BATCH = 64;
      for (let bi = 0; bi < changedFiles.length; bi += INC_BATCH) {
        const batch = changedFiles.slice(bi, bi + INC_BATCH);
        const contents = await Promise.all(
          batch.map(fp => fs.promises.readFile(fp, 'utf-8').catch(() => null))
        );
        for (let j = 0; j < batch.length; j++) {
          const content = contents[j];
          if (content === null) continue;
          const filePath = batch[j];
          const relPath = path.relative(this._root, filePath).replace(/\\/g, '/');
          const ext     = path.extname(filePath);
          this._extractSymbols(content, relPath, ext);
          // P1: Strip comments/strings before import extraction to avoid false imports
          const strippedContent = stripCommentsAndStrings(content, ext);
          this._extractImports(strippedContent, relPath, ext);
          // P1: Cache only word tokens (Set<string>) from stripped content – much lighter than full content
          tokenCache.set(relPath, new Set(strippedContent.match(/\b\w+\b/g) || []));
          // P1-5: Record mtime for new/changed files (avoid re-statting in _saveCache)
          try { this._fileMtimes.set(relPath, fs.statSync(filePath).mtimeMs); } catch (_) {}
        }
      }

      // 3. Rebuild call edges using cached word tokens (zero additional I/O)
      for (const filePath of changedFiles) {
        try {
          const relPath = path.relative(this._root, filePath).replace(/\\/g, '/');
          const ext     = path.extname(filePath);
          const tokens  = tokenCache.get(relPath);
          if (tokens) this._extractCallEdges(null, relPath, ext, tokens);
        } catch (err) { console.warn(`[CodeGraph] Incremental call-edge failed for ${filePath}: ${err.message}`); }
      }
      tokenCache.clear(); // Free memory immediately
    } else {
      // ── Full rebuild path (P0+P1+P2+P3 optimised) ─────────────────────────
      console.log(`[CodeGraph] Scanning ${files.length} files (full rebuild)...`);

      const tokenCache = new Map(); // relPath → Set<string>

      if (files.length >= WORKER_FILE_THRESHOLD) {
        // P3: Worker Threads – distribute file reading + regex extraction across
        // multiple CPU cores. Each worker reads a batch of files, extracts symbols,
        // imports, and word tokens, then returns results to the main thread.
        // The main thread integrates results into the shared _symbols/_importEdges maps.
        const numWorkers = Math.min(os.cpus().length, 4); // Cap at 4 to avoid memory contention
        const batchSize = Math.ceil(files.length / numWorkers);
        console.log(`[CodeGraph] 🧵 Using ${numWorkers} worker threads for parallel extraction...`);

        const workerResults = await this._runWorkerPool(files, numWorkers, batchSize);

        // Integrate worker results into main-thread data structures
        for (const result of workerResults) {
          if (result.error) continue; // Skip failed files
          const { relPath, ext, symbols, imports, wordTokens } = result;

          // P0-1/2/3 fix: Workers now extract full symbol info (kind, signature,
          // summary) matching the main-thread _extract*Symbols() logic, so we can
          // directly register them without quality loss.
          for (const sym of symbols) {
            this._addSymbol(sym.kind, sym.name, relPath, sym.line, sym.signature, sym.summary);
          }
          if (imports.length > 0) {
            this._importEdges.set(relPath, imports);
          }
          // Cache word tokens for call-edge Pass 2
          tokenCache.set(relPath, new Set(wordTokens));
          // P1-5: Record mtime (stat here since worker can't communicate it back)
          try { this._fileMtimes.set(relPath, fs.statSync(path.join(this._root, relPath)).mtimeMs); } catch (_) {}
        }
        console.log(`[CodeGraph] 🧵 Worker extraction complete: ${workerResults.length} files processed`);
      } else {
        // P2: Async parallel I/O – read files in batches using Promise.all
        // For projects below WORKER_FILE_THRESHOLD, this is more efficient than
        // spawning worker threads (lower overhead). Batch size of 64 balances
        // throughput vs memory pressure.
        const BATCH_SIZE = 64;

        for (let i = 0; i < files.length; i += BATCH_SIZE) {
          const batch = files.slice(i, i + BATCH_SIZE);
          const contents = await Promise.all(
            batch.map(filePath =>
              fs.promises.readFile(filePath, 'utf-8').catch(() => null)
            )
          );
          for (let j = 0; j < batch.length; j++) {
            const content = contents[j];
            if (content === null) continue; // unreadable file
            const filePath = batch[j];
            const relPath  = path.relative(this._root, filePath).replace(/\\/g, '/');
            const ext      = path.extname(filePath);
            this._extractSymbols(content, relPath, ext);
            // P1: Strip comments/strings before import extraction to avoid false imports
            const strippedContent = stripCommentsAndStrings(content, ext);
            this._extractImports(strippedContent, relPath, ext);
            // P1: Cache lightweight word tokens from stripped content for Pass 2
            tokenCache.set(relPath, new Set(strippedContent.match(/\b\w+\b/g) || []));
            // P1-5: Record mtime during read (avoid re-statting in _saveCache)
            try { this._fileMtimes.set(relPath, fs.statSync(filePath).mtimeMs); } catch (_) {}
          }
        }
      }

      // Pass 2: Build call edges using cached word tokens (zero additional disk I/O)
      for (const filePath of files) {
        const relPath = path.relative(this._root, filePath).replace(/\\/g, '/');
        const ext     = path.extname(filePath);
        const tokens  = tokenCache.get(relPath);
        if (tokens) this._extractCallEdges(null, relPath, ext, tokens);
      }
      tokenCache.clear(); // Free memory immediately
    }

    const edgeCount = [...this._callEdges.values()].reduce((n, v) => n + v.length, 0);
    const modeLabel = isIncremental ? `incremental – ${changedFiles.length} changed` : 'full rebuild';
    console.log(`[CodeGraph] ✅ Built (${modeLabel}): ${this._symbols.size} symbols, ${edgeCount} call edges, ${this._importEdges.size} modules`);

    // P2-1: Tech Profile Fusion – log enrichment when profile is available
    if (this._techProfile) {
      console.log(`[CodeGraph] 🔗 P2-1 Fusion: tech profile "${this._techProfile.name || this._techProfile.id}" active`);
    }

    // P1: Build inverted token index for semantic search
    this._buildTokenIndex();
    // P1-1 fix: invalidate sorted token key cache after index rebuild
    this._sortedTokenKeys = null;

    // Save cache for next incremental build
    this._saveCache(cachePath, files);

    const graphPath = writeOutput ? this._writeOutput() : null;
    if (!writeOutput) {
      console.log(`[CodeGraph] ⏭️  Skipping disk write (writeOutput=false, will be written later)`);
    }
    return {
      symbolCount:  this._symbols.size,
      fileCount:    files.length,
      edgeCount,
      graphPath,
      incremental:  isIncremental,
      changedFiles: isIncremental ? changedFiles.length : files.length,
      patchMode:    false,
    };
  }

  /**
   * Search symbols by name or keyword (case-insensitive substring match).
   * @param {string} query
   * @param {object} [options]
   * @param {string}  [options.kind]    - Filter by SymbolKind
   * @param {string}  [options.file]    - Filter by file path substring
   * @param {number}  [options.limit]   - Max results (default: 20)
   * @returns {SymbolEntry[]}
   */
  search(query, { kind = null, file = null, limit = 20 } = {}) {
    if (this._symbols.size === 0) this._loadFromDisk();
    const q = query.toLowerCase();

    // P1: Ensure inverted token index is built
    if (!this._tokenIndex) this._buildTokenIndex();

    // ── Phase 1: Candidate collection via inverted index (O(tokens) not O(N)) ──
    // Important: tokenize the ORIGINAL query (preserving case) so CamelCase
    // splitting works correctly. E.g. "CodeGraph" → ["code", "graph"] but
    // "codegraph" (lowered) would not split.
    // Filter out common English stop words that pollute code symbol search.
    const STOP_WORDS = new Set([
      'the', 'to', 'an', 'is', 'in', 'it', 'of', 'on', 'at', 'by', 'or', 'as',
      'be', 'if', 'no', 'do', 'so', 'up', 'for', 'and', 'but', 'not', 'can',
      'has', 'had', 'was', 'are', 'its', 'our', 'use', 'how', 'new', 'all',
      'will', 'from', 'with', 'that', 'this', 'they', 'been', 'have', 'when',
      'what', 'some', 'then', 'than', 'into', 'them', 'also', 'make', 'should',
      'would', 'could', 'where', 'which', 'there', 'their', 'about', 'after',
      'before', 'using', 'support', 'refactor', 'implement', 'change', 'update',
    ]);
    const queryTokens = this._tokenizeText(query).filter(t => !STOP_WORDS.has(t));
    const candidateScores = new Map(); // symbolId → score

    // 1a. Direct substring match candidates (high priority)
    for (const sym of this._symbols.values()) {
      if (kind && sym.kind !== kind) continue;
      if (file && !sym.file.includes(file)) continue;

      const nameLower = sym.name.toLowerCase();
      if (nameLower.includes(q) ||
          sym.summary?.toLowerCase().includes(q) ||
          sym.file.toLowerCase().includes(q)) {
        // Score: name match >> summary match >> file-only match
        let score = 100;
        if (nameLower.includes(q)) {
          score = nameLower === q ? 150 : 120;  // exact name > partial name
          // Structural types (class, interface) get a slight boost
          if (sym.kind === 'class' || sym.kind === 'interface') score += 10;
        } else if (sym.summary?.toLowerCase().includes(q)) {
          score = 105;
        }
        // file-only match stays at 100
        candidateScores.set(sym.id, score);
      }
    }

    // 1b. Inverted index lookup (P1 Semantic Search)
    if (queryTokens.length > 0) {
      // Collect candidate symbol IDs from index
      const tokenHits = new Map(); // symbolId → number of matching tokens

      for (const qt of queryTokens) {
        // Exact token match
        const exactHits = this._tokenIndex.get(qt);
        if (exactHits) {
          for (const symId of exactHits) {
            tokenHits.set(symId, (tokenHits.get(symId) || 0) + 2); // exact = weight 2
          }
        }
        // P1-1 fix: Prefix match using sorted token array for O(log N) binary search
        // instead of O(N) full scan of all tokens in the index.
        // For short queries (< 3 chars), skip prefix matching entirely to avoid noise.
        if (qt.length >= 3) {
          // Build sorted token list lazily (cached on the index)
          if (!this._sortedTokenKeys) {
            this._sortedTokenKeys = [...this._tokenIndex.keys()].sort();
          }
          const sortedKeys = this._sortedTokenKeys;
          // Binary search for the first token starting with qt
          let lo = 0, hi = sortedKeys.length - 1;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (sortedKeys[mid] < qt) lo = mid + 1;
            else hi = mid - 1;
          }
          // Scan forward from the insertion point, collecting prefix matches
          for (let k = lo; k < sortedKeys.length; k++) {
            const token = sortedKeys[k];
            if (!token.startsWith(qt) && !qt.startsWith(token)) {
              // Since tokens are sorted, once we pass the prefix range, stop
              if (token > qt + '\uffff') break;
              continue;
            }
            if (token === qt) continue; // already handled as exact match
            const symIds = this._tokenIndex.get(token);
            if (symIds) {
              for (const symId of symIds) {
                tokenHits.set(symId, (tokenHits.get(symId) || 0) + 1); // prefix = weight 1
              }
            }
          }
        }
      }

      // TF-IDF-like scoring: (matched tokens / query tokens) * IDF boost
      // Key insight: tokens matched from symbol NAME should score much higher
      // than tokens matched only from FILE basename.
      const totalSymbols = this._symbols.size || 1;
      for (const [symId, hitCount] of tokenHits) {
        if (candidateScores.has(symId)) continue; // already a direct match
        const sym = this._symbols.get(symId);
        if (!sym) continue;
        if (kind && sym.kind !== kind) continue;
        if (file && !sym.file.includes(file)) continue;

        // Compute how many query tokens match the symbol NAME (vs just file path)
        const nameTokens = this._tokenizeText(sym.name);
        let nameHits = 0;
        for (const qt of queryTokens) {
          if (nameTokens.some(nt => nt === qt || nt.startsWith(qt) || qt.startsWith(nt))) {
            nameHits++;
          }
        }
        // Name-match boost: 3x for name tokens vs file-only tokens
        const nameRatio = nameHits / queryTokens.length;
        const nameBoost = nameRatio * 3; // 0-3 range

        // Score = (matched token weight / max possible weight) * IDF factor
        const maxWeight = queryTokens.length * 2;
        const matchRatio = hitCount / maxWeight;

        // IDF boost: rare symbols score higher (log(N / docFreq))
        const symTokens = this._tokenizeText(sym.name);
        let idfSum = 0;
        for (const st of symTokens) {
          const docFreq = this._tokenIndex.get(st)?.size || 1;
          idfSum += Math.log(totalSymbols / docFreq);
        }
        const idfFactor = Math.min(idfSum / (symTokens.length || 1), 5); // cap at 5

        const score = matchRatio * (1 + idfFactor * 0.2 + nameBoost);
        // Kind boost: classes/interfaces are usually what users search for
        const kindBoost = (sym.kind === 'class' || sym.kind === 'interface') ? 1.2 : 1.0;

        // Require at least 25% of query tokens to match
        if (matchRatio >= 0.25) {
          const finalScore = score * kindBoost * 10;
          // Cap at 99 for file-only matches, but allow up to 115 for name matches
          const cap = nameHits > 0 ? 115 : 99;
          candidateScores.set(symId, Math.min(finalScore, cap));
        }
      }
    }

    // ── Phase 2: Fuzzy match fallback (edit distance) ──
    // Only if we don't have enough results from index
    if (candidateScores.size < limit && q.length >= 3) {
      for (const sym of this._symbols.values()) {
        if (candidateScores.has(sym.id)) continue;
        if (kind && sym.kind !== kind) continue;
        if (file && !sym.file.includes(file)) continue;

        const nameLower = sym.name.toLowerCase();
        // Simple Levenshtein-like check: if query is contained in name with at most 2 char diff
        const dist = this._editDistancePrefix(q, nameLower);
        if (dist <= 2 && dist < q.length * 0.4) {
          candidateScores.set(sym.id, Math.max(1, 5 - dist));
        }
        if (candidateScores.size >= limit * 3) break; // enough candidates
      }
    }

    // ── Phase 3: Apply importance weight boost and sort ──
    // P0: Symbols with higher cross-file reference counts get a boost.
    // This ensures widely-used "foundation" classes rank above obscure leaves.
    const weights = this._computeImportanceWeights();
    const results = [...candidateScores.entries()]
      .map(([id, score]) => {
        const sym = this._symbols.get(id);
        // Importance boost: up to +20% for the most important symbols
        const importanceBoost = 1 + (weights.get(id) || 0) * 0.2;
        return { sym, score: score * importanceBoost };
      })
      .filter(r => r.sym)
      .sort((a, b) => b.score - a.score);

    // P2: Auto-enrich returned symbols so all consumers get complete data
    // (signature, _extends, _inferredSummary, etc.) without needing to
    // call _enrichSymbol() themselves — eliminates the implicit contract.
    const final = results.slice(0, limit).map(r => r.sym);
    for (const sym of final) {
      this._enrichSymbol(sym);
    }
    return final;
  }

  /**
   * Get all symbols defined in a specific file.
   * @param {string} filePath - Relative file path (substring match)
   * @returns {SymbolEntry[]}
   */
  getFileSymbols(filePath) {
    return [...this._symbols.values()].filter(s => s.file.includes(filePath));
  }

  /**
   * Get the call graph for a symbol (who it calls + who calls it).
   * @param {string} symbolName
   * @returns {{ calls: string[], calledBy: string[] }}
   */
  getCallGraph(symbolName) {
    const sym = this._findByName(symbolName);
    if (!sym) return { calls: [], calledBy: [] };

    const calls = this._callEdges.get(sym.id) || [];
    const calledBy = [];
    for (const [callerId, callees] of this._callEdges) {
      if (callees.includes(sym.id)) calledBy.push(callerId);
    }
    return { calls, calledBy };
  }


  // ─── P1-1: Analysis extracted to code-graph-analysis.js ──────────────────
  // _buildCalledByIndex, _computeImportanceWeights, getImportanceWeight,
  // classifySymbol, getHotspots, getCategoryStats, getReusableSymbolsDigest,
  // hotspotsAsMarkdown → CodeGraphAnalysisMixin.

  // ─── Common name filter (for hotspot noise reduction) ────────────────────────
  // Names that are too short or too common in any language are likely noise
  // in static call-edge analysis (e.g. 'log', 'get', 'set', 'has').
  // They produce artificially inflated calledBy counts. We exclude them from
  // hotspot analysis but still keep them in the call graph for /graph calls.
  static NOISY_SYMBOL_NAMES = new Set([
    // JS/TS built-ins & common patterns
    'log', 'warn', 'error', 'info', 'debug', 'trace',
    'get', 'set', 'has', 'delete', 'clear', 'add', 'remove',
    'push', 'pop', 'shift', 'map', 'filter', 'reduce', 'find', 'some', 'every',
    'keys', 'values', 'entries', 'forEach', 'includes', 'indexOf',
    'test', 'match', 'replace', 'split', 'join', 'trim', 'slice', 'concat',
    'then', 'catch', 'finally', 'resolve', 'reject',
    'emit', 'on', 'off', 'once', 'next',
    'toString', 'valueOf', 'constructor',
    'require', 'import', 'export',
    'call', 'apply', 'bind',
    'read', 'write', 'close', 'open',
    'file', 'path', 'name', 'type', 'data', 'value', 'key', 'id',
    'start', 'stop', 'run', 'end', 'init', 'reset',
    // C# / Unity common
    'Update', 'Start', 'Awake', 'OnDestroy', 'OnEnable', 'OnDisable',
    'GetComponent', 'AddComponent', 'SetActive',
    // Lua common
    'print', 'pairs', 'ipairs', 'tostring', 'tonumber',
    // Python common
    'len', 'str', 'int', 'float', 'list', 'dict', 'range', 'print',
    'append', 'extend', 'insert', 'update',
    // Go common
    'Println', 'Printf', 'Sprintf', 'Error', 'New',
    // Generic variable-like names that cause false positives in static analysis
    // (these names appear in so many files they produce noise, not signal)
    'result', 'results', 'query', 'config', 'options', 'params', 'args',
    'item', 'items', 'list', 'count', 'index', 'status', 'state', 'event',
    'callback', 'handler', 'listener', 'context', 'response', 'request',
    'message', 'content', 'body', 'header', 'title', 'label', 'text',
    'source', 'target', 'input', 'output', 'format', 'parse', 'render',
    'load', 'save', 'create', 'build', 'check', 'validate', 'process',
    'handle', 'execute', 'trigger', 'dispatch', 'notify', 'send', 'receive',
    'success', 'failed', 'error', 'done', 'complete', 'pending', 'active',
    'enabled', 'disabled', 'visible', 'hidden', 'selected', 'focused',
    'parent', 'child', 'children', 'root', 'node', 'element', 'component',
    'width', 'height', 'size', 'length', 'offset', 'position', 'rect',
    'color', 'image', 'icon', 'font', 'style', 'theme', 'layout',
    'summary', 'report', 'prompt', 'files', 'passed', 'review', 'entries',
    // Common variable/property names that get false-positive matches
    'failures', 'passes', 'steps', 'names', 'score', 'scores', 'tasks',
    'changes', 'errors', 'warnings', 'messages', 'records', 'modules',
    'deps', 'imports', 'exports', 'lines', 'tokens', 'chars', 'words',
    'agent', 'stage', 'phase', 'round', 'cycle', 'loop', 'batch',
    'cache', 'store', 'queue', 'stack', 'pool', 'buffer',
    'schema', 'model', 'entity', 'record',
    'prefix', 'suffix', 'pattern', 'regex', 'template',
    'resolve', 'reject', 'promise', 'async', 'await',
    'before', 'after', 'setup', 'cleanup', 'teardown', 'dispose',
  ]);

  /**
   * Check if a symbol name is too generic/noisy for meaningful hotspot analysis.
   * @param {string} name
   * @returns {boolean}
   */
  static isNoisyName(name) {
    // Strip class/module prefix for Lua-style names (e.g. 'Foo:Bar' → 'Bar')
    const baseName = name.includes(':') ? name.split(':').pop() : name;
    // Names shorter than 4 chars are almost always noise
    if (baseName.length <= 3) return true;
    return CodeGraph.NOISY_SYMBOL_NAMES.has(baseName);
  }

  /**
   * Query a symbol by exact or partial name from the in-memory index.
   * If the index is empty (graph not yet built in this process), attempts to
   * load from the persisted code-graph.json file.
   *
   * @param {string} symbolName - Symbol name to look up (case-insensitive)
   * @param {object} [options]
   * @param {boolean} [options.includeCallGraph] - Include caller/callee info (default: true)
   * @param {boolean} [options.includeFileSymbols] - Include all symbols from same file (default: false)
   * @returns {{ symbol: SymbolEntry|null, calls: string[], calledBy: string[], fileSymbols: SymbolEntry[] }|null}
   */
  querySymbol(symbolName, { includeCallGraph = true, includeFileSymbols = false } = {}) {
    // Auto-load from disk if in-memory index is empty
    if (this._symbols.size === 0) {
      this._loadFromDisk();
    }
    if (this._symbols.size === 0) return null;

    const sym = this._findByName(symbolName);
    if (!sym) {
      // Try case-insensitive partial match
      const lower = symbolName.toLowerCase();
      for (const s of this._symbols.values()) {
        if (s.name.toLowerCase().includes(lower)) {
          return this._buildQueryResult(s, includeCallGraph, includeFileSymbols);
        }
      }
      return null;
    }
    return this._buildQueryResult(sym, includeCallGraph, includeFileSymbols);
  }

  /**
   * Query multiple symbols at once. Returns compact Markdown suitable for
   * injection into a Developer agent prompt.
   *
   * @param {string[]} symbolNames
   * @returns {string} Markdown block with symbol details
   */
  querySymbolsAsMarkdown(symbolNames) {
    if (this._symbols.size === 0) this._loadFromDisk();
    if (this._symbols.size === 0) return '_Code graph not available._';

    const lines = ['## 🔍 Code Graph: Symbol Lookup', ''];
    let found = 0;
    for (const name of symbolNames) {
      const result = this.querySymbol(name, { includeCallGraph: true, includeFileSymbols: false });
      if (!result || !result.symbol) {
        lines.push(`- **${name}**: _not found in index_`);
        continue;
      }
      const s = result.symbol;
      found++;
      lines.push(`### \`${s.kind}\` ${s.name}`);
      lines.push(`- **File**: \`${s.file}\` (line ${s.line})`);
      if (s.signature) lines.push(`- **Signature**: \`${s.signature}\``);
      if (s._constructorSignature) lines.push(`- **Constructor**: \`${s._constructorSignature}\``);
      if (s.summary)   lines.push(`- **Summary**: ${s.summary}`);

      // P1: LSP compiler-accurate type info (when available)
      if (result.lspTypeInfo) {
        lines.push(`- **Type (LSP)**: \`${result.lspTypeInfo}\``);
      }
      if (result.lspSignature && !s.signature) {
        lines.push(`- **Signature (LSP)**: \`${result.lspSignature}\``);
      }
      if (result.lspSummary && !s.summary) {
        lines.push(`- **Summary (LSP)**: ${result.lspSummary}`);
      }
      if (result.inferredSummary && !s.summary) {
        lines.push(`- **Inferred**: ${result.inferredSummary}`);
      }
      // P0: Show importance weight for high-importance symbols
      if (result.importanceWeight > 0.3) {
        const pct = Math.round(result.importanceWeight * 100);
        lines.push(`- **Importance**: ${pct}% (widely referenced across codebase)`);
      }

      // P0: Show inheritance chain
      if (result.extends && result.extends.length > 0) {
        lines.push(`- **Extends**: ${result.extends.map(e => `\`${e}\``).join(', ')}`);
      }

      // P0: Show class members summary (fields + methods)
      if (result.fields && result.fields.length > 0) {
        lines.push(`- **Fields**: ${result.fields.map(f => `\`${f}\``).join(', ')}`);
      }
      if (result.methods && result.methods.length > 0) {
        lines.push(`- **Methods**: ${result.methods.map(m => `\`${m}\``).join(', ')}`);
      }

      // Call graph
      if (result.calls.length > 0) {
        lines.push(`- **Calls**: ${result.calls.slice(0, 5).map(id => `\`${id.split('::')[1] || id}\``).join(', ')}`);
      }
      if (result.calledBy.length > 0) {
        lines.push(`- **Called by**: ${result.calledBy.slice(0, 5).map(id => `\`${id.split('::')[1] || id}\``).join(', ')}`);
      }

      // P0: Show sibling symbols in same file
      if (result.siblings && result.siblings.length > 0) {
        const sibStr = result.siblings.slice(0, 8)
          .map(sib => `\`${sib.kind === 'class' ? '📦' : '⚙️'} ${sib.name}\``)
          .join(', ');
        const moreCount = result.siblings.length > 8 ? ` (+${result.siblings.length - 8} more)` : '';
        lines.push(`- **Same file**: ${sibStr}${moreCount}`);
      }

      // P0: Show module cluster (import relationships)
      if (result.moduleCluster && result.moduleCluster.length > 0) {
        const imports = result.moduleCluster.filter(m => m.relation === 'imports');
        const importedBy = result.moduleCluster.filter(m => m.relation === 'imported-by');
        if (imports.length > 0) {
          lines.push(`- **Imports**: ${imports.slice(0, 3).map(m => `\`${m.file}\``).join(', ')}`);
        }
        if (importedBy.length > 0) {
          lines.push(`- **Imported by**: ${importedBy.slice(0, 3).map(m => `\`${m.file}\``).join(', ')}`);
        }
      }

      lines.push('');
    }
    if (found === 0) return '_No matching symbols found in code graph._';
    return lines.join('\n');
  }
  // ─── P1-1: _loadFromDisk / _scheduleFormatUpgrade → code-graph-cache.js ──

  /**
   * Builds the query result object for a found symbol.
   * @private
   */
  _buildQueryResult(sym, includeCallGraph, includeFileSymbols) {
    // P0: Lazy enrichment – fill missing signature/summary/inheritance on demand
    this._enrichSymbol(sym);

    // P1: LSP on-demand enrichment (async, best-effort, non-blocking)
    // We fire-and-forget the LSP request; if an LSP adapter is available,
    // the result is cached for subsequent calls. The first call may not
    // have LSP data, but follow-up calls will benefit.
    if (this._lspAdapter && this._lspAdapter.isConnected && !this._lspCache.has(sym.id)) {
      this._lspEnrichSymbol(sym).catch(() => {}); // fire-and-forget
    }

    // Apply cached LSP enrichment (if available from a previous call)
    const lspData = this._lspCache.get(sym.id);

    const calls    = includeCallGraph ? (this._callEdges.get(sym.id) || []) : [];
    const calledBy = includeCallGraph ? (() => {
      const cb = [];
      for (const [callerId, callees] of this._callEdges) {
        if (callees.includes(sym.id)) cb.push(callerId);
      }
      return cb;
    })() : [];
    const fileSymbols = includeFileSymbols ? this.getFileSymbols(sym.file) : [];

    // P0: Context expansion – provide richer neighbourhood info
    // 1. Sibling symbols in same file (always included, lightweight)
    const siblings = this.getFileSymbols(sym.file)
      .filter(s => s.id !== sym.id)
      .map(s => ({ name: s.name, kind: s.kind, line: s.line }))
      .slice(0, 15);

    // 2. Module cluster: files that import this file or that this file imports
    const moduleCluster = [];
    const symFileImports = this._importEdges.get(sym.file) || [];
    for (const imp of symFileImports.slice(0, 5)) {
      moduleCluster.push({ file: imp, relation: 'imports' });
    }
    for (const [importerFile, imports] of this._importEdges) {
      if (imports.includes(sym.file)) {
        moduleCluster.push({ file: importerFile, relation: 'imported-by' });
        if (moduleCluster.length >= 10) break;
      }
    }

    return {
      symbol: sym,
      calls,
      calledBy,
      fileSymbols,
      // P0 context expansion fields
      siblings,
      moduleCluster,
      extends: sym._extends || [],
      fields: sym._fields || [],
      methods: sym._methods || [],
      inferredSummary: sym._inferredSummary || '',
      // P1 LSP enrichment fields (null when LSP not available)
      lspTypeInfo: lspData?.typeInfo || null,
      lspSignature: lspData?.signature || null,
      lspSummary: lspData?.summary || null,
      // P0: Symbol importance weight (normalised 0-1)
      importanceWeight: this.getImportanceWeight(sym.id),
    };
  }

  // ─── P2-1: Code Graph ↔ Project Profiler Fusion ───────────────────────────

  /**
   * Inject or update the tech profile at runtime (after construction).
   * Useful when the profiler runs AFTER the code graph is instantiated.
   *
   * @param {object} profile - Tech profile object from ProjectProfiler or detectTechStack()
   */
  setTechProfile(profile) {
    this._techProfile = profile || null;
  }

  /**
   * Returns structured statistics from the code graph for consumption by
   * ProjectProfiler, providing evidence-based signals for architecture inference.
   *
   * This is the "graph → profiler" fusion direction:
   *   - Language distribution (actual file/symbol counts, not just extension detection)
   *   - Symbol kind breakdown (classes vs functions vs interfaces)
   *   - Module coupling metrics (import density, fan-in/fan-out)
   *   - Framework indicators (symbols with names matching common framework patterns)
   *
   * @returns {object} Structured stats for profiler consumption
   */
  getCodeGraphStats() {
    if (this._symbols.size === 0) this._loadFromDisk();
    if (this._symbols.size === 0) return null;

    // Language distribution (by extension)
    const langDist = {};
    const fileLangs = {};
    for (const sym of this._symbols.values()) {
      const ext = path.extname(sym.file) || 'unknown';
      langDist[ext] = (langDist[ext] || 0) + 1;
      fileLangs[sym.file] = ext;
    }

    // Symbol kind breakdown
    const kindBreakdown = {};
    for (const sym of this._symbols.values()) {
      kindBreakdown[sym.kind] = (kindBreakdown[sym.kind] || 0) + 1;
    }

    // Module metrics (import density)
    const fileCount = new Set([...this._symbols.values()].map(s => s.file)).size;
    const importCount = [...this._importEdges.values()].reduce((n, v) => n + v.length, 0);
    const avgImportsPerFile = fileCount > 0 ? (importCount / fileCount).toFixed(1) : 0;

    // Framework indicators: detect common patterns in symbol names
    const frameworkIndicators = [];
    const patterns = {
      'express/koa':     /^(app|router|middleware)\./i,
      'react':           /^(use[A-Z]|render|Component|Provider)/,
      'angular':         /(Component|Service|Module|Directive|Pipe)$/,
      'spring':          /(Controller|Service|Repository|Entity|Config)$/,
      'django':          /^(views?|models?|serializers?|urls?)\./,
      'flutter':         /(Widget|State|Provider|Bloc|Cubit)$/,
      'unity':           /(MonoBehaviour|ScriptableObject|Component)$/,
    };
    for (const [framework, pattern] of Object.entries(patterns)) {
      let matchCount = 0;
      for (const sym of this._symbols.values()) {
        if (pattern.test(sym.name)) matchCount++;
      }
      if (matchCount >= 3) {
        frameworkIndicators.push({ framework, matchCount });
      }
    }
    frameworkIndicators.sort((a, b) => b.matchCount - a.matchCount);

    return {
      symbolCount: this._symbols.size,
      fileCount,
      edgeCount: [...this._callEdges.values()].reduce((n, v) => n + v.length, 0),
      importCount,
      avgImportsPerFile: Number(avgImportsPerFile),
      languageDistribution: langDist,
      kindBreakdown,
      frameworkIndicators,
      // Top 5 most-connected modules (highest import fan-in)
      topModules: this._getTopModulesByFanIn(5),
    };
  }

  /**
   * @private
   * @param {number} topN
   */
  _getTopModulesByFanIn(topN) {
    const fanIn = {};
    for (const imports of this._importEdges.values()) {
      for (const imp of imports) {
        fanIn[imp] = (fanIn[imp] || 0) + 1;
      }
    }
    return Object.entries(fanIn)
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([file, count]) => ({ file, importedBy: count }));
  }

  /**
   * Returns a compact Markdown summary suitable for AGENTS.md injection.
   * Includes hotspot analysis and reusable symbol recommendations.
   * @param {object} [options]
   * @param {number}  [options.maxSymbols] - Max symbols to include (default: 100)
   * @returns {string}
   */
  toMarkdown({ maxSymbols = 100 } = {}) {
    const syms = [...this._symbols.values()].slice(0, maxSymbols);
    if (syms.length === 0) return '## Code Graph\n\n_No symbols found._\n';

    // Group by file
    const byFile = new Map();
    for (const s of syms) {
      if (!byFile.has(s.file)) byFile.set(s.file, []);
      byFile.get(s.file).push(s);
    }

    const lines = [
      `## Code Graph (${this._symbols.size} symbols, ${[...this._callEdges.values()].reduce((n,v)=>n+v.length,0)} call edges)`,
      '',
      `> Generated: ${new Date().toISOString().slice(0, 10)}`,
      `> Query: \`/graph search <keyword>\` | \`/graph file <path>\` | \`/graph calls <symbol>\` | \`/graph hotspot [N]\``,
      '',
    ];

    // ── Hotspot Analysis Section ──────────────────────────────────────────
    const hotspots = this.getHotspots({ topN: 15 });
    if (hotspots.length > 0) {
      const categoryEmoji = { utility: '🔧', foundation: '🏗️', hub: '🔀', entry: '🚪', leaf: '🍃' };
      const categoryLabel = { utility: 'Utility', foundation: 'Foundation', hub: 'Hub', entry: 'Entry', leaf: 'Leaf' };

      lines.push('### 🔥 Hotspot Analysis (Top referenced symbols)');
      lines.push('');

      // Category stats
      const stats = this.getCategoryStats();
      lines.push(`> Categories: 🔧 Utility(${stats.utility}) | 🏗️ Foundation(${stats.foundation}) | 🔀 Hub(${stats.hub}) | 🚪 Entry(${stats.entry}) | 🍃 Leaf(${stats.leaf}) | 👻 Orphan(${stats.orphan})`);
      lines.push('');

      for (const h of hotspots) {
        const s = h.symbol;
        const emoji = categoryEmoji[h.category] || '📦';
        const label = categoryLabel[h.category] || h.category;
        const sig = s.signature ? `(${s.signature})` : '';
        const summary = s.summary ? ` // ${s.summary.slice(0, 50)}` : '';
        lines.push(`- ${emoji} **${s.name}**${sig} \`[${label}]\` ← ${h.calledByCount} refs, → ${h.callsOutCount} calls | \`${s.file}\`:${s.line}${summary}`);
      }
      lines.push('');

      // Reusable symbols recommendation (compact)
      const reusable = hotspots.filter(h =>
        h.calledByCount >= 3 &&
        ['utility', 'foundation', 'hub'].includes(h.category)
      ).slice(0, 10);
      if (reusable.length > 0) {
        lines.push('### ♻️ Recommended for Reuse');
        lines.push('');
        lines.push('> **When writing new code, prefer reusing these widely-used symbols over creating new ones.**');
        lines.push('');
        for (const h of reusable) {
          const s = h.symbol;
          lines.push(`- **${s.name}** (${h.calledByCount} refs) in \`${s.file}\`:${s.line}${s.summary ? ` – ${s.summary.slice(0, 50)}` : ''}`);
        }
        lines.push('');
      }

      // Orphan warnings (potential dead code)
      // Get actual orphan count from a broader scan (excluding noisy names)
      const allOrphans = [];
      const calledByIdx = this._buildCalledByIndex();
      for (const sym of this._symbols.values()) {
        if (CodeGraph.isNoisyName(sym.name)) continue;
        const cb = calledByIdx.get(sym.id) || { count: 0 };
        const co = (this._callEdges.get(sym.id) || []).length;
        if (cb.count === 0 && co === 0) allOrphans.push(sym);
      }
      if (allOrphans.length > 0) {
        lines.push(`### 👻 Potential Dead Code (${allOrphans.length} orphan symbols)`);
        lines.push('');
        lines.push('> These symbols have 0 incoming references AND 0 outgoing calls. They may be unused.');
        lines.push('');
        for (const s of allOrphans.slice(0, 8)) {
          lines.push(`- \`${s.kind}\` **${s.name}** in \`${s.file}\`:${s.line}`);
        }
        if (allOrphans.length > 8) lines.push(`- ... and ${allOrphans.length - 8} more`);
        lines.push('');
      }
    }

    // ── P2: Module Directory Summaries (aggregated by directory) ───────────
    // Note: use ALL symbols for module stats (not the maxSymbols-capped byFile)
    const dirStats = new Map(); // dirPath → { files, classes, functions, topSymbols }
    const dirFiles = new Map(); // dirPath → Set<filePath>
    for (const sym of this._symbols.values()) {
      const dir = path.dirname(sym.file) || '.';
      if (!dirStats.has(dir)) {
        dirStats.set(dir, { files: 0, classes: 0, functions: 0, methods: 0, topSymbols: [] });
        dirFiles.set(dir, new Set());
      }
      const ds = dirStats.get(dir);
      const df = dirFiles.get(dir);
      df.add(sym.file);
      ds.files = df.size;
      if (sym.kind === 'class' || sym.kind === 'interface') ds.classes++;
      else if (sym.kind === 'function') ds.functions++;
      else if (sym.kind === 'method') ds.methods++;
      // Collect class/function summaries (not noisy lambda names) for module description
      if (sym.summary && ds.topSymbols.length < 3 &&
          !CodeGraph.isNoisyName(sym.name) && sym.name.length > 4 &&
          (sym.kind === 'class' || sym.kind === 'function') &&
          sym.summary.length > 10 && /^[A-Z]/.test(sym.summary) &&
          !sym.summary.includes('`') && !sym.summary.includes('::')) {
        ds.topSymbols.push(sym.summary.slice(0, 50));
      }
    }

    if (dirStats.size > 1) {
      lines.push('### 📦 Module Summary (by directory)');
      lines.push('');
      lines.push('| Module | Files | Classes | Functions | Description |');
      lines.push('|--------|-------|---------|-----------|-------------|');
      // Sort by number of symbols descending
      const sorted = [...dirStats.entries()]
        .sort((a, b) => (b[1].classes + b[1].functions + b[1].methods) - (a[1].classes + a[1].functions + a[1].methods));
      for (const [dir, ds] of sorted.slice(0, 20)) {
        // Primary: infer from directory name (clean, consistent labels)
        // Supplementary: use topSymbols summaries if directory name is too generic
        const inferred = _inferModuleDescription(dir);
        const isGenericInferred = ['Root module', dir.split('/').pop()].some(g =>
          inferred.toLowerCase() === g.toLowerCase());
        const desc = (isGenericInferred && ds.topSymbols.length > 0)
          ? ds.topSymbols[0].slice(0, 50)
          : inferred;
        lines.push(`| \`${dir}\` | ${ds.files} | ${ds.classes} | ${ds.functions + ds.methods} | ${desc} |`);
      }
      if (sorted.length > 20) lines.push(`| ... | +${sorted.length - 20} more modules | | | |`);
      lines.push('');
    }

    // ── Per-file symbol listing ─────────────────────────────────────────
    lines.push('### 📁 Symbol Index (by file)');    lines.push('');
    for (const [file, symbols] of byFile) {
      lines.push(`#### ${file}`);
      for (const s of symbols) {
        const callCount = (this._callEdges.get(s.id) || []).length;
        const callInfo  = callCount > 0 ? ` → ${callCount} call(s)` : '';
        const summary   = s.summary ? ` // ${s.summary.slice(0, 60)}` : '';
        lines.push(`- \`${s.kind}\` **${s.name}**${s.signature ? `(${s.signature})` : ''}${callInfo}${summary}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Returns a compact module-level summary of the codebase as Markdown.
   *
   * P0-1: This is designed as "seed information" for the AnalystAgent's Module Map
   * generation. Instead of letting the LLM guess module boundaries from scratch,
   * this provides real directory-level structure data from the code graph:
   *   - Directory paths (potential module boundaries)
   *   - File counts, class counts, function counts per directory
   *   - Inferred descriptions based on directory names and top symbol summaries
   *   - Import relationships between directories (cross-module dependencies)
   *
   * The output is intentionally compact (target: <2000 chars) to fit within the
   * analyst's context window without crowding out the user's actual requirement.
   *
   * @param {object} [opts]
   * @param {number} [opts.maxDirs=15] - Maximum directories to include
   * @returns {string} Markdown string, or empty string if code graph is not available
   */
  getModuleSummaryMarkdown({ maxDirs = 15 } = {}) {
    if (this._symbols.size === 0) this._loadFromDisk();
    if (this._symbols.size === 0) return '';

    // ── Aggregate stats by directory ──────────────────────────────────────
    const dirStats = new Map();  // dirPath → { files, classes, functions, methods, topSymbols }
    const dirFiles = new Map();  // dirPath → Set<filePath>

    for (const sym of this._symbols.values()) {
      const dir = path.dirname(sym.file) || '.';
      if (!dirStats.has(dir)) {
        dirStats.set(dir, { files: 0, classes: 0, functions: 0, methods: 0, topSymbols: [] });
        dirFiles.set(dir, new Set());
      }
      const ds = dirStats.get(dir);
      const df = dirFiles.get(dir);
      df.add(sym.file);
      ds.files = df.size;
      if (sym.kind === 'class' || sym.kind === 'interface') ds.classes++;
      else if (sym.kind === 'function') ds.functions++;
      else if (sym.kind === 'method') ds.methods++;
      if (sym.summary && ds.topSymbols.length < 3 &&
          !CodeGraph.isNoisyName(sym.name) && sym.name.length > 4 &&
          (sym.kind === 'class' || sym.kind === 'function') &&
          sym.summary.length > 10 && /^[A-Z]/.test(sym.summary) &&
          !sym.summary.includes('`') && !sym.summary.includes('::')) {
        ds.topSymbols.push(sym.summary.slice(0, 50));
      }
    }

    if (dirStats.size <= 1) return '';

    // ── Build cross-directory import edges ────────────────────────────────
    const dirImports = new Map(); // dirA → Set<dirB> (dirA imports from dirB)
    for (const [filePath, importedFiles] of this._importEdges.entries()) {
      const srcDir = path.dirname(filePath) || '.';
      for (const imp of importedFiles) {
        const tgtDir = path.dirname(imp) || '.';
        if (srcDir !== tgtDir && dirStats.has(srcDir) && dirStats.has(tgtDir)) {
          if (!dirImports.has(srcDir)) dirImports.set(srcDir, new Set());
          dirImports.get(srcDir).add(tgtDir);
        }
      }
    }

    // ── Sort by symbol count descending, cap at maxDirs ──────────────────
    const sorted = [...dirStats.entries()]
      .sort((a, b) => (b[1].classes + b[1].functions + b[1].methods) - (a[1].classes + a[1].functions + a[1].methods))
      .slice(0, maxDirs);

    const lines = [
      `## 📦 Codebase Module Structure (from Code Graph)`,
      `> This is the actual directory-level structure of the codebase. Use this as seed information when generating the Functional Module Map.`,
      ``,
      `| Directory | Files | Classes | Functions | Description |`,
      `|-----------|-------|---------|-----------|-------------|`,
    ];

    for (const [dir, ds] of sorted) {
      const inferred = _inferModuleDescription(dir);
      const isGenericInferred = ['Root module', dir.split('/').pop()].some(g =>
        inferred.toLowerCase() === g.toLowerCase());
      const desc = (isGenericInferred && ds.topSymbols.length > 0)
        ? ds.topSymbols[0].slice(0, 50)
        : inferred;
      lines.push(`| \`${dir}\` | ${ds.files} | ${ds.classes} | ${ds.functions + ds.methods} | ${desc} |`);
    }

    // ── Cross-directory dependencies ─────────────────────────────────────
    const depLines = [];
    const sortedDirs = new Set(sorted.map(([d]) => d));
    for (const [srcDir, tgtDirs] of dirImports.entries()) {
      if (!sortedDirs.has(srcDir)) continue;
      const relevantTargets = [...tgtDirs].filter(d => sortedDirs.has(d));
      if (relevantTargets.length > 0) {
        depLines.push(`- \`${srcDir}\` → ${relevantTargets.map(d => `\`${d}\``).join(', ')}`);
      }
    }
    if (depLines.length > 0) {
      lines.push(``);
      lines.push(`### Cross-Directory Dependencies`);
      lines.push(...depLines.slice(0, 15));
    }

    lines.push(``);
    return lines.join('\n');
  }

  // ─── Symbol Extraction ────────────────────────────────────────────────────
  // P2-A: These methods have been extracted to code-graph-parsers.js
  // and are mixed in via Object.assign at the bottom of this file.
  // Extracted methods:
  //   _extractSymbols, _addSymbol,
  //   _extractJsSymbols, _extractCsSymbols, _extractLuaSymbols,
  //   _extractGoSymbols, _extractPySymbols, _extractDartSymbols,
  //   _extractJsDocSummary, _extractXmlDocSummary, _extractLuaCommentSummary,
  //   _extractGoDocSummary, _extractPyDocSummary, _extractDartDocSummary,
  //   _extractImports, _extractCallEdges
  // ─────────────────────────────────────────────────────────────────────────

  // ─── Helpers ──────────────────────────────────────────────────────────────

  // ─── P1-1: Enrichment extracted to code-graph-enrichment.js ──────────────
  // _readSourceLines through _enrichSymbol → CodeGraphEnrichmentMixin.

  _findByName(name) {
    for (const sym of this._symbols.values()) {
      if (sym.name === name) return sym;
    }
    return null;
  }

  // ── P1 Semantic Search Infrastructure ───────────────────────────────────────

  /**
   * Build an inverted token index: lowercase token → Set<symbolId>.
   * Each symbol name is split via CamelCase/snake_case into tokens.
   * Called after _loadFromDisk() and build().
   * Cost: ~5-15ms for 10K symbols (one-time).
   * @private
   */
  _buildTokenIndex() {
    // P1-2: Invalidate analysis caches when token index is rebuilt
    this._calledByIndex = null;
    this._importanceWeights = null;
    const t0 = Date.now();
    this._tokenIndex = new Map();

    for (const sym of this._symbols.values()) {
      // Pass original name (with CamelCase) – _tokenizeText handles lowercasing after split
      const tokens = this._tokenizeText(sym.name);
      for (const token of tokens) {
        let set = this._tokenIndex.get(token);
        if (!set) {
          set = new Set();
          this._tokenIndex.set(token, set);
        }
        set.add(sym.id);
      }

      // Also index the file basename (without extension)
      const baseName = path.basename(sym.file, path.extname(sym.file));
      const fileTokens = this._tokenizeText(baseName);
      for (const token of fileTokens) {
        let set = this._tokenIndex.get(token);
        if (!set) {
          set = new Set();
          this._tokenIndex.set(token, set);
        }
        set.add(sym.id);
      }

      // P1: Also index summary words – enables searching by description
      // e.g. searching "performance monitoring" can match a symbol whose
      // summary says "Initializes performance monitoring subsystem".
      if (sym.summary) {
        const summaryTokens = this._tokenizeText(sym.summary);
        for (const token of summaryTokens) {
          // Skip very common English words that would pollute the index
          if (token.length <= 2) continue;
          let set = this._tokenIndex.get(token);
          if (!set) {
            set = new Set();
            this._tokenIndex.set(token, set);
          }
          set.add(sym.id);
        }
      }
    }

    // Invalidate importance weights when index is rebuilt (data may have changed)
    this._importanceWeights = null;

    console.log(`[CodeGraph] 🔍 Token index built: ${this._tokenIndex.size} unique tokens for ${this._symbols.size} symbols (${Date.now() - t0}ms)`);
  }

  /**
   * Tokenize a string by splitting CamelCase, snake_case, and separators.
   * Returns deduplicated lowercase tokens with length > 1.
   *
   * Examples:
   *   "CSResReportTrackDownload" → ["cs", "res", "report", "track", "download"]
   *   "get_user_profile"        → ["get", "user", "profile"]
   *   "BaseAgent"               → ["base", "agent"]
   *   "_extractCallEdges"       → ["extract", "call", "edges"]
   *
   * @param {string} text - Original text (case-sensitive; will be lowered internally)
   * @returns {string[]}
   * @private
   */
  _tokenizeText(text) {
    return [...new Set(
      text
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')   // camelCase → camel Case
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // ABCDef → ABC Def
        .replace(/[_:.\-\/\\]/g, ' ')               // snake_case, paths
        .toLowerCase()                               // AFTER CamelCase split!
        .split(/\s+/)
        .filter(t => t.length > 1)
    )];
  }

  /**
   * Compute edit distance between query and a prefix of target.
   * Returns the minimum edits needed to match query as a prefix of target.
   * Used for fuzzy search fallback.
   *
   * @param {string} query
   * @param {string} target
   * @returns {number}
   * @private
   */
  _editDistancePrefix(query, target) {
    const m = query.length;
    const n = Math.min(target.length, m + 2); // only check prefix-ish range
    if (m === 0) return 0;
    if (n === 0) return m;

    // Simple Levenshtein with early termination
    const prev = Array.from({ length: n + 1 }, (_, i) => i);
    const curr = new Array(n + 1);

    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      let minInRow = i;
      for (let j = 1; j <= n; j++) {
        const cost = query[i - 1] === target[j - 1] ? 0 : 1;
        curr[j] = Math.min(
          prev[j] + 1,      // deletion
          curr[j - 1] + 1,  // insertion
          prev[j - 1] + cost // substitution
        );
        minInRow = Math.min(minInRow, curr[j]);
      }
      // Early termination: if all values in row exceed threshold, stop
      if (minInRow > 3) return minInRow;
      for (let j = 0; j <= n; j++) prev[j] = curr[j];
    }

    // Return minimum value in last row (prefix distance)
    let min = curr[0];
    for (let j = 1; j <= n; j++) {
      if (curr[j] < min) min = curr[j];
    }
    return min;
  }

  // ── P1 LSP On-Demand Enrichment ─────────────────────────────────────────────

  /**
   * Inject an LSP adapter for query-time on-demand enrichment.
   * When available, querySymbol() will attempt to use LSP hover data
   * to provide compiler-accurate type signatures and documentation.
   *
   * @param {object} adapter - An LSPAdapter instance (must have getHover method)
   */
  setLSPAdapter(adapter) {
    this._lspAdapter = adapter;
    console.log(`[CodeGraph] 🔬 LSP adapter injected – query-time enrichment enabled`);
  }

  /**
   * Attempt LSP-based enrichment for a symbol.
   * Uses the LSP hover request to get compiler-accurate type information.
   * Results are cached in _lspCache (in-memory, per process lifetime).
   *
   * @param {object} sym - Symbol entry
   * @returns {Promise<{signature?: string, summary?: string, typeInfo?: string}|null>}
   * @private
   */
  async _lspEnrichSymbol(sym) {
    if (!this._lspAdapter || !this._lspAdapter.isConnected) return null;

    // Check cache first
    if (this._lspCache.has(sym.id)) return this._lspCache.get(sym.id);

    try {
      const absPath = path.join(this._root, sym.file);
      // LSP hover at the symbol's declaration line, column 0
      const hover = await Promise.race([
        this._lspAdapter.getHover(absPath, sym.line - 1, 0),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
      ]);

      if (!hover || !hover.contents) {
        this._lspCache.set(sym.id, null);
        return null;
      }

      const content = typeof hover.contents === 'string'
        ? hover.contents
        : hover.contents.value || JSON.stringify(hover.contents);

      // Extract type signature from hover content
      // LSP hover typically returns markdown with code blocks
      const codeBlockMatch = content.match(/```\w*\n([\s\S]*?)\n```/);
      const typeInfo = codeBlockMatch ? codeBlockMatch[1].trim() : content.trim();

      // Parse hover for signature and summary
      const result = {
        typeInfo: typeInfo.slice(0, 200),
        signature: null,
        summary: null,
      };

      // Try to extract a cleaner signature from the type info
      const sigMatch = typeInfo.match(/(?:class|function|def|func|type|interface)\s+\w+([^{]+)/);
      if (sigMatch) {
        result.signature = sigMatch[1].trim().slice(0, 120);
      }

      // If hover contains documentation beyond the code block, use it as summary
      const docParts = content.split('---').slice(1);
      if (docParts.length > 0) {
        const docText = docParts.join(' ').replace(/\n/g, ' ').trim();
        if (docText.length > 10) {
          result.summary = docText.slice(0, 120);
        }
      }

      this._lspCache.set(sym.id, result);
      return result;
    } catch (_) {
      // LSP timeout or error – graceful degradation
      this._lspCache.set(sym.id, null);
      return null;
    }
  }

  _findIdByName(name, preferFile = null) {
    // Prefer symbols from the same file
    for (const sym of this._symbols.values()) {
      if (sym.name === name && sym.file === preferFile) return sym.id;
    }
    for (const sym of this._symbols.values()) {
      if (sym.name === name) return sym.id;
    }
    return null;
  }

  _collectFiles(dir) {
    const results = [];
    const walk = (d) => {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;

        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          // Layer 1: Skip user-configured ignore dirs (node_modules, .git, build, dist, etc.)
          if (this._ignoreDirs.has(e.name)) continue;
          // Layer 2: Always skip well-known non-code directories (images, fonts, docs, etc.)
          if (NON_CODE_DIRS.has(e.name.toLowerCase())) continue;
          walk(full);
        } else if (this._extensions.has(path.extname(e.name))) {
          // Layer 3: Only collect files with recognized code extensions
          results.push(full);
        }
      }
    };
    walk(dir);
    return results;
  }

  // ─── P1-1: Incremental Cache → code-graph-cache.js ──

  // ─── Worker Thread Pool (P3) ────────────────────────────────────────────

  /**
   * Distribute file processing across multiple worker threads.
   *
   * Each worker receives a batch of file paths and independently:
   *  1. Reads the file (fs.readFileSync inside the worker)
   *  2. Extracts symbol names + line numbers via regex
   *  3. Extracts import paths via regex
   *  4. Extracts word tokens for call-edge analysis
   *
   * Workers are self-contained (code-graph-worker.js) – they don't share
   * memory with the main thread. Results are serialised and posted back.
   *
   * @param {string[]} files - Absolute file paths to process
   * @param {number} numWorkers - Number of worker threads to spawn
   * @param {number} batchSize - Files per worker
   * @returns {Promise<Array<{relPath, ext, symbols, imports, wordTokens}>>}
   * @private
   */
  _runWorkerPool(files, numWorkers, batchSize) {
    return new Promise((resolve, reject) => {
      const allResults = [];
      const workers = [];  // P1-6: Track worker refs for timeout termination
      let completed = 0;
      let hasError = false;

      for (let i = 0; i < numWorkers; i++) {
        const start = i * batchSize;
        const batch = files.slice(start, start + batchSize);
        if (batch.length === 0) {
          completed++;
          if (completed === numWorkers) resolve(allResults);
          continue;
        }

        const worker = new Worker(WORKER_SCRIPT, {
          workerData: {
            filePaths:   batch,
            projectRoot: this._root,
          },
        });

        worker.on('message', (results) => {
          allResults.push(...results);
        });

        workers.push(worker);  // P1-6: Track for timeout termination

        worker.on('error', (err) => {
          console.warn(`[CodeGraph] 🧵 Worker error (non-fatal): ${err.message}`);
          // Don't reject – partial results are still useful
        });

        worker.on('exit', (code) => {
          completed++;
          if (code !== 0 && !hasError) {
            console.warn(`[CodeGraph] 🧵 Worker exited with code ${code}`);
          }
          if (completed === numWorkers) {
            resolve(allResults);
          }
        });
      }

      // Safety timeout: if workers don't complete within 60s, terminate leaked
      // workers and resolve with partial results. P1-6 fix: without explicit
      // terminate(), timed-out workers would continue running in the background
      // consuming CPU and memory.
      setTimeout(() => {
        if (completed < numWorkers) {
          console.warn(`[CodeGraph] 🧵 Worker pool timeout – terminating ${numWorkers - completed} stuck worker(s), resolving with ${allResults.length} partial results`);
          for (const w of workers) {
            try { w.terminate(); } catch (_) { /* already exited */ }
          }
          resolve(allResults);
        }
      }, 60000);
    });
  }

  // ─── Patch Build (In-Place Update) ──────────────────────────────────────

  /**
   * Perform an in-place patch on the in-memory code graph.
   *
   * Unlike a full incremental build, this does NOT:
   *  - Clear all in-memory data
   *  - Scan the entire directory tree (_collectFiles)
   *  - Read and parse the cache file from disk
   *  - Re-serialize and write the entire cache/output
   *
   * Instead, it:
   *  1. Removes only the symbols/callEdges/importEdges belonging to changed files
   *  2. Re-reads and re-processes only those files
   *  3. Optionally writes output (skipped for intermediate builds)
   *
   * Performance: O(changedFiles) instead of O(totalFiles). For a 3000-file project
   * where Developer changed 3 files, this reduces rebuild from ~10-25s to <0.5s.
   *
   * @param {string[]} relPaths - Relative file paths that changed (forward-slash separated)
   * @param {boolean} writeOutput - Whether to persist to disk
   * @returns {{ symbolCount: number, fileCount: number, edgeCount: number, graphPath: string|null, incremental: boolean, changedFiles: number, patchMode: boolean }}
   * @private
   */
  _patchBuild(relPaths, writeOutput) {
    const t0 = Date.now();
    const patchSet = new Set(relPaths.map(p => p.replace(/\\/g, '/')));

    console.log(`[CodeGraph] ⚡ Patch build: ${patchSet.size} file(s) changed`);

    // Step 1: Evict symbols belonging to changed files
    let evictedSymbols = 0;
    for (const [symId, sym] of this._symbols) {
      if (patchSet.has(sym.file)) {
        this._symbols.delete(symId);
        evictedSymbols++;
      }
    }

    // Step 2: Evict call edges where the caller belongs to a changed file
    let evictedEdges = 0;
    for (const [callerId] of this._callEdges) {
      const callerFile = callerId.split('::')[0];
      if (patchSet.has(callerFile)) {
        this._callEdges.delete(callerId);
        evictedEdges++;
      }
    }

    // Step 3: Evict import edges for changed files
    for (const relPath of patchSet) {
      this._importEdges.delete(relPath);
    }

    console.log(`[CodeGraph]    Evicted: ${evictedSymbols} symbols, ${evictedEdges} call edge entries from ${patchSet.size} file(s)`);

    // Step 4: Single-pass read: extract symbols + imports, cache word tokens
    // P0: Read each changed file only ONCE (was: twice in Step 4 + Step 5).
    // P1: Cache lightweight word tokens for call edge extraction.
    let processedCount = 0;
    const tokenCache = new Map(); // relPath → Set<string>
    for (const relPath of patchSet) {
      const absPath = path.join(this._root, relPath);
      try {
        if (!fs.existsSync(absPath)) {
          // File was deleted – eviction above already removed its data
          continue;
        }
        const content = fs.readFileSync(absPath, 'utf-8');
        const ext = path.extname(absPath);
        this._extractSymbols(content, relPath, ext);
        // P1: Strip comments/strings before import extraction to avoid false imports
        const strippedContent = stripCommentsAndStrings(content, ext);
        this._extractImports(strippedContent, relPath, ext);
        // P1: Cache word tokens from stripped content (Set<string>) – much lighter than full content
        tokenCache.set(relPath, new Set(strippedContent.match(/\b\w+\b/g) || []));
        processedCount++;
      } catch (err) {
        console.warn(`[CodeGraph]    Patch: skipped unreadable file ${relPath}: ${err.message}`);
      }
    }

    // Step 5: Re-build call edges using cached word tokens (zero additional I/O)
    for (const relPath of patchSet) {
      const tokens = tokenCache.get(relPath);
      if (tokens) {
        const ext = path.extname(relPath);
        this._extractCallEdges(null, relPath, ext, tokens);
      }
    }
    tokenCache.clear(); // Free memory immediately

    const edgeCount = [...this._callEdges.values()].reduce((n, v) => n + v.length, 0);
    const elapsed = Date.now() - t0;
    console.log(`[CodeGraph] ⚡ Patch complete in ${elapsed}ms: ${this._symbols.size} symbols, ${edgeCount} call edges (${processedCount} files re-processed)`);

    // P1: Rebuild inverted token index after patching
    this._buildTokenIndex();

    // Step 6: Update cache mtimes for patched files so subsequent quickScan
    // does not re-detect the same files as changed.
    this._patchCacheMtimes(patchSet);

    // Step 7: Optionally write output
    let graphPath = null;
    if (writeOutput) {
      graphPath = this._writeOutput();
    } else {
      console.log(`[CodeGraph] ⏭️  Skipping disk write (writeOutput=false)`);
    }

    return {
      symbolCount:  this._symbols.size,
      fileCount:    processedCount,
      edgeCount,
      graphPath,
      incremental:  true,
      changedFiles: patchSet.size,
      patchMode:    true,
    };
  }

  // ─── Quick mtime Scan ─────────────────────────────────────────────────────

  /**
   * Quickly detect which source files have changed since the last build by
   * comparing file mtimes against the saved cache. This is MUCH faster than
   * a full _collectFiles + stat loop because we only stat files already known
   * in the cache (no directory traversal).
   *
   * For new files not in the cache, we do a lightweight directory scan limited
   * to only the extensions we care about.
   *
   * @param {string} cachePath - Path to .code-graph-cache.json
   * @returns {string[]|null} Array of changed relative paths, or null if cache is invalid
   * @private
   */
  _detectChangedFilesByMtime(cachePath) {
    try {
      if (!fs.existsSync(cachePath)) return null;
      const raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      if (raw.version !== 1 || raw.projectRoot !== this._root) return null;

      const fileMtimes = raw.fileMtimes || {};
      const changed = [];

      // Check existing cached files for mtime changes
      for (const [relPath, cachedMtime] of Object.entries(fileMtimes)) {
        const absPath = path.join(this._root, relPath);
        try {
          const stat = fs.statSync(absPath);
          if (stat.mtimeMs > cachedMtime) {
            changed.push(relPath);
          }
        } catch (_) {
          // File was deleted – treat as changed (eviction will handle it)
          changed.push(relPath);
        }
      }

      // Note: we intentionally skip scanning for brand-new files here.
      // New files will be picked up by the next full build (FINISHED stage).
      // This trade-off keeps quickScan fast: O(cachedFiles × stat) instead of
      // O(directoryTree traversal).

      return changed;
    } catch (err) {
      console.warn(`[CodeGraph] ⚠️  Quick mtime scan failed: ${err.message}`);
      return null;
    }
  }
  // ─── P1-1: _patchCacheMtimes → code-graph-cache.js ──

  // ─── .gitignore Parser ──────────────────────────────────────────────────

  /**
   * Parse .gitignore from project root and extract directory-level ignore patterns.
   * Only extracts simple directory names and directory patterns (ending with /),
   * skipping complex glob patterns to keep implementation lightweight.
   *
   * @param {string} root - Project root directory
   * @returns {string[]} Array of directory names to ignore
   */
  _loadGitignoreDirs(root) {
    const gitignorePath = path.join(root, '.gitignore');
    if (!fs.existsSync(gitignorePath)) return [];

    try {
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      const dirs = [];

      for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        // Skip empty lines, comments, and negation patterns
        if (!line || line.startsWith('#') || line.startsWith('!')) continue;

        // Explicit directory pattern: "dirname/" or "/dirname/"
        if (line.endsWith('/')) {
          const dirName = line.replace(/^\//, '').replace(/\/$/, '');
          // Only take simple single-level directory names (no globs, no nested paths)
          if (dirName && !dirName.includes('/') && !dirName.includes('*') && !dirName.includes('?')) {
            dirs.push(dirName);
          }
          continue;
        }

        // Simple name without wildcards or slashes – could be a directory
        // (e.g. "node_modules", "dist", "__pycache__")
        if (!line.includes('/') && !line.includes('*') && !line.includes('?') && !line.includes('.')) {
          // Heuristic: names without a dot are likely directories, not files
          dirs.push(line);
        }
      }

      return [...new Set(dirs)];
    } catch (_) {
      return [];
    }
  }

  // ─── P1-1: Output Writers → code-graph-cache.js ──
}

// ─── P2-A: Apply Parser Mixin ─────────────────────────────────────────────────
const { CodeGraphParsersMixin, stripCommentsAndStrings } = require('./code-graph-parsers');
Object.assign(CodeGraph.prototype, CodeGraphParsersMixin);

// ─── P1-1: Apply Analysis Mixin ──────────────────────────────────────────────
const { CodeGraphAnalysisMixin } = require('./code-graph-analysis');
Object.assign(CodeGraph.prototype, CodeGraphAnalysisMixin);

// ─── P1-1: Apply Enrichment Mixin ───────────────────────────────────────────
const { CodeGraphEnrichmentMixin } = require('./code-graph-enrichment');
Object.assign(CodeGraph.prototype, CodeGraphEnrichmentMixin);

// ─── P1-1: Apply Cache Mixin ────────────────────────────────────────────────
const { CodeGraphCacheMixin, setProcessCache } = require('./code-graph-cache');
setProcessCache(_processCache);
Object.assign(CodeGraph.prototype, CodeGraphCacheMixin);
module.exports = { CodeGraph, SymbolKind };
