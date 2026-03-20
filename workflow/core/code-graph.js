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

// ─── Symbol Types ─────────────────────────────────────────────────────────────

const SymbolKind = {
  CLASS:     'class',
  FUNCTION:  'function',
  METHOD:    'method',
  MODULE:    'module',
  INTERFACE: 'interface',
  ENUM:      'enum',
  PROPERTY:  'property',
};

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
          this._extractImports(content, relPath, ext);
          // P1: Cache only word tokens (Set<string>) – much lighter than full content
          tokenCache.set(relPath, new Set(content.match(/\b\w+\b/g) || []));
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
            this._extractImports(content, relPath, ext);
            // P1: Cache lightweight word tokens for Pass 2
            tokenCache.set(relPath, new Set(content.match(/\b\w+\b/g) || []));
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

    // P1: Build inverted token index for semantic search
    this._buildTokenIndex();

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
        // Prefix match (for partial tokens like "analys" matching "analyst")
        if (qt.length >= 3) {
          for (const [token, symIds] of this._tokenIndex) {
            if (token !== qt && (token.startsWith(qt) || qt.startsWith(token))) {
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

  // ─── Hotspot Analysis ─────────────────────────────────────────────────────

  /**
   * Build a reverse-index: symbolId → calledBy count + caller list.
   * This is the foundation for all hotspot/reuse analysis.
   * @returns {Map<string, { count: number, callers: string[] }>}
   * @private
   */
  _buildCalledByIndex() {
    /** @type {Map<string, { count: number, callers: string[] }>} */
    const calledByIndex = new Map();
    for (const [callerId, callees] of this._callEdges) {
      for (const calleeId of callees) {
        if (!calledByIndex.has(calleeId)) {
          calledByIndex.set(calleeId, { count: 0, callers: [] });
        }
        const entry = calledByIndex.get(calleeId);
        entry.count++;
        entry.callers.push(callerId);
      }
    }
    return calledByIndex;
  }

  // ── P0 Symbol Importance Weights ────────────────────────────────────────

  /**
   * Compute normalised importance weights for all symbols.
   * Weight combines two signals:
   *   1. Cross-file calledBy count (primary, 70%)
   *   2. Imported-by count for the symbol's file (secondary, 30%)
   *
   * Results are cached in this._importanceWeights (Map<symbolId, number>).
   * Invalidated on build() / _patchBuild().
   *
   * @returns {Map<string, number>} symbolId → normalised weight [0, 1]
   * @private
   */
  _computeImportanceWeights() {
    if (this._importanceWeights) return this._importanceWeights;

    const calledByIndex = this._buildCalledByIndex();

    // Build importedBy index: filePath → number of files that import it
    const importedByCount = new Map();
    for (const [, imports] of this._importEdges) {
      for (const imp of imports) {
        importedByCount.set(imp, (importedByCount.get(imp) || 0) + 1);
      }
    }

    // Compute raw scores (excluding noisy/generic short names that
    // produce artificially inflated cross-file calledBy from regex matching)
    const rawScores = new Map();
    let maxRaw = 0;
    for (const sym of this._symbols.values()) {
      // Skip noisy names – they pollute the weight distribution
      if (CodeGraph.isNoisyName(sym.name)) {
        rawScores.set(sym.id, 0);
        continue;
      }
      const cb = (calledByIndex.get(sym.id) || { count: 0 }).count;
      const ib = importedByCount.get(sym.file) || 0;
      // Cross-file calledBy: count callers from different files
      const crossFileCB = (calledByIndex.get(sym.id) || { callers: [] }).callers
        .filter(callerId => callerId.split('::')[0] !== sym.file).length;
      // Weighted combination: cross-file calledBy (70%) + importedBy (30%)
      const raw = crossFileCB * 0.7 + ib * 0.3;
      rawScores.set(sym.id, raw);
      if (raw > maxRaw) maxRaw = raw;
    }

    // Normalise to [0, 1]
    this._importanceWeights = new Map();
    if (maxRaw === 0) {
      for (const id of rawScores.keys()) {
        this._importanceWeights.set(id, 0);
      }
    } else {
      for (const [id, raw] of rawScores) {
        this._importanceWeights.set(id, raw / maxRaw);
      }
    }

    return this._importanceWeights;
  }

  /**
   * Get the importance weight for a symbol (0-1 normalised).
   * @param {string} symbolId
   * @returns {number}
   */
  getImportanceWeight(symbolId) {
    const weights = this._computeImportanceWeights();
    return weights.get(symbolId) || 0;
  }

  /**
   * Classify a symbol into a category based on its call patterns.
   *
   * Categories:
   *  - 'utility'    – High calledBy, low calls-out (pure helper / tool function)
   *  - 'foundation' – High calledBy, moderate calls-out (base class / core service)
   *  - 'hub'        – High both calledBy AND calls-out (central coordinator / manager)
   *  - 'entry'      – Low calledBy, high calls-out (top-level entry point / controller)
   *  - 'leaf'       – Low calledBy, low calls-out (isolated / leaf function)
   *  - 'orphan'     – Zero calledBy AND zero calls-out (potentially dead code)
   *
   * @param {object} sym - Symbol entry
   * @param {number} calledByCount - Number of callers
   * @param {number} callsOutCount - Number of callees
   * @param {object} thresholds
   * @returns {string} Category label
   */
  classifySymbol(sym, calledByCount, callsOutCount, thresholds = {}) {
    const { highCalledBy = 5, highCallsOut = 5 } = thresholds;
    const isHighCalledBy = calledByCount >= highCalledBy;
    const isHighCallsOut = callsOutCount >= highCallsOut;

    if (calledByCount === 0 && callsOutCount === 0) return 'orphan';
    if (isHighCalledBy && !isHighCallsOut) return 'utility';
    if (isHighCalledBy && isHighCallsOut)  return 'hub';
    if (!isHighCalledBy && isHighCallsOut) return 'entry';
    // Moderate calledBy with low calls-out → foundation
    if (calledByCount >= Math.ceil(highCalledBy * 0.6) && !isHighCallsOut) return 'foundation';
    return 'leaf';
  }

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
   * Get hotspot analysis: symbols sorted by calledBy count (descending).
   * Filters out noisy/generic names to provide meaningful results.
   *
   * @param {object} [options]
   * @param {number}  [options.topN=20]           - Max results
   * @param {string}  [options.kind]              - Filter by SymbolKind
   * @param {string}  [options.category]          - Filter by category (utility|foundation|hub|entry|orphan)
   * @param {boolean} [options.includeOrphans=false] - Include orphan symbols (0 refs)
   * @param {boolean} [options.includeNoisy=false]   - Include noisy/generic names
   * @returns {Array<{ symbol: object, calledByCount: number, callsOutCount: number, category: string, callers: string[] }>}
   */
  getHotspots({ topN = 20, kind = null, category = null, includeOrphans = false, includeNoisy = false } = {}) {
    if (this._symbols.size === 0) this._loadFromDisk();
    if (this._symbols.size === 0) return [];

    const calledByIndex = this._buildCalledByIndex();

    // Compute dynamic thresholds based on project-wide distribution
    const allCounts = [];
    for (const sym of this._symbols.values()) {
      const cb = calledByIndex.get(sym.id) || { count: 0, callers: [] };
      const co = (this._callEdges.get(sym.id) || []).length;
      if (!CodeGraph.isNoisyName(sym.name)) {
        allCounts.push({ calledBy: cb.count, callsOut: co });
      }
    }
    // Use percentile-based thresholds: "high" = top 15%
    const sortedCB = allCounts.map(c => c.calledBy).sort((a, b) => a - b);
    const sortedCO = allCounts.map(c => c.callsOut).sort((a, b) => a - b);
    const p85CB = sortedCB[Math.floor(sortedCB.length * 0.85)] || 5;
    const p85CO = sortedCO[Math.floor(sortedCO.length * 0.85)] || 5;
    const thresholds = {
      highCalledBy: Math.max(3, p85CB),
      highCallsOut: Math.max(3, p85CO),
    };

    const results = [];
    for (const sym of this._symbols.values()) {
      if (kind && sym.kind !== kind) continue;
      if (!includeNoisy && CodeGraph.isNoisyName(sym.name)) continue;

      const calledByEntry = calledByIndex.get(sym.id) || { count: 0, callers: [] };
      const callsOut = (this._callEdges.get(sym.id) || []).length;
      const cat = this.classifySymbol(sym, calledByEntry.count, callsOut, thresholds);

      if (category && cat !== category) continue;
      if (!includeOrphans && cat === 'orphan') continue;

      results.push({
        symbol: sym,
        calledByCount: calledByEntry.count,
        callsOutCount: callsOut,
        category: cat,
        callers: calledByEntry.callers,
      });
    }

    // Sort by calledBy count descending, then by callsOut descending
    results.sort((a, b) => b.calledByCount - a.calledByCount || b.callsOutCount - a.callsOutCount);
    return results.slice(0, topN);
  }

  /**
   * Get statistics summary of symbol categories.
   * Filters out noisy names for accurate statistics.
   * @returns {{ total: number, utility: number, foundation: number, hub: number, entry: number, leaf: number, orphan: number }}
   */
  getCategoryStats() {
    if (this._symbols.size === 0) this._loadFromDisk();
    const calledByIndex = this._buildCalledByIndex();

    // Compute dynamic thresholds (same logic as getHotspots)
    const allCounts = [];
    for (const sym of this._symbols.values()) {
      if (CodeGraph.isNoisyName(sym.name)) continue;
      const cb = calledByIndex.get(sym.id) || { count: 0, callers: [] };
      const co = (this._callEdges.get(sym.id) || []).length;
      allCounts.push({ calledBy: cb.count, callsOut: co });
    }
    const sortedCB = allCounts.map(c => c.calledBy).sort((a, b) => a - b);
    const sortedCO = allCounts.map(c => c.callsOut).sort((a, b) => a - b);
    const thresholds = {
      highCalledBy: Math.max(3, sortedCB[Math.floor(sortedCB.length * 0.85)] || 5),
      highCallsOut: Math.max(3, sortedCO[Math.floor(sortedCO.length * 0.85)] || 5),
    };

    const stats = { total: this._symbols.size, utility: 0, foundation: 0, hub: 0, entry: 0, leaf: 0, orphan: 0 };

    for (const sym of this._symbols.values()) {
      if (CodeGraph.isNoisyName(sym.name)) continue;
      const calledByEntry = calledByIndex.get(sym.id) || { count: 0, callers: [] };
      const callsOut = (this._callEdges.get(sym.id) || []).length;
      const cat = this.classifySymbol(sym, calledByEntry.count, callsOut, thresholds);
      stats[cat] = (stats[cat] || 0) + 1;
    }
    return stats;
  }

  /**
   * Generate a compact Markdown digest of reusable symbols (utilities, foundations, hubs)
   * suitable for injection into Developer/Coding Agent prompts.
   *
   * This is the KEY feature: when the Agent writes new code, it should reuse
   * these high-frequency functions/classes to ensure code consistency and quality.
   *
   * @param {object} [options]
   * @param {number}  [options.maxItems=15] - Max symbols to include
   * @param {number}  [options.minCalledBy=3] - Min calledBy count to be considered reusable
   * @returns {string} Compact Markdown block
   */
  getReusableSymbolsDigest({ maxItems = 15, minCalledBy = 3 } = {}) {
    if (this._symbols.size === 0) this._loadFromDisk();
    if (this._symbols.size === 0) return '';

    const hotspots = this.getHotspots({ topN: 50 });
    const reusable = hotspots.filter(h =>
      h.calledByCount >= minCalledBy &&
      ['utility', 'foundation', 'hub'].includes(h.category)
    ).slice(0, maxItems);

    if (reusable.length === 0) return '';

    const categoryEmoji = { utility: '🔧', foundation: '🏗️', hub: '🔀' };
    const categoryLabel = { utility: 'Utility', foundation: 'Foundation', hub: 'Hub' };

    const lines = [
      '## ♻️ Reusable Symbols (prefer reuse over reinvention)',
      '',
      'These high-frequency symbols are widely used across the codebase.',
      '**When implementing new code, ALWAYS check if these existing functions/classes can be reused before writing new ones.**',
      '',
    ];

    for (const h of reusable) {
      const s = h.symbol;
      const emoji = categoryEmoji[h.category] || '📦';
      const label = categoryLabel[h.category] || h.category;
      const sig = s.signature ? `(${s.signature})` : '';
      const summary = s.summary ? ` – ${s.summary.slice(0, 50)}` : '';
      lines.push(`- ${emoji} **${s.name}**${sig} \`[${label}, ${h.calledByCount} refs]\` in \`${s.file}\`:${s.line}${summary}`);
    }

    lines.push('');
    lines.push('> ⚠️ Modifying these symbols has wide impact. Test thoroughly after changes.');
    return lines.join('\n');
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

  /**
   * Loads the code graph index from the persisted JSON file (disk → memory).
   * Called automatically when querySymbol() is invoked on an empty in-memory index.
   */
  _loadFromDisk() {
    const jsonPath = path.join(this._outputDir, 'code-graph.json');
    if (!fs.existsSync(jsonPath)) return;
    try {
      // P1 optimisation: check process-level cache first.
      // If another CodeGraph instance (or previous call) already parsed this file,
      // reuse the parsed data structures directly – avoids re-reading and re-parsing
      // a potentially 100MB+ JSON file.
      let stat;
      try { stat = fs.statSync(jsonPath); } catch (_) { return; }
      const cached = _processCache.get(jsonPath);
      if (cached && cached.mtime === stat.mtimeMs) {
        // Cache hit: clone Maps from cached parsed data
        this._symbols.clear();
        this._callEdges.clear();
        this._importEdges.clear();
        for (const [k, v] of cached.symbols)    this._symbols.set(k, v);
        for (const [k, v] of cached.callEdges)  this._callEdges.set(k, v);
        for (const [k, v] of cached.importEdges) this._importEdges.set(k, v);
        console.log(`[CodeGraph] ⚡ Loaded from process cache: ${this._symbols.size} symbols (skipped disk I/O)`);
        return;
      }

      // Cache miss: read from disk, parse, populate, then store in process cache
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      this._symbols.clear();
      this._callEdges.clear();
      this._importEdges.clear();

      if (data.version === 2 && Array.isArray(data.filePaths)) {
        // ── v2 Path Dictionary format: expand indices back to full paths ─────
        const filePaths = data.filePaths;

        // Expand compact symbols: { f, k, n, l, s?, m? } → full SymbolEntry
        for (const cs of (data.symbols || [])) {
          const file = filePaths[cs.f] || `unknown_${cs.f}`;
          const id   = `${file}::${cs.n}`;
          this._symbols.set(id, {
            id,
            kind:      cs.k,
            name:      cs.n,
            file,
            line:      cs.l,
            signature: cs.s || '',
            summary:   cs.m || '',
            _weight:   cs.w || 0,   // P0: restore persisted importance weight
          });
        }

        // Expand compact callEdges: "idx::name" → "path::name"
        const expandId = (compactId) => {
          const sepIdx = compactId.indexOf('::');
          if (sepIdx === -1) return compactId;
          const idxStr = compactId.substring(0, sepIdx);
          const idx = parseInt(idxStr, 10);
          if (isNaN(idx) || idx < 0 || idx >= filePaths.length) return compactId;
          return `${filePaths[idx]}::${compactId.substring(sepIdx + 2)}`;
        };

        for (const [compactKey, compactCallees] of Object.entries(data.callEdges || {})) {
          const fullKey = expandId(compactKey);
          this._callEdges.set(fullKey, compactCallees.map(expandId));
        }

        // Expand compact importEdges: numeric key → file path
        for (const [compactKey, imports] of Object.entries(data.importEdges || {})) {
          const idx = parseInt(compactKey, 10);
          const fullKey = (!isNaN(idx) && idx >= 0 && idx < filePaths.length)
            ? filePaths[idx]
            : compactKey;
          this._importEdges.set(fullKey, imports);
        }
      } else {
        // ── v1 Legacy format: direct full paths (backward compatible) ────────
        for (const sym of (data.symbols || [])) {
          this._symbols.set(sym.id, sym);
        }
        for (const [k, v] of Object.entries(data.callEdges || {})) {
          this._callEdges.set(k, v);
        }
        for (const [k, v] of Object.entries(data.importEdges || {})) {
          this._importEdges.set(k, v);
        }
      }

      // Store parsed result in process-level cache (always in expanded format)
      _processCache.set(jsonPath, {
        mtime:      stat.mtimeMs,
        symbols:    new Map(this._symbols),
        callEdges:  new Map(this._callEdges),
        importEdges: new Map(this._importEdges),
      });

      const isV1 = data.version !== 2;
      const formatLabel = isV1 ? 'v1 legacy' : 'v2 path-dictionary';
      console.log(`[CodeGraph] 📂 Loaded from disk: ${this._symbols.size} symbols (${formatLabel}, cached for reuse)`);

      // P1: Build inverted token index for semantic search
      this._buildTokenIndex();

      // ── Auto-upgrade: if v1 format detected, schedule async re-write as v2 ──
      // This upgrades the on-disk file without triggering a full build().
      // The in-memory data is already in expanded (canonical) format, so we just
      // need to call _writeOutput() which always writes v2 path-dictionary format.
      if (isV1 && this._symbols.size > 0) {
        this._needsFormatUpgrade = true;
        this._scheduleFormatUpgrade(jsonPath);
      }
    } catch (err) {
      console.warn(`[CodeGraph] Failed to load from disk: ${err.message}`);
    }
  }

  /**
   * Schedule a non-blocking async re-write of code-graph.json in v2 format.
   * Called by _loadFromDisk() when it detects a v1 legacy file on disk.
   *
   * The in-memory data is already expanded (identical to post-build state),
   * so we only need _writeOutput() – no build() or source scanning required.
   *
   * The upgrade is fire-and-forget: it won't block any query API call.
   * Duplicate invocations are de-duplicated via _upgradePromise.
   * @private
   */
  _scheduleFormatUpgrade(jsonPath) {
    // Prevent duplicate upgrade writes (guard against concurrent calls)
    if (this._upgradePromise) return;

    console.log(`[CodeGraph] 🔄 Auto-upgrade: scheduling v1 → v2 format re-write for ${path.basename(jsonPath)}`);

    // Use setImmediate (or setTimeout 0) so the upgrade runs after the
    // current synchronous _loadFromDisk() call stack returns, keeping the
    // calling query API responsive.
    this._upgradePromise = new Promise((resolve) => {
      const run = () => {
        try {
          const result = this._writeOutput();
          this._needsFormatUpgrade = false;
          this._upgradePromise = null;
          if (result) {
            console.log(`[CodeGraph] ✅ Auto-upgrade: v1 → v2 re-write complete`);
          }
        } catch (err) {
          console.warn(`[CodeGraph] ⚠️  Auto-upgrade failed (non-fatal): ${err.message}`);
          this._upgradePromise = null;
        }
        resolve();
      };
      // setImmediate is available in Node.js; fallback to setTimeout(0) for safety
      if (typeof setImmediate === 'function') {
        setImmediate(run);
      } else {
        setTimeout(run, 0);
      }
    });
  }

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
   * Format hotspot analysis results as Markdown (for /graph hotspot command).
   * @param {number} [topN=20]
   * @returns {string}
   */
  hotspotsAsMarkdown(topN = 20) {
    if (this._symbols.size === 0) this._loadFromDisk();
    if (this._symbols.size === 0) return '_Code graph not available._';

    const hotspots = this.getHotspots({ topN });
    if (hotspots.length === 0) return '_No hotspot data available. Run `/graph build` first._';

    const stats = this.getCategoryStats();
    const categoryEmoji = { utility: '🔧', foundation: '🏗️', hub: '🔀', entry: '🚪', leaf: '🍃', orphan: '👻' };
    const categoryLabel = { utility: 'Utility', foundation: 'Foundation', hub: 'Hub', entry: 'Entry', leaf: 'Leaf', orphan: 'Orphan' };

    const lines = [
      `## 🔥 Hotspot Analysis (Top ${topN})`,
      '',
      `**Category distribution** (${stats.total} total symbols):`,
      `| Category | Count | Description |`,
      `|----------|-------|-------------|`,
      `| 🔧 Utility    | ${stats.utility} | High calledBy, low calls-out (helper/tool functions) |`,
      `| 🏗️ Foundation | ${stats.foundation} | Moderate+ calledBy, low calls-out (base class/core service) |`,
      `| 🔀 Hub        | ${stats.hub} | High calledBy AND calls-out (central coordinator/manager) |`,
      `| 🚪 Entry      | ${stats.entry} | Low calledBy, high calls-out (top-level entry/controller) |`,
      `| 🍃 Leaf       | ${stats.leaf} | Low calledBy, low calls-out (isolated/leaf function) |`,
      `| 👻 Orphan     | ${stats.orphan} | Zero refs in AND out (potentially dead code) |`,
      '',
      '### Top Referenced Symbols',
      '',
      '| # | Symbol | Category | ← Refs | → Calls | File |',
      '|---|--------|----------|--------|---------|------|',
    ];

    for (let i = 0; i < hotspots.length; i++) {
      const h = hotspots[i];
      const s = h.symbol;
      const emoji = categoryEmoji[h.category] || '📦';
      const label = categoryLabel[h.category] || h.category;
      lines.push(`| ${i + 1} | **${s.name}** | ${emoji} ${label} | ${h.calledByCount} | ${h.callsOutCount} | \`${s.file}\`:${s.line} |`);
    }

    lines.push('');
    lines.push('### 💡 Insights');
    lines.push('');

    // Auto-generate insights
    const utilities = hotspots.filter(h => h.category === 'utility');
    const hubs = hotspots.filter(h => h.category === 'hub');
    const entries = hotspots.filter(h => h.category === 'entry');

    if (utilities.length > 0) {
      lines.push(`- **🔧 ${utilities.length} utility symbols** are widely reused. Modifying them impacts many callers – always check reverse dependencies.`);
    }
    if (hubs.length > 0) {
      lines.push(`- **🔀 ${hubs.length} hub symbols** are central coordinators with both high fan-in and fan-out. These are architecture bottlenecks – consider if they have too many responsibilities.`);
    }
    if (entries.length > 0) {
      lines.push(`- **🚪 ${entries.length} entry points** call many functions but are rarely called themselves. These are good starting points for understanding business flows.`);
    }
    if (stats.orphan > 0) {
      lines.push(`- **👻 ${stats.orphan} orphan symbols** have zero connections. Review if they are genuinely unused or just not yet connected.`);
    }

    return lines.join('\n');
  }

  // ─── Symbol Extraction ────────────────────────────────────────────────────

  _extractSymbols(content, relPath, ext) {
    const lines = content.split('\n');
    switch (ext) {
      case '.js': case '.ts': this._extractJsSymbols(lines, relPath); break;
      case '.cs':             this._extractCsSymbols(lines, relPath); break;
      case '.lua':            this._extractLuaSymbols(lines, relPath); break;
      case '.go':             this._extractGoSymbols(lines, relPath); break;
      case '.py':             this._extractPySymbols(lines, relPath); break;
      case '.dart':           this._extractDartSymbols(lines, relPath); break;
    }
  }

  _addSymbol(kind, name, file, line, signature = '', summary = '') {
    const id = `${file}::${name}`;
    if (!this._symbols.has(id)) {
      this._symbols.set(id, { id, kind, name, file, line, signature, summary });
    }
  }

  _extractJsSymbols(lines, file) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      // class Foo / class Foo extends Bar
      const classMatch = line.match(/^(?:export\s+)?class\s+(\w+)/);
      if (classMatch) {
        const summary = this._extractJsDocSummary(lines, i);
        this._addSymbol(SymbolKind.CLASS, classMatch[1], file, i + 1, '', summary);
        continue;
      }
      // function foo(...) / async function foo(...)
      const fnMatch = line.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/);
      if (fnMatch) {
        const summary = this._extractJsDocSummary(lines, i);
        this._addSymbol(SymbolKind.FUNCTION, fnMatch[1], file, i + 1, fnMatch[2].slice(0, 40), summary);
        continue;
      }
      // const foo = (...) => / const foo = function(...)
      const arrowMatch = line.match(/^(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(?([^)]*)\)?\s*=>/);
      if (arrowMatch) {
        const summary = this._extractJsDocSummary(lines, i);
        this._addSymbol(SymbolKind.FUNCTION, arrowMatch[1], file, i + 1, arrowMatch[2].slice(0, 40), summary);
        continue;
      }
      // method inside class: methodName(...) {
      const methodMatch = line.match(/^(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*\{/);
      if (methodMatch && !['if', 'for', 'while', 'switch', 'catch'].includes(methodMatch[1])) {
        // P1: Extract JSDoc summary for methods too (was: empty string)
        const summary = this._extractJsDocSummary(lines, i);
        this._addSymbol(SymbolKind.METHOD, methodMatch[1], file, i + 1, methodMatch[2].slice(0, 40), summary);
      }
    }
  }

  _extractCsSymbols(lines, file) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      // class / struct / interface / enum
      const typeMatch = line.match(/^(?:public|internal|protected|private)?\s*(?:abstract|sealed|static|partial)?\s*(?:abstract|sealed|static|partial)?\s*(class|struct|interface|enum)\s+(\w+)/);
      if (typeMatch) {
        const summary = this._extractXmlDocSummary(lines, i);
        this._addSymbol(typeMatch[1] === 'interface' ? SymbolKind.INTERFACE : typeMatch[1] === 'enum' ? SymbolKind.ENUM : SymbolKind.CLASS, typeMatch[2], file, i + 1, '', summary);
        continue;
      }
      // public methods
      const methodMatch = line.match(/^public\s+(?:static\s+|override\s+|virtual\s+|async\s+)*([\w<>\[\]?,\s]+?)\s+(\w+)\s*\(([^)]*)\)/);
      if (methodMatch) {
        const name = methodMatch[2];
        if (!['if', 'while', 'for', 'foreach', 'switch', 'using', 'return'].includes(name)) {
          const summary = this._extractXmlDocSummary(lines, i);
          this._addSymbol(SymbolKind.METHOD, name, file, i + 1, methodMatch[3].slice(0, 40), summary);
        }
      }
    }
  }

  _extractLuaSymbols(lines, file) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('--')) continue;
      // function Foo:Bar(...) or function Foo.Bar(...)
      const fnMatch = line.match(/^function\s+([\w.:]+)\s*\(([^)]*)\)/);
      if (fnMatch) {
        const summary = this._extractLuaCommentSummary(lines, i);
        this._addSymbol(SymbolKind.FUNCTION, fnMatch[1], file, i + 1, fnMatch[2].slice(0, 40), summary);
        continue;
      }
      // local ClassName = {} or ClassName = class(...)
      const classMatch = line.match(/^(?:local\s+)?(\w+)\s*=\s*(?:class\s*\(|BaseClass\s*\(|\{\})/);
      if (classMatch && classMatch[1].length > 1 && classMatch[1] !== '_') {
        this._addSymbol(SymbolKind.MODULE, classMatch[1], file, i + 1, '', '');
      }
    }
  }

  _extractGoSymbols(lines, file) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      // type Foo struct / type Foo interface
      const typeMatch = line.match(/^type\s+(\w+)\s+(struct|interface)/);
      if (typeMatch) {
        this._addSymbol(typeMatch[2] === 'interface' ? SymbolKind.INTERFACE : SymbolKind.CLASS, typeMatch[1], file, i + 1, '', '');
        continue;
      }
      // func (r *Receiver) MethodName(...) or func FuncName(...)
      const fnMatch = line.match(/^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(([^)]*)\)/);
      if (fnMatch) {
        const summary = this._extractGoDocSummary(lines, i);
        this._addSymbol(SymbolKind.FUNCTION, fnMatch[1], file, i + 1, fnMatch[2].slice(0, 40), summary);
      }
    }
  }

  _extractPySymbols(lines, file) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      // class Foo: / class Foo(Bar):
      const classMatch = trimmed.match(/^class\s+(\w+)/);
      if (classMatch) {
        this._addSymbol(SymbolKind.CLASS, classMatch[1], file, i + 1, '', '');
        continue;
      }
      // def foo(...): / async def foo(...):
      const fnMatch = trimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/);
      if (fnMatch) {
        const summary = this._extractPyDocSummary(lines, i);
        this._addSymbol(SymbolKind.FUNCTION, fnMatch[1], file, i + 1, fnMatch[2].slice(0, 40), summary);
      }
    }
  }

  _extractDartSymbols(lines, file) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      // class Foo / abstract class Foo
      const classMatch = line.match(/^(?:abstract\s+)?class\s+(\w+)/);
      if (classMatch) {
        // P1: Extract Dart /// doc comments for classes
        const summary = this._extractDartDocSummary(lines, i);
        this._addSymbol(SymbolKind.CLASS, classMatch[1], file, i + 1, '', summary);
        continue;
      }
      // void foo(...) / Future<T> foo(...) / String foo(...)
      const fnMatch = line.match(/^(?:[\w<>?]+\s+)+(\w+)\s*\(([^)]*)\)\s*(?:async\s*)?\{/);
      if (fnMatch && !['if', 'for', 'while', 'switch'].includes(fnMatch[1])) {
        // P1: Extract Dart /// doc comments for functions
        const summary = this._extractDartDocSummary(lines, i);
        this._addSymbol(SymbolKind.FUNCTION, fnMatch[1], file, i + 1, fnMatch[2].slice(0, 40), summary);
      }
    }
  }

  // ─── Comment/Doc Summary Extractors ──────────────────────────────────────

  _extractJsDocSummary(lines, fnLine) {
    // Look backwards for /** ... */ JSDoc block
    for (let i = fnLine - 1; i >= Math.max(0, fnLine - 8); i--) {
      const line = lines[i].trim();
      if (line.startsWith('* ') || line.startsWith('*/')) {
        // Find the description line
        const descMatch = line.match(/^\*\s+([^@].+)/);
        if (descMatch) return descMatch[1].trim().slice(0, 80);
      }
    }
    return '';
  }

  _extractXmlDocSummary(lines, fnLine) {
    for (let i = fnLine - 1; i >= Math.max(0, fnLine - 5); i--) {
      const line = lines[i].trim();
      const match = line.match(/\/\/\/\s*<summary>\s*(.+?)\s*(?:<\/summary>)?$/);
      if (match) return match[1].trim().slice(0, 80);
      const match2 = line.match(/\/\/\/\s+(.+)/);
      if (match2 && !match2[1].startsWith('<')) return match2[1].trim().slice(0, 80);
    }
    return '';
  }

  _extractLuaCommentSummary(lines, fnLine) {
    if (fnLine > 0) {
      const prev = lines[fnLine - 1].trim();
      const match = prev.match(/^--+\s*(.+)/);
      if (match) return match[1].trim().slice(0, 80);
    }
    return '';
  }

  _extractGoDocSummary(lines, fnLine) {
    for (let i = fnLine - 1; i >= Math.max(0, fnLine - 5); i--) {
      const line = lines[i].trim();
      const match = line.match(/^\/\/\s+(.+)/);
      if (match) return match[1].trim().slice(0, 80);
      if (!line.startsWith('//')) break;
    }
    return '';
  }

  _extractPyDocSummary(lines, fnLine) {
    // Check for docstring on next line
    if (fnLine + 1 < lines.length) {
      const next = lines[fnLine + 1].trim();
      const match = next.match(/^"""(.+?)"""$|^'''(.+?)'''$|^"""(.+)/);
      if (match) return (match[1] || match[2] || match[3]).trim().slice(0, 80);
    }
    return '';
  }

  /**
   * Extract Dart /// doc comment summary from lines before a declaration.
   * Dart uses triple-slash `///` for documentation comments.
   *
   * @param {string[]} lines - All file lines
   * @param {number} fnLine - 0-based line index of the declaration
   * @returns {string} Summary text (max 80 chars) or ''
   * @private
   */
  _extractDartDocSummary(lines, fnLine) {
    for (let i = fnLine - 1; i >= Math.max(0, fnLine - 8); i--) {
      const line = lines[i].trim();
      // Dart doc comment: /// text
      const match = line.match(/^\/\/\/\s+(.+)/);
      if (match) {
        const text = match[1].trim();
        // Skip annotation-like lines or empty descriptions
        if (text && !text.startsWith('@') && !text.startsWith('[') && text.length > 3) {
          return text.slice(0, 80);
        }
      }
      // Also accept // comments as fallback for Dart
      const commentMatch = line.match(/^\/\/\s+(.+)/);
      if (commentMatch && !line.startsWith('///')) {
        const text = commentMatch[1].trim();
        if (text && text.length > 5) return text.slice(0, 80);
      }
      // Stop at non-comment, non-blank, non-annotation lines
      if (line && !line.startsWith('//') && !line.startsWith('@') && line !== '') break;
    }
    return '';
  }
  // ─── Import/Call Edge Extraction ──────────────────────────────────────────

  _extractImports(content, relPath, ext) {
    const imports = [];
    if (ext === '.js' || ext === '.ts') {
      const matches = content.matchAll(/require\(['"]([^'"]+)['"]\)|import\s+.*?from\s+['"]([^'"]+)['"]/g);
      for (const m of matches) {
        const dep = m[1] || m[2];
        if (dep && !dep.startsWith('.')) continue; // skip node_modules
        if (dep) imports.push(dep);
      }
    } else if (ext === '.lua') {
      const matches = content.matchAll(/require\(['"]([^'"]+)['"]\)/g);
      for (const m of matches) imports.push(m[1]);
    } else if (ext === '.go') {
      const matches = content.matchAll(/"([^"]+)"/g);
      for (const m of matches) {
        if (m[1].includes('/')) imports.push(m[1]);
      }
    } else if (ext === '.py') {
      const matches = content.matchAll(/^(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm);
      for (const m of matches) imports.push(m[1] || m[2]);
    }
    if (imports.length > 0) this._importEdges.set(relPath, imports);
  }

  _extractCallEdges(content, relPath, ext, preExtractedTokens) {
    // R1-5 audit: PERFORMANCE FIX – replaced O(fileSymbols × allSymbols) nested loop
    // (each iteration constructing a new RegExp) with a single-pass word extraction
    // + Set lookup approach. For a 2000-symbol project, this reduces from ~4M regex
    // tests per file to ~1 hash-set lookup per word token.
    //
    // P0/P1 optimisation: accepts pre-extracted word tokens (Set<string>) from the
    // first pass, avoiding the need to re-read the file from disk. When
    // preExtractedTokens is provided, `content` can be null.
    const fileSymbols = this.getFileSymbols(relPath);
    if (fileSymbols.length === 0) return;

    // Build a Map: symbolName → symbolId (prefer same-file symbols)
    const nameToId = new Map();
    for (const sym of this._symbols.values()) {
      const existing = nameToId.get(sym.name);
      // Prefer symbol from the same file for disambiguation
      if (!existing || sym.file === relPath) {
        nameToId.set(sym.name, sym.id);
      }
    }

    // Use pre-extracted tokens if available (P0/P1 single-pass optimisation),
    // otherwise extract from content (backward-compatible fallback).
    const wordTokens = preExtractedTokens || new Set(content.match(/\b\w+\b/g) || []);

    // For each file symbol, find which known symbols appear as word tokens
    const fileSymbolNames = new Set(fileSymbols.map(s => s.name));
    for (const sym of fileSymbols) {
      const calls = [];
      for (const token of wordTokens) {
        if (token === sym.name) continue;          // skip self-reference
        if (nameToId.has(token)) {
          const calleeId = nameToId.get(token);
          if (calleeId !== sym.id) {
            calls.push(calleeId);
          }
        }
      }
      if (calls.length > 0) {
        this._callEdges.set(sym.id, [...new Set(calls)]);
      }
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  // ─── P0 Lazy Enrichment ─────────────────────────────────────────────────────
  // "Scan shallow, query deep" – during scan we only store skeleton info (name,
  // file, line). At query time we lazily read ~30 source lines around the symbol
  // to fill in missing signature, summary, and structural relationships.
  // Results are cached in-memory (never written back to JSON) so each symbol
  // is enriched at most once per process lifetime.

  /**
   * Read a small window of source lines from disk.
   * Returns an array of raw line strings (0-indexed).
   *
   * @param {string} relPath - Relative file path (as stored in symbol.file)
   * @param {number} startLine - 1-based start line
   * @param {number} count - Number of lines to read
   * @returns {string[]}
   * @private
   */
  _readSourceLines(relPath, startLine, count) {
    try {
      const absPath = path.join(this._root, relPath);
      if (!fs.existsSync(absPath)) return [];
      const content = fs.readFileSync(absPath, 'utf-8');
      const lines = content.split('\n');
      const start = Math.max(0, startLine - 1); // convert 1-based → 0-based
      return lines.slice(start, start + count);
    } catch (_) {
      return [];
    }
  }

  /**
   * Infer a human-readable summary from a CamelCase / snake_case symbol name.
   * e.g. "CSResReportTrackDownload" → "CS Res Report Track Download"
   *      "get_user_profile"         → "get user profile"
   *
   * @param {string} name
   * @returns {string}
   * @private
   */
  _inferSummaryFromName(name) {
    if (!name || name.length < 4) return '';
    // Strip common prefixes that don't add meaning
    let clean = name;
    // CamelCase split
    const words = clean
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')  // camelCase → camel Case
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // ABCDef → ABC Def
      .replace(/_/g, ' ')                        // snake_case → snake case
      .replace(/:/g, ' ')                         // Lua Foo:Bar → Foo Bar
      .split(/\s+/)
      .filter(w => w.length > 0);
    if (words.length <= 1) return '';
    return words.join(' ');
  }

  /**
   * Extract inheritance/extends info from a source line.
   * Supports: JS/TS (extends), C# (: Base, IFoo), Go (embedding), Python (class Foo(Bar)).
   *
   * @param {string} declLine - The declaration line
   * @param {string} ext - File extension
   * @returns {string[]} List of parent/interface names
   * @private
   */
  _extractInheritance(declLine, ext) {
    if (!declLine) return [];
    const trimmed = declLine.trim();
    const parents = [];

    if (ext === '.js' || ext === '.ts' || ext === '.dart') {
      // class Foo extends Bar implements IBaz, IQux
      const extendsMatch = trimmed.match(/extends\s+([\w.]+)/);
      if (extendsMatch) parents.push(extendsMatch[1]);
      const implMatch = trimmed.match(/implements\s+([\w.,\s]+)/);
      if (implMatch) {
        parents.push(...implMatch[1].split(',').map(s => s.trim()).filter(Boolean));
      }
    } else if (ext === '.cs') {
      // class Foo : Bar, IFoo, IBaz
      const colonMatch = trimmed.match(/(?:class|struct|interface)\s+\w+\s*(?:<[^>]+>)?\s*:\s*([^{]+)/);
      if (colonMatch) {
        parents.push(...colonMatch[1].split(',').map(s => s.trim().replace(/<.*>/, '')).filter(Boolean));
      }
    } else if (ext === '.py') {
      // class Foo(Bar, Baz):
      const pyMatch = trimmed.match(/class\s+\w+\s*\(([^)]+)\)/);
      if (pyMatch) {
        parents.push(...pyMatch[1].split(',').map(s => s.trim()).filter(s => s && s !== 'object'));
      }
    } else if (ext === '.go') {
      // Go uses struct embedding – look for embedded type names in subsequent lines
      // (handled separately in enrichSymbol since we need multi-line context)
    }

    return parents;
  }

  /**
   * Extract key members (fields + methods) from class body lines.
   * Returns a compact summary like: "fields: x, y, z | methods: foo, bar"
   *
   * @param {string[]} lines - Source lines of the class body
   * @param {string} ext - File extension
   * @returns {{ fields: string[], methods: string[] }}
   * @private
   */
  _extractClassMembers(lines, ext) {
    const fields = [];
    const methods = [];
    const maxScan = Math.min(lines.length, 50); // Don't scan more than 50 lines

    for (let i = 0; i < maxScan; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) continue;

      if (ext === '.cs') {
        // public int Foo { get; set; } or public string Bar;
        const fieldMatch = line.match(/^public\s+(?:static\s+)?([\w<>\[\]?,]+)\s+(\w+)\s*[{;=]/);
        if (fieldMatch && !line.includes('(')) {
          fields.push(fieldMatch[2]);
          continue;
        }
        // public void DoSomething(...)
        const methodMatch = line.match(/^(?:public|protected|internal)\s+(?:static\s+|override\s+|virtual\s+|async\s+)*[\w<>\[\]?,\s]+?\s+(\w+)\s*\(/);
        if (methodMatch && !['if', 'while', 'for', 'foreach', 'switch', 'using', 'return'].includes(methodMatch[1])) {
          methods.push(methodMatch[1]);
          continue;
        }
      } else if (ext === '.js' || ext === '.ts') {
        // method(...) { or async method(...) {
        const mMatch = line.match(/^(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/);
        if (mMatch && !['if', 'for', 'while', 'switch', 'catch', 'constructor'].includes(mMatch[1])) {
          methods.push(mMatch[1]);
          continue;
        }
        // this.foo = ... or readonly foo: ...
        const fMatch = line.match(/^(?:this\.)?(\w+)\s*[:=]/) || line.match(/^(?:readonly|private|public|protected)\s+(?:\w+\s+)?(\w+)/);
        if (fMatch && !line.includes('(')) {
          fields.push(fMatch[1]);
        }
      } else if (ext === '.py') {
        const defMatch = line.match(/^def\s+(\w+)\s*\(/);
        if (defMatch && defMatch[1] !== '__init__') {
          methods.push(defMatch[1]);
          continue;
        }
        const selfMatch = line.match(/^self\.(\w+)\s*=/);
        if (selfMatch) fields.push(selfMatch[1]);
      }
    }

    return {
      fields: [...new Set(fields)].slice(0, 10),
      methods: [...new Set(methods)].slice(0, 10),
    };
  }

  /**
   * Extract the full function signature from source lines (return type + full params).
   * The scan-time extraction truncates params at 40 chars; this recovers the full signature.
   *
   * @param {string[]} lines - Source lines starting from the function declaration
   * @param {string} ext - File extension
   * @returns {string} Full signature like "async (req: Request, res: Response): Promise<void>"
   * @private
   */
  _extractFullSignature(lines, ext) {
    if (!lines || lines.length === 0) return '';
    // Join first few lines to handle multi-line signatures
    const joined = lines.slice(0, 5).join(' ').replace(/\s+/g, ' ');
    // Also keep just the first line for priority matching (avoids matching body code)
    const firstLine = (lines[0] || '').replace(/\s+/g, ' ');

    if (ext === '.cs') {
      // public static async Task<Result> MethodName(Type1 arg1, Type2 arg2)
      const m = joined.match(/(?:public|private|protected|internal)\s+(?:static\s+|override\s+|virtual\s+|async\s+)*([\w<>\[\]?,\s]+?)\s+\w+\s*\(([^)]*)\)/);
      if (m) return `${m[1].trim()} (${m[2].trim()})`.slice(0, 120);
    } else if (ext === '.js' || ext === '.ts') {
      // function foo(a, b, c) or method(a: Type, b: Type): ReturnType
      // Priority: match the FIRST LINE only to avoid picking up body code patterns
      // like (ext === '.py') being confused for a parameter list.
      const jsRe = /(?:function\s+\w+|\w+)\s*\(([^)]*)\)(?:\s*:\s*([\w<>\[\]|&,\s]+))?/;
      const m = firstLine.match(jsRe) || joined.match(jsRe);
      if (m) {
        const params = m[1].trim();
        const ret = m[2] ? `: ${m[2].trim()}` : '';
        return `(${params})${ret}`.slice(0, 120);
      }
    } else if (ext === '.go') {
      // func (r *Recv) Name(args) (returns)
      const m = joined.match(/func\s+(?:\([^)]+\)\s+)?\w+\s*\(([^)]*)\)\s*(\([^)]*\)|[\w*]+)?/);
      if (m) {
        const params = m[1].trim();
        const ret = m[2] ? ` ${m[2].trim()}` : '';
        return `(${params})${ret}`.slice(0, 120);
      }
    } else if (ext === '.py') {
      // def foo(self, a: int, b: str) -> RetType:
      const m = joined.match(/def\s+\w+\s*\(([^)]*)\)(?:\s*->\s*([\w\[\],\s]+))?/);
      if (m) {
        const params = m[1].trim();
        const ret = m[2] ? ` -> ${m[2].trim()}` : '';
        return `(${params})${ret}`.slice(0, 120);
      }
    } else if (ext === '.lua') {
      const m = joined.match(/function\s+[\w.:]+\s*\(([^)]*)\)/);
      if (m) return `(${m[1].trim()})`.slice(0, 120);
    } else if (ext === '.dart') {
      const m = joined.match(/(?:[\w<>?]+\s+)+\w+\s*\(([^)]*)\)/);
      if (m) return `(${m[1].trim()})`.slice(0, 120);
    }

    return '';
  }

  /**
   * Extract the constructor signature from a class body.
   * Looks for constructor/init/__init__/New methods within the first ~30 lines.
   *
   * @param {string[]} lines - Lines starting from class declaration
   * @param {string} ext - File extension
   * @returns {string} Constructor parameter list, or ''
   * @private
   */
  _extractConstructorSignature(lines, ext) {
    if (!lines || lines.length === 0) return '';
    const bodyLines = lines.slice(1, 30).join(' ').replace(/\s+/g, ' ');

    if (ext === '.js' || ext === '.ts') {
      const m = bodyLines.match(/constructor\s*\(([^)]*)\)/);
      if (m) return `constructor(${m[1].trim()})`.slice(0, 120);
    } else if (ext === '.cs') {
      // C# constructor: ClassName(params)
      const className = (lines[0] || '').match(/(?:class|struct)\s+(\w+)/);
      if (className) {
        const re = new RegExp(className[1] + '\\s*\\(([^)]*)\\)');
        const m = bodyLines.match(re);
        if (m) return `${className[1]}(${m[1].trim()})`.slice(0, 120);
      }
    } else if (ext === '.py') {
      const m = bodyLines.match(/def\s+__init__\s*\(([^)]*)\)/);
      if (m) {
        const params = m[1].replace(/\s*self\s*,?\s*/, '').trim();
        return `__init__(${params})`.slice(0, 120);
      }
    } else if (ext === '.go') {
      // Go: func NewTypeName(params) *TypeName
      const className = (lines[0] || '').match(/type\s+(\w+)/);
      if (className) {
        // Look for func New<TypeName> in nearby lines
        const allLines = lines.join(' ');
        const re = new RegExp('func\\s+New' + className[1] + '\\s*\\(([^)]*)\\)');
        const m = allLines.match(re);
        if (m) return `New${className[1]}(${m[1].trim()})`.slice(0, 120);
      }
    } else if (ext === '.dart') {
      const className = (lines[0] || '').match(/class\s+(\w+)/);
      if (className) {
        const re = new RegExp(className[1] + '\\s*\\(([^)]*)\\)');
        const m = bodyLines.match(re);
        if (m) return `${className[1]}(${m[1].trim()})`.slice(0, 120);
      }
    }

    return '';
  }

  /**
   * Extract a class-level declaration signature.
   * Returns the class declaration without the body (e.g. "class Foo extends Bar implements IBaz").
   *
   * @param {string} declLine - The class declaration line
   * @param {string} ext - File extension
   * @returns {string} Class declaration signature, or ''
   * @private
   */
  _extractClassDeclSignature(declLine, ext) {
    if (!declLine) return '';
    const trimmed = declLine.trim()
      .replace(/\s*\{?\s*$/, '') // remove trailing {
      .replace(/\s+/g, ' ');

    if (ext === '.js' || ext === '.ts' || ext === '.dart') {
      const m = trimmed.match(/((?:export\s+)?(?:abstract\s+)?class\s+\w+(?:\s+extends\s+[\w.]+)?(?:\s+implements\s+[\w.,\s]+)?)/);
      if (m) return m[1].slice(0, 120);
    } else if (ext === '.cs') {
      const m = trimmed.match(/((?:public|internal|abstract|sealed|partial|static)\s+)*(?:class|struct|interface)\s+\w+(?:\s*<[^>]+>)?(?:\s*:\s*[^{]+)?/);
      if (m) return m[0].trim().slice(0, 120);
    } else if (ext === '.py') {
      const m = trimmed.match(/(class\s+\w+(?:\s*\([^)]*\))?)/);
      if (m) return m[1].slice(0, 120);
    } else if (ext === '.go') {
      const m = trimmed.match(/(type\s+\w+\s+(?:struct|interface))/);
      if (m) return m[1].slice(0, 120);
    }

    return '';
  }

  /**
   * Infer a summary from a symbol's name, kind, and structural context.
   * Much richer than a simple CamelCase split – uses kind-specific templates
   * and parameter information to generate meaningful descriptions.
   *
   * Examples:
   *   - class ExperienceStore → "Storage/management class for experiences"
   *   - function buildAgentPrompt(role, input) → "Builds agent prompt from role and input"
   *   - method _extractCallEdges → "Extracts call edges (internal)"
   *
   * @param {object} sym - Symbol entry (with kind, name, signature, _constructorSignature)
   * @returns {string} Human-readable inferred summary, or ''
   * @private
   */
  _inferSummaryFromContext(sym) {
    if (!sym.name || sym.name.length < 4) return '';

    // CamelCase/snake_case split into words
    const words = sym.name
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/_/g, ' ')
      .replace(/:/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 0)
      .map(w => w.toLowerCase());

    if (words.length <= 1) return '';

    const isPrivate = sym.name.startsWith('_');
    const privateSuffix = isPrivate ? ' (internal)' : '';

    // ── Kind-specific templates ──

    if (sym.kind === 'class' || sym.kind === 'interface') {
      // Identify common naming patterns
      const nameLower = words.join(' ');

      // Pattern: *Store, *Cache, *Repository, *Manager → storage/management
      if (/store|cache|repository|registry/.test(nameLower)) {
        const subject = words.filter(w => !/store|cache|repository|registry/.test(w)).join(' ');
        return `Storage/management class for ${subject || 'data'}`;
      }
      // Pattern: *Engine, *Processor, *Handler → processing
      if (/engine|processor|handler|worker/.test(nameLower)) {
        const subject = words.filter(w => !/engine|processor|handler|worker/.test(w)).join(' ');
        return `Processing engine for ${subject || 'tasks'}`;
      }
      // Pattern: *Builder, *Factory, *Creator → construction
      if (/builder|factory|creator/.test(nameLower)) {
        const subject = words.filter(w => !/builder|factory|creator/.test(w)).join(' ');
        return `Constructs ${subject || 'objects'}`;
      }
      // Pattern: *Adapter, *Bridge, *Wrapper → adaptation
      if (/adapter|bridge|wrapper|proxy/.test(nameLower)) {
        const subject = words.filter(w => !/adapter|bridge|wrapper|proxy/.test(w)).join(' ');
        return `Adapter/wrapper for ${subject || 'external interface'}`;
      }
      // Pattern: *Loader, *Reader, *Parser → data loading
      if (/loader|reader|parser|scanner/.test(nameLower)) {
        const subject = words.filter(w => !/loader|reader|parser|scanner/.test(w)).join(' ');
        return `Loads/parses ${subject || 'data'}`;
      }
      // Pattern: I* (interface)
      if (sym.kind === 'interface' || sym.name.startsWith('I') && /^I[A-Z]/.test(sym.name)) {
        return `Interface for ${words.filter(w => w !== 'i').join(' ')}`;
      }
      // Generic class
      return `${words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')} class`;
    }

    if (sym.kind === 'function' || sym.kind === 'method') {
      const verb = words[0];
      const rest = words.slice(1).join(' ');

      // Extract parameter names for richer context
      let paramHint = '';
      const sig = sym.signature || sym._constructorSignature || '';
      if (sig) {
        const paramMatch = sig.match(/\(([^)]*)\)/);
        if (paramMatch && paramMatch[1].trim()) {
          const params = paramMatch[1].split(',')
            .map(p => p.trim().split(/[\s:=]/)[0].replace(/^\.\.\./, ''))
            .filter(p => p && p !== 'self' && p !== 'this' && p.length > 1)
            .slice(0, 3);
          if (params.length > 0) {
            paramHint = ` from ${params.join(' and ')}`;
          }
        }
      }

      // Common verb templates
      const verbTemplates = {
        'get': `Gets ${rest}${paramHint}`,
        'set': `Sets ${rest}${paramHint}`,
        'build': `Builds ${rest}${paramHint}`,
        'create': `Creates ${rest}${paramHint}`,
        'init': `Initializes ${rest}${paramHint}`,
        'load': `Loads ${rest}${paramHint}`,
        'save': `Saves ${rest}${paramHint}`,
        'parse': `Parses ${rest}${paramHint}`,
        'extract': `Extracts ${rest}${paramHint}`,
        'find': `Finds ${rest}${paramHint}`,
        'search': `Searches for ${rest}${paramHint}`,
        'check': `Checks ${rest}${paramHint}`,
        'validate': `Validates ${rest}${paramHint}`,
        'is': `Checks if ${rest}`,
        'has': `Checks if has ${rest}`,
        'should': `Determines if should ${rest}`,
        'can': `Checks ability to ${rest}`,
        'handle': `Handles ${rest}${paramHint}`,
        'on': `Event handler for ${rest}`,
        'emit': `Emits ${rest} event`,
        'render': `Renders ${rest}${paramHint}`,
        'update': `Updates ${rest}${paramHint}`,
        'delete': `Deletes ${rest}${paramHint}`,
        'remove': `Removes ${rest}${paramHint}`,
        'add': `Adds ${rest}${paramHint}`,
        'apply': `Applies ${rest}${paramHint}`,
        'process': `Processes ${rest}${paramHint}`,
        'run': `Runs ${rest}${paramHint}`,
        'execute': `Executes ${rest}${paramHint}`,
        'format': `Formats ${rest}${paramHint}`,
        'convert': `Converts ${rest}${paramHint}`,
        'transform': `Transforms ${rest}${paramHint}`,
        'calculate': `Calculates ${rest}${paramHint}`,
        'compute': `Computes ${rest}${paramHint}`,
        'generate': `Generates ${rest}${paramHint}`,
        'resolve': `Resolves ${rest}${paramHint}`,
        'register': `Registers ${rest}${paramHint}`,
        'setup': `Sets up ${rest}${paramHint}`,
        'reset': `Resets ${rest}`,
        'clear': `Clears ${rest}`,
        'dispose': `Disposes/cleans up ${rest}`,
        'destroy': `Destroys ${rest}`,
        'start': `Starts ${rest}`,
        'stop': `Stops ${rest}`,
        'open': `Opens ${rest}`,
        'close': `Closes ${rest}`,
        'send': `Sends ${rest}${paramHint}`,
        'receive': `Receives ${rest}`,
        'read': `Reads ${rest}${paramHint}`,
        'write': `Writes ${rest}${paramHint}`,
        'fetch': `Fetches ${rest}${paramHint}`,
        'notify': `Notifies ${rest}`,
        'subscribe': `Subscribes to ${rest}`,
        'unsubscribe': `Unsubscribes from ${rest}`,
        'merge': `Merges ${rest}${paramHint}`,
        'sort': `Sorts ${rest}`,
        'filter': `Filters ${rest}${paramHint}`,
        'map': `Maps ${rest}`,
        'reduce': `Reduces ${rest}`,
      };

      const template = verbTemplates[verb];
      if (template) return `${template}${privateSuffix}`;

      // No template match → generic: "Verb noun noun"
      return `${words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}${paramHint}${privateSuffix}`;
    }

    if (sym.kind === 'enum') {
      return `Enumeration of ${words.join(' ')} values`;
    }

    // Fallback: CamelCase split (same as old _inferSummaryFromName)
    return words.join(' ');
  }

  /**
   * Lazily enrich a symbol with detailed information from source code.
   * Called at query time (not scan time) to fill missing signature, summary,
   * inheritance, and class members. Results are cached in-memory.
   *
   * Cost: ~1-5ms per symbol (single disk read of ~30 lines).
   *
   * @param {object} sym - Symbol entry from the index
   * @returns {object} Enriched symbol (same object, mutated with _enriched fields)
   * @private
   */
  _enrichSymbol(sym) {
    if (sym._enriched) return sym;
    sym._enriched = true;

    // Preserve original scan-time signature so _writeOutput() serializes the
    // stable scan value, not the enriched (potentially overwritten) version.
    sym._originalSignature = sym.signature || '';

    const ext = path.extname(sym.file);
    // Read a window of source lines: 5 lines before (for comments) + 30 lines after
    const lines = this._readSourceLines(sym.file, Math.max(1, sym.line - 5), 40);
    if (lines.length === 0) return sym;

    // The declaration line is approximately at index 5 (since we started 5 lines before)
    const declOffset = Math.min(5, sym.line - 1);
    const declLine = lines[declOffset] || '';

    // ── 1. Full Signature (replace truncated 40-char version) ──
    // For classes: extract constructor parameters (not the class declaration itself)
    // to distinguish from function signatures.
    if (!sym.signature || sym.signature.length >= 39) {
      if (sym.kind === 'class' || sym.kind === 'interface') {
        // For class-like symbols, look for constructor signature in the body
        const ctorSig = this._extractConstructorSignature(lines.slice(declOffset), ext);
        if (ctorSig) {
          sym._constructorSignature = ctorSig; // separate field for class constructor
        }
        // Class-level signature: the declaration line itself (e.g. "class Foo extends Bar")
        const classDeclSig = this._extractClassDeclSignature(declLine, ext);
        if (classDeclSig) sym.signature = classDeclSig;
      } else {
        const fullSig = this._extractFullSignature(lines.slice(declOffset), ext);
        if (fullSig) sym.signature = fullSig;
      }
    }

    // ── 2. Inheritance / Extends ──
    if (sym.kind === 'class' || sym.kind === 'interface' || sym.kind === 'enum') {
      sym._extends = this._extractInheritance(declLine, ext);

      // Go struct embedding: look for indented type names in body
      if (ext === '.go' && sym._extends.length === 0) {
        for (let i = declOffset + 1; i < Math.min(lines.length, declOffset + 15); i++) {
          const bodyLine = (lines[i] || '').trim();
          if (bodyLine === '}') break;
          // Embedded type: just a type name on its own line (e.g. "  BaseStruct")
          const embedMatch = bodyLine.match(/^(\*?[A-Z]\w+)$/);
          if (embedMatch) sym._extends.push(embedMatch[1]);
        }
      }

      // ── 3. Class Members Summary ──
      const members = this._extractClassMembers(lines.slice(declOffset + 1), ext);
      sym._fields = members.fields;
      sym._methods = members.methods;
    }

    // ── 4. Inferred Summary (when no doc comment was found) ──
    if (!sym.summary) {
      // First try: look for inline comment on declaration line
      const inlineComment = declLine.match(/\/\/\s*(.+)$/) || declLine.match(/--\s*(.+)$/);
      if (inlineComment) {
        sym.summary = inlineComment[1].trim().slice(0, 80);
      } else {
        // Second try: look for comment block in the 5 lines before declaration
        for (let i = declOffset - 1; i >= 0; i--) {
          const prev = (lines[i] || '').trim();
          if (prev.startsWith('//') || prev.startsWith('--') || prev.startsWith('#')) {
            const cleaned = prev.replace(/^[\/\/#-]+\s*/, '').trim();
            // Skip decorative separator lines (e.g. "// ─────────", "// === Foo ===", "// --- Bar ---")
            const decorChars = (cleaned.match(/[─━═\-=~*#_]/g) || []).length;
            if (decorChars > cleaned.length * 0.4) continue;
            if (cleaned && !cleaned.startsWith('<') && !cleaned.startsWith('@') && cleaned.length > 5) {
              sym.summary = cleaned.slice(0, 80);
              break;
            }
          } else if (prev.startsWith('* ') && !prev.startsWith('*/')) {
            const cleaned = prev.replace(/^\*\s*/, '').trim();
            if (cleaned && !cleaned.startsWith('@') && !cleaned.startsWith('<') && cleaned.length > 5) {
              sym.summary = cleaned.slice(0, 80);
              break;
            }
          } else if (prev === '' || prev === '{' || prev === '}') {
            continue; // skip blank lines
          } else {
            break; // non-comment, non-blank line → stop
          }
        }
        // Third try: infer from name + structural context
        if (!sym.summary) {
          const inferred = this._inferSummaryFromContext(sym);
          if (inferred) sym._inferredSummary = inferred; // mark as inferred (not authoritative)
        }
      }
    }

    return sym;
  }

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

  // ─── Incremental Cache ────────────────────────────────────────────────────

  /**
   * Load the incremental build cache from disk.
   * Returns null if no valid cache exists or format is incompatible.
   * @param {string} cachePath
   * @returns {object|null}
   */
  _loadCache(cachePath) {
    try {
      if (!fs.existsSync(cachePath)) return null;
      const raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      // Validate cache version and project root
      if (raw.version !== 1 || raw.projectRoot !== this._root) {
        console.log(`[CodeGraph] ♻️  Cache invalidated (version or root mismatch)`);
        return null;
      }
      console.log(`[CodeGraph] 📦 Cache loaded: ${Object.keys(raw.fileMtimes || {}).length} files cached`);
      return raw;
    } catch (err) {
      console.warn(`[CodeGraph] ⚠️  Cache load failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Save the incremental build cache to disk.
   * Stores: version, projectRoot, fileMtimes, symbols, callEdges, importEdges.
   * @param {string} cachePath
   * @param {string[]} files - All file absolute paths that were scanned
   */
  _saveCache(cachePath, files) {
    try {
      if (!fs.existsSync(this._outputDir)) {
        fs.mkdirSync(this._outputDir, { recursive: true });
      }

      // P1-5: Use pre-collected _fileMtimes instead of re-statting all files.
      // The build pass already stats each file during reading (incremental mtime
      // comparison, or explicit stat after read). This eliminates N extra stat
      // syscalls for large projects.
      const fileMtimes = {};
      for (const filePath of files) {
        const relPath = path.relative(this._root, filePath).replace(/\\/g, '/');
        const cached = this._fileMtimes.get(relPath);
        if (cached != null) {
          fileMtimes[relPath] = cached;
        } else {
          // Fallback: stat if somehow not recorded (shouldn't happen in normal flow)
          try {
            fileMtimes[relPath] = fs.statSync(filePath).mtimeMs;
          } catch (_) { /* skip */ }
        }
      }

      const cacheData = {
        version:     1,
        projectRoot: this._root,
        savedAt:     new Date().toISOString(),
        fileMtimes,
        symbols:     [...this._symbols.values()],
        callEdges:   Object.fromEntries(this._callEdges),
        importEdges: Object.fromEntries(this._importEdges),
      };

      fs.writeFileSync(cachePath, JSON.stringify(cacheData), 'utf-8');
      console.log(`[CodeGraph] 💾 Cache saved: ${Object.keys(fileMtimes).length} files`);
    } catch (err) {
      // If it's a string length error, try streaming write
      if (err.message && err.message.includes('Invalid string length')) {
        try {
          console.log(`[CodeGraph] ⚠️  Cache too large for single stringify, using streaming write...`);
          this._writeJsonStreaming(cachePath, cacheData);
          console.log(`[CodeGraph] 💾 Cache saved (streamed): ${Object.keys(fileMtimes).length} files`);
          return;
        } catch (streamErr) {
          console.warn(`[CodeGraph] ⚠️  Cache streaming write also failed: ${streamErr.message}`);
        }
      }
      console.warn(`[CodeGraph] ⚠️  Cache save failed: ${err.message}`);
    }
  }

  /**
   * Restore symbols, call edges and import edges from cache, excluding
   * files that have been removed or changed (those will be re-processed).
   *
   * @param {object} cache - The loaded cache object
   * @param {string[]} removedFiles - Relative paths of files that no longer exist
   * @param {string[]} changedFilesFull - Absolute paths of files that changed
   */
  _restoreFromCache(cache, removedFiles, changedFilesFull) {
    const excludeSet = new Set([
      ...removedFiles,
      ...changedFilesFull.map(f => path.relative(this._root, f).replace(/\\/g, '/')),
    ]);

    // Restore symbols for unchanged files
    for (const sym of (cache.symbols || [])) {
      if (!excludeSet.has(sym.file)) {
        this._symbols.set(sym.id, sym);
      }
    }

    // Restore call edges for unchanged files
    for (const [symId, callees] of Object.entries(cache.callEdges || {})) {
      const file = symId.split('::')[0];
      if (!excludeSet.has(file)) {
        this._callEdges.set(symId, callees);
      }
    }

    // Restore import edges for unchanged files
    for (const [relPath, imports] of Object.entries(cache.importEdges || {})) {
      if (!excludeSet.has(relPath)) {
        this._importEdges.set(relPath, imports);
      }
    }

    console.log(`[CodeGraph] ♻️  Restored from cache: ${this._symbols.size} symbols, ${this._callEdges.size} call edges`);
  }

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
        this._extractImports(content, relPath, ext);
        // P1: Cache word tokens (Set<string>) – much lighter than full content
        tokenCache.set(relPath, new Set(content.match(/\b\w+\b/g) || []));
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

  /**
   * Update the .code-graph-cache.json file's fileMtimes entries for a set of
   * patched files. This ensures subsequent quickScan calls do not re-detect
   * the same files as changed.
   *
   * This is a lightweight partial update – reads the cache, patches only the
   * affected mtime entries, and writes back. Much cheaper than _saveCache()
   * which rebuilds the entire cache including all symbols/callEdges/importEdges.
   *
   * @param {Set<string>} patchedRelPaths - Set of relative paths that were patched
   * @private
   */
  _patchCacheMtimes(patchedRelPaths) {
    const cachePath = path.join(this._outputDir, '.code-graph-cache.json');
    try {
      if (!fs.existsSync(cachePath)) return;
      const raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      if (raw.version !== 1 || !raw.fileMtimes) return;

      let updated = 0;
      for (const relPath of patchedRelPaths) {
        const absPath = path.join(this._root, relPath);
        try {
          const stat = fs.statSync(absPath);
          raw.fileMtimes[relPath] = stat.mtimeMs;
          updated++;
        } catch (_) {
          // File was deleted – remove from cache
          delete raw.fileMtimes[relPath];
          updated++;
        }
      }

      if (updated > 0) {
        raw.savedAt = new Date().toISOString();
        fs.writeFileSync(cachePath, JSON.stringify(raw), 'utf-8');
      }
    } catch (err) {
      // Non-fatal: cache mtime patch failure just means next quickScan
      // may re-detect the same files, which is safe (just slightly slower).
      console.warn(`[CodeGraph] ⚠️  Cache mtime patch failed (non-fatal): ${err.message}`);
    }
  }

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

  // ─── Output Writers ───────────────────────────────────────────────────────

  /**
   * Write a large JSON object to disk in chunks, avoiding the Node.js
   * "Invalid string length" error that occurs when JSON.stringify() produces
   * a string > ~512MB.
   *
   * Strategy: serialize each top-level key separately and write them one by one
   * into a file stream. Arrays (symbols, filePaths, hotspots) are written
   * element-by-element to keep each stringify call small.
   *
   * @param {string} filePath - Absolute path to write
   * @param {object} data     - The JSON object to serialize
   * @private
   */
  _writeJsonStreaming(filePath, data) {
    const fd = fs.openSync(filePath, 'w');
    try {
      fs.writeSync(fd, '{');
      const keys = Object.keys(data);
      for (let ki = 0; ki < keys.length; ki++) {
        const key = keys[ki];
        const val = data[key];
        // Write the key
        fs.writeSync(fd, `${ki > 0 ? ',' : ''}${JSON.stringify(key)}:`);

        if (Array.isArray(val)) {
          // Stream array elements one by one
          fs.writeSync(fd, '[');
          for (let i = 0; i < val.length; i++) {
            if (i > 0) fs.writeSync(fd, ',');
            fs.writeSync(fd, JSON.stringify(val[i]));
          }
          fs.writeSync(fd, ']');
        } else if (val && typeof val === 'object' && !Array.isArray(val)) {
          // For objects (callEdges, importEdges, fileMtimes, etc.), stream entries
          const entries = Object.entries(val);
          if (entries.length > 1000) {
            // Large object: stream entries
            fs.writeSync(fd, '{');
            for (let i = 0; i < entries.length; i++) {
              if (i > 0) fs.writeSync(fd, ',');
              fs.writeSync(fd, `${JSON.stringify(entries[i][0])}:${JSON.stringify(entries[i][1])}`);
            }
            fs.writeSync(fd, '}');
          } else {
            // Small object: single stringify is fine
            fs.writeSync(fd, JSON.stringify(val));
          }
        } else {
          // Primitives (version, generatedAt, projectRoot, symbolCount, etc.)
          fs.writeSync(fd, JSON.stringify(val));
        }
      }
      fs.writeSync(fd, '}');
    } finally {
      fs.closeSync(fd);
    }
  }

  _writeOutput() {
    try {
      if (!fs.existsSync(this._outputDir)) {
        fs.mkdirSync(this._outputDir, { recursive: true });
      }

      // Write JSON index (with hotspot data)
      const jsonPath = path.join(this._outputDir, 'code-graph.json');
      const hotspots = this.getHotspots({ topN: 30 });
      const stats = this.getCategoryStats();

      // ── Path Dictionary Compression (v2 format) ────────────────────────────
      // Extracts all unique file paths into a dictionary array. Symbols, call
      // edges, import edges and hotspots reference paths by numeric index.
      // This eliminates massive path string duplication in the JSON output,
      // reducing file size by ~70% for large projects (e.g. 120MB → ~35MB).
      //
      // Memory format is unchanged – compression only affects the disk format.
      // _loadFromDisk() detects version:2 and expands indices back to full paths.

      // Step 1: Collect all unique file paths and build path→index mapping
      const pathSet = new Set();
      for (const sym of this._symbols.values()) {
        pathSet.add(sym.file);
      }
      for (const filePath of this._importEdges.keys()) {
        pathSet.add(filePath);
      }
      const filePaths = [...pathSet];
      const pathToIdx = new Map();
      for (let i = 0; i < filePaths.length; i++) {
        pathToIdx.set(filePaths[i], i);
      }

      // Step 2: Compress symbols – replace file path with index, drop redundant id field
      // Original: { id: "path::name", kind, name, file: "path", line, signature, summary }
      // Compact:  { f: <pathIdx>, k: kind, n: name, l: line, s?: signature, m?: summary }
      const compactSymbols = [];
      for (const sym of this._symbols.values()) {
        const entry = {
          f: pathToIdx.get(sym.file),
          k: sym.kind,
          n: sym.name,
          l: sym.line,
        };
        // Only include non-empty optional fields to save space
        // Use _originalSignature if available (preserves scan-time value, not
        // enrichment-modified value) to keep the persisted data stable.
        const sig = sym._enriched ? (sym._originalSignature || '') : (sym.signature || '');
        if (sig) entry.s = sig;
        if (sym.summary)   entry.m = sym.summary;
        // P0: Persist importance weight (only for non-zero to save space)
        const w = this._computeImportanceWeights().get(sym.id) || 0;
        if (w > 0.01) entry.w = Math.round(w * 1000) / 1000; // 3 decimal precision
        compactSymbols.push(entry);
      }

      // Step 3: Compress callEdges – replace full symbolId with "pathIdx::name"
      // Original key:   "Assets/Scripts/Foo.cs::Bar"  →  "42::Bar"
      // Original value:  ["Assets/Scripts/Baz.cs::Qux"]  →  ["17::Qux"]
      const compressId = (symbolId) => {
        const sepIdx = symbolId.indexOf('::');
        if (sepIdx === -1) return symbolId; // fallback: no :: separator
        const filePath = symbolId.substring(0, sepIdx);
        const symName  = symbolId.substring(sepIdx + 2);
        const idx = pathToIdx.get(filePath);
        return idx !== undefined ? `${idx}::${symName}` : symbolId;
      };

      const compactCallEdges = {};
      for (const [callerId, callees] of this._callEdges) {
        compactCallEdges[compressId(callerId)] = callees.map(compressId);
      }

      // Step 4: Compress importEdges – keys are file paths (use index directly)
      const compactImportEdges = {};
      for (const [filePath, imports] of this._importEdges) {
        const idx = pathToIdx.get(filePath);
        const key = idx !== undefined ? String(idx) : filePath;
        compactImportEdges[key] = imports;
      }

      // Step 5: Compress hotspots
      const compactHotspots = hotspots.map(h => ({
        f:  pathToIdx.get(h.symbol.file),
        n:  h.symbol.name,
        k:  h.symbol.kind,
        l:  h.symbol.line,
        cb: h.calledByCount,
        co: h.callsOutCount,
        c:  h.category,
      }));

      const graphData = {
        version:       2,                     // v2 = path dictionary format
        generatedAt:   new Date().toISOString(),
        projectRoot:   this._root,
        symbolCount:   this._symbols.size,
        filePaths,                            // path dictionary: index → full path
        symbols:       compactSymbols,
        callEdges:     compactCallEdges,
        importEdges:   compactImportEdges,
        hotspots:      compactHotspots,
        categoryStats: stats,
      };

      // P0 optimisation: write compact JSON (no pretty-print).
      // P0 fix: Use streaming write for large projects to avoid "Invalid string length"
      // error when JSON.stringify exceeds Node.js ~512MB string limit.
      // For small projects (< 50K symbols), use fast single-pass stringify.
      // For large projects, write JSON in chunks via a write stream.
      if (this._symbols.size < 50000) {
        fs.writeFileSync(jsonPath, JSON.stringify(graphData), 'utf-8');
      } else {
        this._writeJsonStreaming(jsonPath, graphData);
      }

      // P1: invalidate process-level cache so next _loadFromDisk() re-reads the new data
      _processCache.delete(jsonPath);

      // Write Markdown summary
      const mdPath = path.join(this._outputDir, 'code-graph.md');
      fs.writeFileSync(mdPath, this.toMarkdown(), 'utf-8');

      // Auto-generate Chinese translation (non-blocking)
      translateMdFile(mdPath, this._llmCall).catch(() => {});

      console.log(`[CodeGraph] 📄 Written: ${jsonPath} (v2 path-dictionary format, ${filePaths.length} unique paths)`);
      return jsonPath;
    } catch (err) {
      // If the error is "Invalid string length" (Node.js ~512MB limit),
      // fall back to streaming write which bypasses the limit entirely.
      if (err.message && err.message.includes('Invalid string length')) {
        try {
          console.log(`[CodeGraph] ⚠️  JSON too large for single stringify (${this._symbols.size} symbols), falling back to streaming write...`);
          const jsonPath = path.join(this._outputDir, 'code-graph.json');
          this._writeJsonStreaming(jsonPath, graphData);
          _processCache.delete(jsonPath);
          // Still write markdown (usually much smaller)
          const mdPath = path.join(this._outputDir, 'code-graph.md');
          fs.writeFileSync(mdPath, this.toMarkdown(), 'utf-8');
          translateMdFile(mdPath, this._llmCall).catch(() => {});
          console.log(`[CodeGraph] 📄 Written (streamed): ${jsonPath}`);
          return jsonPath;
        } catch (streamErr) {
          console.warn(`[CodeGraph] ❌ Streaming write also failed: ${streamErr.message}`);
          return null;
        }
      }
      console.warn(`[CodeGraph] Failed to write output: ${err.message}`);
      return null;
    }
  }
}

module.exports = { CodeGraph, SymbolKind };
