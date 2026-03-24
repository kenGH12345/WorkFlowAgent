/**
 * LSP Adapter – Language Server Protocol integration via MCP.
 *
 * Bridges a language server process (e.g. typescript-language-server, pyright,
 * rust-analyzer) to expose compiler-accurate code intelligence:
 *
 *   - gotoDefinition(file, line, col)   → exact definition location
 *   - findReferences(file, line, col)   → all reference locations
 *   - getHover(file, line, col)         → type info / documentation
 *   - getDocumentSymbols(file)          → all symbols in a file (compiler-accurate)
 *   - getCompletions(file, line, col)   → auto-complete suggestions
 *   - getDiagnostics(file)              → compiler errors/warnings
 *
 * Architecture:
 *   1. On connect(), spawns a language server as a child process
 *   2. Communicates via JSON-RPC 2.0 over stdio (LSP standard)
 *   3. Manages LSP lifecycle: initialize → initialized → open/query → shutdown
 *   4. Can enhance CodeGraph with compiler-accurate symbol & call data
 *
 * Supported language servers (auto-detected or configured):
 *   - TypeScript/JavaScript: typescript-language-server (tsserver backend)
 *   - Python: pyright or pylsp
 *   - Rust: rust-analyzer
 *   - Go: gopls
 *   - C#: omnisharp
 *
 * Usage:
 *   const adapter = new LSPAdapter({ projectRoot: '/path/to/project' });
 *   await adapter.connect();
 *   const def = await adapter.gotoDefinition('src/index.ts', 10, 5);
 *   const refs = await adapter.findReferences('src/index.ts', 10, 5);
 *   await adapter.disconnect();
 */

'use strict';

const { MCPAdapter } = require('./base');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { shouldSkipLSPAdapter } = require('../../core/ide-detection');

// ─── LSP Message Codec ────────────────────────────────────────────────────────

/**
 * Encodes/decodes LSP JSON-RPC 2.0 messages with Content-Length headers.
 */
class LSPCodec {
  constructor() {
    this._buffer = Buffer.alloc(0);
    this._contentLength = -1;
    /** @type {Function[]} */
    this._listeners = [];
  }

  /** Register a listener for decoded messages */
  onMessage(fn) {
    this._listeners.push(fn);
  }

  /** Feed raw bytes from the LSP server's stdout */
  feed(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    this._tryParse();
  }

  /** Encode a JSON-RPC message to an LSP wire-format Buffer */
  static encode(msg) {
    const json = JSON.stringify(msg);
    const len = Buffer.byteLength(json, 'utf-8');
    return Buffer.from(`Content-Length: ${len}\r\n\r\n${json}`, 'utf-8');
  }

  // ── Private ─────────────────────────────────────────────────────────────

  _tryParse() {
    while (true) {
      if (this._contentLength === -1) {
        // Look for header boundary
        const headerEnd = this._buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        const header = this._buffer.slice(0, headerEnd).toString('utf-8');
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          // Skip malformed header
          this._buffer = this._buffer.slice(headerEnd + 4);
          continue;
        }
        this._contentLength = parseInt(match[1], 10);
        this._buffer = this._buffer.slice(headerEnd + 4);
      }

      if (this._buffer.length < this._contentLength) return;

      const body = this._buffer.slice(0, this._contentLength).toString('utf-8');
      this._buffer = this._buffer.slice(this._contentLength);
      this._contentLength = -1;

      try {
        const msg = JSON.parse(body);
        for (const fn of this._listeners) fn(msg);
      } catch (err) {
        console.warn(`[LSPAdapter] Failed to parse LSP message: ${err.message}`);
      }
    }
  }
}

// ─── Language Server Configurations ───────────────────────────────────────────

const LSP_SERVERS = {
  typescript: {
    command: 'typescript-language-server',
    args: ['--stdio'],
    languages: ['.ts', '.tsx', '.js', '.jsx'],
    installHint: 'npm install -g typescript-language-server typescript',
  },
  pyright: {
    command: 'pyright-langserver',
    args: ['--stdio'],
    languages: ['.py'],
    installHint: 'npm install -g pyright',
  },
  pylsp: {
    command: 'pylsp',
    args: [],
    languages: ['.py'],
    installHint: 'pip install python-lsp-server',
  },
  gopls: {
    command: 'gopls',
    args: ['serve'],
    languages: ['.go'],
    installHint: 'go install golang.org/x/tools/gopls@latest',
  },
  'rust-analyzer': {
    command: 'rust-analyzer',
    args: [],
    languages: ['.rs'],
    installHint: 'rustup component add rust-analyzer',
  },
  omnisharp: {
    command: 'OmniSharp',
    args: ['--languageserver'],
    languages: ['.cs'],
    installHint: 'dotnet tool install -g omnisharp',
  },
};

// ─── LSP Adapter ──────────────────────────────────────────────────────────────

class LSPAdapter extends MCPAdapter {
  /**
   * @param {object} config
   * @param {string}  config.projectRoot - Project root directory (used as LSP rootUri)
   * @param {string}  [config.server]    - LSP server name ('typescript'|'pyright'|'gopls'|...)
   *                                        If not set, auto-detected from project files.
   * @param {string}  [config.command]   - Custom LSP server command (overrides server preset)
   * @param {string[]} [config.args]     - Custom LSP server args
   * @param {number}  [config.timeout]   - Request timeout in ms (default: 30000)
   * @param {boolean} [config.autoDetect] - Auto-detect server from project files (default: true)
   */
  constructor(config = {}) {
    super('lsp', config);
    this.projectRoot = config.projectRoot || process.cwd();
    this.timeout = config.timeout || 30000;
    this.autoDetect = config.autoDetect !== false;

    /** @type {import('child_process').ChildProcess|null} */
    this._process = null;
    /** @type {LSPCodec|null} */
    this._codec = null;
    /** @type {number} */
    this._requestId = 0;
    /** @type {Map<number, {resolve:Function, reject:Function, timer:NodeJS.Timeout}>} */
    this._pendingRequests = new Map();
    /** @type {Map<string, Array>} uri → diagnostics */
    this._diagnostics = new Map();
    /** @type {Set<string>} URIs of files we have opened via textDocument/didOpen */
    this._openFiles = new Set();
    /** @type {object|null} Server capabilities from initialize response */
    this.serverCapabilities = null;
    /** @type {string|null} Resolved server name */
    this.serverName = config.server || null;
    /** @type {string|null} */
    this._serverCommand = config.command || null;
    /** @type {string[]} */
    this._serverArgs = config.args || [];
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  async connect() {
    if (this._connected) return;

    // ── IDE-First: Skip self-spawned LSP when IDE already provides one ────
    // When running inside an IDE (Cursor, VS Code, etc.), the IDE already has
    // a running language server with full project initialization. Spawning a
    // second language server is wasteful and can cause conflicts.
    // The AI Agent can use IDE's built-in LSP via view_code_item, codebase_search, etc.
    if (shouldSkipLSPAdapter()) {
      console.log(`[LSPAdapter] 🏠 IDE environment detected – skipping self-spawned LSP.`);
      console.log(`[LSPAdapter]    IDE already provides LSP capabilities (definition, references, hover, symbols).`);
      console.log(`[LSPAdapter]    Agent should use IDE tools: view_code_item, codebase_search, grep_search.`);
      console.log(`[LSPAdapter]    CodeGraph regex-based indexing remains available as fallback.`);
      this._skippedForIDE = true;
      return; // Do NOT spawn – IDE's LSP is superior
    }

    // Step 1: Resolve which LSP server to use
    const serverConfig = this._resolveServer();
    if (!serverConfig) {
      // Graceful no-op when auto-enabled but no server is installed.
      // This allows LSP to be default-on without breaking projects that
      // don't have a language server binary on PATH.
      console.log(`[LSPAdapter] No suitable language server found for: ${this.projectRoot}`);
      console.log(`[LSPAdapter] 💡 Install a language server for compiler-accurate code intelligence:`);
      for (const [name, cfg] of Object.entries(LSP_SERVERS)) {
        console.log(`     ${name}: ${cfg.installHint}`);
      }
      console.log(`[LSPAdapter] Skipping LSP – CodeGraph will use regex-based symbol indexing (still functional).`);
      return; // Do NOT throw – adapter stays disconnected but pipeline continues
    }

    const { command, args, name } = serverConfig;
    this.serverName = name;
    console.log(`[LSPAdapter] Starting language server: ${command} ${args.join(' ')}`);

    // Step 2: Spawn LSP server process
    try {
      this._process = spawn(command, args, {
        cwd: this.projectRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
        // Shell mode on Windows for .cmd/.bat executables
        shell: process.platform === 'win32',
      });
    } catch (err) {
      throw new Error(`[LSPAdapter] Failed to spawn "${command}": ${err.message}. Install: ${LSP_SERVERS[name]?.installHint || 'check PATH'}`);
    }

    // Step 3: Wire up stdio codec
    this._codec = new LSPCodec();
    this._codec.onMessage(msg => this._handleMessage(msg));
    this._process.stdout.on('data', chunk => this._codec.feed(chunk));
    this._process.stderr.on('data', chunk => {
      const text = chunk.toString().trim();
      if (text) console.warn(`[LSPAdapter:stderr] ${text.slice(0, 200)}`);
    });
    this._process.on('exit', (code) => {
      console.log(`[LSPAdapter] Server process exited (code: ${code}).`);
      this._connected = false;
      // Reject all pending requests
      for (const [id, pending] of this._pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`LSP server exited (code: ${code})`));
      }
      this._pendingRequests.clear();
    });
    this._process.on('error', (err) => {
      console.error(`[LSPAdapter] Server process error: ${err.message}`);
    });

    // Step 4: LSP Initialize handshake
    const rootUri = `file://${this.projectRoot.replace(/\\/g, '/')}`;
    const initResult = await this._sendRequest('initialize', {
      processId: process.pid,
      rootUri,
      rootPath: this.projectRoot,
      capabilities: {
        textDocument: {
          synchronization: { openClose: true, change: 1 /* Full */ },
          completion: { completionItem: { snippetSupport: false } },
          hover: { contentFormat: ['plaintext', 'markdown'] },
          definition: { linkSupport: false },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: { relatedInformation: true },
        },
        workspace: {
          workspaceFolders: true,
        },
      },
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.projectRoot) }],
    });

    this.serverCapabilities = initResult.capabilities || {};

    // Step 5: Send 'initialized' notification
    this._sendNotification('initialized', {});

    this._connected = true;
    console.log(`[LSPAdapter] ✅ Connected to ${name} (${command}).`);
    console.log(`[LSPAdapter]    Capabilities: ${this._summarizeCapabilities()}`);
  }

  async disconnect() {
    if (!this._connected || !this._process) return;

    try {
      // Close all open files
      for (const uri of this._openFiles) {
        this._sendNotification('textDocument/didClose', { textDocument: { uri } });
      }
      this._openFiles.clear();

      // Send shutdown request
      await this._sendRequest('shutdown', null, 5000);
      // Send exit notification
      this._sendNotification('exit', null);
    } catch (err) {
      console.warn(`[LSPAdapter] Graceful shutdown failed: ${err.message}`);
    }

    // Force kill after 3s
    const proc = this._process;
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 3000);

    this._process = null;
    this._connected = false;
    this._pendingRequests.clear();
    console.log(`[LSPAdapter] Disconnected.`);
  }

  // ─── Public API: Code Intelligence ──────────────────────────────────────

  /**
   * Go to the definition of a symbol at the given position.
   * @param {string} filePath - Absolute or project-relative file path
   * @param {number} line     - 0-based line number
   * @param {number} col      - 0-based column number
   * @returns {Promise<Array<{uri:string, range:{start:{line:number,character:number},end:{line:number,character:number}}}>>}
   */
  async gotoDefinition(filePath, line, col) {
    this._assertConnected();
    const uri = this._toUri(filePath);
    await this._ensureFileOpen(uri);

    const result = await this._sendRequest('textDocument/definition', {
      textDocument: { uri },
      position: { line, character: col },
    });

    return this._normalizeLocations(result);
  }

  /**
   * Find all references to the symbol at the given position.
   * @param {string} filePath
   * @param {number} line     - 0-based
   * @param {number} col      - 0-based
   * @param {boolean} [includeDeclaration=true]
   */
  async findReferences(filePath, line, col, includeDeclaration = true) {
    this._assertConnected();
    const uri = this._toUri(filePath);
    await this._ensureFileOpen(uri);

    const result = await this._sendRequest('textDocument/references', {
      textDocument: { uri },
      position: { line, character: col },
      context: { includeDeclaration },
    });

    return this._normalizeLocations(result);
  }

  /**
   * Get hover information (type, docs) for the symbol at position.
   * @param {string} filePath
   * @param {number} line
   * @param {number} col
   * @returns {Promise<{contents:string, range?:object}|null>}
   */
  async getHover(filePath, line, col) {
    this._assertConnected();
    const uri = this._toUri(filePath);
    await this._ensureFileOpen(uri);

    const result = await this._sendRequest('textDocument/hover', {
      textDocument: { uri },
      position: { line, character: col },
    });

    if (!result) return null;
    return {
      contents: this._extractHoverContent(result.contents),
      range: result.range || null,
    };
  }

  /**
   * Get all symbols defined in a file (compiler-accurate).
   * @param {string} filePath
   * @returns {Promise<Array<{name:string, kind:number, kindName:string, range:object, selectionRange:object, children?:Array}>>}
   */
  async getDocumentSymbols(filePath) {
    this._assertConnected();
    const uri = this._toUri(filePath);
    await this._ensureFileOpen(uri);

    const result = await this._sendRequest('textDocument/documentSymbol', {
      textDocument: { uri },
    });

    if (!result) return [];
    return this._normalizeSymbols(result);
  }

  /**
   * Get auto-complete suggestions at position.
   * @param {string} filePath
   * @param {number} line
   * @param {number} col
   * @returns {Promise<Array<{label:string, kind:number, detail?:string, documentation?:string}>>}
   */
  async getCompletions(filePath, line, col) {
    this._assertConnected();
    const uri = this._toUri(filePath);
    await this._ensureFileOpen(uri);

    const result = await this._sendRequest('textDocument/completion', {
      textDocument: { uri },
      position: { line, character: col },
    });

    if (!result) return [];
    const items = Array.isArray(result) ? result : (result.items || []);
    return items.map(item => ({
      label: item.label,
      kind: item.kind,
      detail: item.detail || '',
      documentation: this._extractDocumentation(item.documentation),
    }));
  }

  /**
   * Get diagnostics (errors/warnings) for a file.
   * Note: Diagnostics are pushed from the server asynchronously. This method
   * returns the last known diagnostics for the file.
   * @param {string} filePath
   * @returns {Array<{range:object, severity:number, message:string, source:string}>}
   */
  getDiagnostics(filePath) {
    const uri = this._toUri(filePath);
    return this._diagnostics.get(uri) || [];
  }

  /**
   * Enhance a CodeGraph instance with LSP-accurate data.
   *
   * Two-phase enhancement:
   *   Phase 1: Replace regex-based symbols with compiler-accurate document symbols.
   *   Phase 2 (Hybrid Strategy): For hotspot symbols (high calledBy count), use
   *     findReferences() to replace regex-based call edges with compiler-accurate
   *     edges. This eliminates false positives from word-frequency matching while
   *     keeping build time acceptable (~15-30s for top 100-200 hotspots).
   *
   * @param {object} codeGraph  - CodeGraph instance
   * @param {object} [opts]
   * @param {number} [opts.maxFiles=50]         - Max files to process via LSP (Phase 1)
   * @param {string[]} [opts.extensions]        - File extensions to process
   * @param {boolean} [opts.enhanceCallEdges=true] - Enable Phase 2 call edge enhancement
   * @param {number} [opts.maxHotspots=150]     - Max hotspot symbols to enhance with findReferences
   * @param {number} [opts.minCalledBy=2]       - Min calledBy count to qualify as hotspot
   * @returns {Promise<{enhanced:number, total:number, callEdgesEnhanced:number}>}
   */
  async enhanceCodeGraph(codeGraph, opts = {}) {
    this._assertConnected();
    const maxFiles = opts.maxFiles || 50;
    const extensions = opts.extensions || this._getSupportedExtensions();
    const enhanceCallEdges = opts.enhanceCallEdges !== false;
    const maxHotspots = opts.maxHotspots || 150;
    const minCalledBy = opts.minCalledBy || 2;

    // Get files from CodeGraph's import edges (these are the indexed files)
    const allFiles = [];
    if (codeGraph._importEdges) {
      for (const file of codeGraph._importEdges.keys()) {
        const ext = path.extname(file);
        if (extensions.includes(ext)) allFiles.push(file);
      }
    }
    // Also check symbols
    if (allFiles.length === 0 && codeGraph._symbols) {
      const fileSet = new Set();
      for (const sym of codeGraph._symbols.values()) {
        if (sym.file && !fileSet.has(sym.file)) {
          const ext = path.extname(sym.file);
          if (extensions.includes(ext)) { fileSet.add(sym.file); allFiles.push(sym.file); }
        }
      }
    }

    const filesToProcess = allFiles.slice(0, maxFiles);
    let enhanced = 0;

    // ── Phase 1: Replace regex-based symbols with LSP-accurate document symbols ──
    console.log(`[LSPAdapter] Phase 1: Enhancing symbols for ${filesToProcess.length}/${allFiles.length} files...`);

    for (const relFile of filesToProcess) {
      try {
        const absPath = path.join(codeGraph._root || this.projectRoot, relFile);
        if (!fs.existsSync(absPath)) continue;

        const symbols = await this.getDocumentSymbols(absPath);
        if (symbols.length === 0) continue;

        // Replace regex-based symbols for this file with LSP-accurate ones
        const existingIds = [];
        for (const [id, sym] of codeGraph._symbols) {
          if (sym.file === relFile) existingIds.push(id);
        }
        for (const id of existingIds) codeGraph._symbols.delete(id);

        // Add LSP symbols
        this._flattenSymbolsIntoCodeGraph(symbols, relFile, codeGraph);
        enhanced++;
      } catch (err) {
        // Non-fatal: skip files that fail
        console.warn(`[LSPAdapter] Failed to get symbols for ${relFile}: ${err.message}`);
      }
    }

    console.log(`[LSPAdapter] ✅ Phase 1: Enhanced ${enhanced}/${filesToProcess.length} files with compiler-accurate symbols.`);

    // ── Phase 2: Hybrid Call Edge Enhancement ────────────────────────────────
    // For hotspot symbols (most-referenced), use findReferences() to get
    // compiler-accurate call edges, replacing the regex-based word-frequency edges.
    // This is the key quality improvement: Agent queries on hotspot symbols get
    // precise calls/calledBy data instead of noisy false positives.
    let callEdgesEnhanced = 0;

    if (enhanceCallEdges && this.serverCapabilities?.referencesProvider) {
      try {
        // Get hotspot symbols from CodeGraph (sorted by calledBy count desc)
        const { CodeGraph } = require('../../core/code-graph');
        const hotspots = codeGraph.getHotspots
          ? codeGraph.getHotspots({ topN: maxHotspots * 2, includeNoisy: false })
          : [];

        // Filter to hotspots with supported extensions and sufficient calledBy
        const candidates = hotspots.filter(h => {
          if (h.calledByCount < minCalledBy) return false;
          const ext = path.extname(h.symbol.file);
          return extensions.includes(ext);
        }).slice(0, maxHotspots);

        if (candidates.length > 0) {
          console.log(`[LSPAdapter] Phase 2: Enhancing call edges for ${candidates.length} hotspot symbols via findReferences...`);
          const startTime = Date.now();

          // Build a reverse lookup: file → line → symbolId for mapping LSP references back to symbols
          const fileLineToSymbol = new Map();
          for (const sym of codeGraph._symbols.values()) {
            const key = `${sym.file}:${sym.line}`;
            fileLineToSymbol.set(key, sym.id);
          }
          // Also build file → [symbols] for range-based matching
          const fileToSymbols = new Map();
          for (const sym of codeGraph._symbols.values()) {
            if (!fileToSymbols.has(sym.file)) fileToSymbols.set(sym.file, []);
            fileToSymbols.get(sym.file).push(sym);
          }

          for (const hotspot of candidates) {
            try {
              const sym = hotspot.symbol;
              const absPath = path.join(codeGraph._root || this.projectRoot, sym.file);
              if (!fs.existsSync(absPath)) continue;

              // findReferences needs 0-based line/col; sym.line is 1-based
              const refs = await this.findReferences(absPath, sym.line - 1, 0, false);
              if (!refs || refs.length === 0) continue;

              // Map each reference location back to a known symbol in CodeGraph
              const callers = new Set();
              for (const ref of refs) {
                const refFilePath = ref.filePath
                  ? path.relative(codeGraph._root || this.projectRoot, ref.filePath).replace(/\\/g, '/')
                  : null;
                if (!refFilePath) continue;

                // Find which symbol contains this reference line
                const refLine = ref.range ? ref.range.start.line + 1 : 0; // 0-based → 1-based
                const fileSyms = fileToSymbols.get(refFilePath) || [];

                // Find the closest enclosing symbol (symbol whose line is closest before refLine)
                let bestMatch = null;
                let bestDist = Infinity;
                for (const fs of fileSyms) {
                  if (fs.line <= refLine) {
                    const dist = refLine - fs.line;
                    if (dist < bestDist) {
                      bestDist = dist;
                      bestMatch = fs;
                    }
                  }
                }

                if (bestMatch && bestMatch.id !== sym.id) {
                  callers.add(bestMatch.id);
                }
              }

              if (callers.size > 0) {
                // Update calledBy: for each caller, ensure sym.id is in their callEdges
                for (const callerId of callers) {
                  const existing = codeGraph._callEdges.get(callerId) || [];
                  if (!existing.includes(sym.id)) {
                    codeGraph._callEdges.set(callerId, [...existing, sym.id]);
                  }
                }

                // Replace the current symbol's outgoing edges with LSP-verified ones
                // (only if LSP found meaningful data; keep regex edges if LSP returned empty)
                // Note: findReferences gives us who CALLS this symbol (calledBy),
                // not what this symbol calls (calls). So we update calledBy edges only.
                callEdgesEnhanced++;
              }
            } catch (refErr) {
              // Non-fatal: skip symbols that fail (e.g. LSP timeout for complex symbols)
              // Don't warn for every failure – it's expected for some symbol types
            }
          }

          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`[LSPAdapter] ✅ Phase 2: Enhanced call edges for ${callEdgesEnhanced}/${candidates.length} hotspot symbols (${elapsed}s).`);
        }
      } catch (phase2Err) {
        // Phase 2 is entirely optional – don't fail the whole enhancement
        console.warn(`[LSPAdapter] ⚠️  Phase 2 call edge enhancement failed (non-fatal): ${phase2Err.message}`);
      }
    }

    return { enhanced, total: filesToProcess.length, callEdgesEnhanced };
  }

  // ─── MCP Unified Interface ──────────────────────────────────────────────

  async query(queryStr, params = {}) {
    this._assertConnected();

    const action = params.action || 'definition';
    const file = params.file || queryStr;
    const line = params.line || 0;
    const col = params.col || params.column || 0;

    switch (action) {
      case 'definition':   return this.gotoDefinition(file, line, col);
      case 'references':   return this.findReferences(file, line, col);
      case 'hover':        return this.getHover(file, line, col);
      case 'symbols':      return this.getDocumentSymbols(file);
      case 'completions':  return this.getCompletions(file, line, col);
      case 'diagnostics':  return this.getDiagnostics(file);
      default:
        throw new Error(`[LSPAdapter] Unknown action: ${action}`);
    }
  }

  async notify(event, payload) {
    if (!this._connected) return;
    // Forward as LSP notification if applicable
    if (event === 'fileChanged' && payload.filePath) {
      const uri = this._toUri(payload.filePath);
      if (this._openFiles.has(uri)) {
        const content = fs.readFileSync(payload.filePath, 'utf-8');
        this._sendNotification('textDocument/didChange', {
          textDocument: { uri, version: Date.now() },
          contentChanges: [{ text: content }],
        });
      }
    }
  }

  // ─── Private: Server Resolution ─────────────────────────────────────────

  _resolveServer() {
    // Priority 1: Explicit command override
    if (this._serverCommand) {
      return { command: this._serverCommand, args: this._serverArgs, name: 'custom' };
    }

    // Priority 2: Explicit server name
    if (this.serverName && LSP_SERVERS[this.serverName]) {
      const cfg = LSP_SERVERS[this.serverName];
      if (this._isCommandAvailable(cfg.command)) {
        return { command: cfg.command, args: cfg.args, name: this.serverName };
      }
      console.warn(`[LSPAdapter] Server "${this.serverName}" not found in PATH. ${cfg.installHint}`);
      return null;
    }

    // Priority 3: Auto-detect from project files
    if (this.autoDetect) {
      return this._autoDetectServer();
    }

    return null;
  }

  _autoDetectServer() {
    const root = this.projectRoot;

    // TypeScript / JavaScript (most common for this project)
    if (fs.existsSync(path.join(root, 'tsconfig.json')) ||
        fs.existsSync(path.join(root, 'package.json')) ||
        fs.existsSync(path.join(root, 'jsconfig.json'))) {
      if (this._isCommandAvailable('typescript-language-server')) {
        return { command: 'typescript-language-server', args: ['--stdio'], name: 'typescript' };
      }
    }

    // Python
    if (fs.existsSync(path.join(root, 'pyproject.toml')) ||
        fs.existsSync(path.join(root, 'requirements.txt')) ||
        fs.existsSync(path.join(root, 'setup.py'))) {
      if (this._isCommandAvailable('pyright-langserver')) {
        return { command: 'pyright-langserver', args: ['--stdio'], name: 'pyright' };
      }
      if (this._isCommandAvailable('pylsp')) {
        return { command: 'pylsp', args: [], name: 'pylsp' };
      }
    }

    // Go
    if (fs.existsSync(path.join(root, 'go.mod'))) {
      if (this._isCommandAvailable('gopls')) {
        return { command: 'gopls', args: ['serve'], name: 'gopls' };
      }
    }

    // Rust
    if (fs.existsSync(path.join(root, 'Cargo.toml'))) {
      if (this._isCommandAvailable('rust-analyzer')) {
        return { command: 'rust-analyzer', args: [], name: 'rust-analyzer' };
      }
    }

    // C#
    if (fs.existsSync(path.join(root, '*.csproj')) || fs.existsSync(path.join(root, '*.sln'))) {
      if (this._isCommandAvailable('OmniSharp')) {
        return { command: 'OmniSharp', args: ['--languageserver'], name: 'omnisharp' };
      }
    }

    return null;
  }

  _isCommandAvailable(command) {
    try {
      const { execSync } = require('child_process');
      const cmd = process.platform === 'win32' ? `where ${command}` : `which ${command}`;
      execSync(cmd, { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch (_) {
      return false;
    }
  }

  _getSupportedExtensions() {
    if (this.serverName && LSP_SERVERS[this.serverName]) {
      return LSP_SERVERS[this.serverName].languages;
    }
    return ['.ts', '.tsx', '.js', '.jsx']; // Default to JS/TS
  }

  // ─── Private: JSON-RPC Transport ────────────────────────────────────────

  _sendRequest(method, params, timeoutOverride) {
    return new Promise((resolve, reject) => {
      if (!this._process || !this._process.stdin.writable) {
        return reject(new Error(`[LSPAdapter] Server process not available.`));
      }

      const id = ++this._requestId;
      const msg = { jsonrpc: '2.0', id, method, params };
      const timeout = timeoutOverride || this.timeout;

      const timer = setTimeout(() => {
        this._pendingRequests.delete(id);
        reject(new Error(`[LSPAdapter] Request "${method}" timed out after ${timeout}ms`));
      }, timeout);

      this._pendingRequests.set(id, { resolve, reject, timer });
      this._process.stdin.write(LSPCodec.encode(msg));
    });
  }

  _sendNotification(method, params) {
    if (!this._process || !this._process.stdin.writable) return;
    const msg = { jsonrpc: '2.0', method, params };
    this._process.stdin.write(LSPCodec.encode(msg));
  }

  _handleMessage(msg) {
    // Response to a request
    if (msg.id !== undefined && this._pendingRequests.has(msg.id)) {
      const { resolve, reject, timer } = this._pendingRequests.get(msg.id);
      clearTimeout(timer);
      this._pendingRequests.delete(msg.id);

      if (msg.error) {
        reject(new Error(`LSP error (${msg.error.code}): ${msg.error.message}`));
      } else {
        resolve(msg.result);
      }
      return;
    }

    // Server notification (e.g. diagnostics, log)
    if (msg.method) {
      this._handleNotification(msg.method, msg.params);
    }
  }

  _handleNotification(method, params) {
    switch (method) {
      case 'textDocument/publishDiagnostics':
        if (params && params.uri) {
          this._diagnostics.set(params.uri, params.diagnostics || []);
        }
        break;
      case 'window/logMessage':
      case 'window/showMessage':
        // Optionally log server messages at debug level
        if (params && params.message) {
          const level = params.type <= 1 ? 'error' : params.type === 2 ? 'warn' : 'log';
          console[level](`[LSPAdapter:server] ${params.message.slice(0, 200)}`);
        }
        break;
      // Silently ignore other notifications
    }
  }

  // ─── Private: File Management ───────────────────────────────────────────

  _toUri(filePath) {
    const abs = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.projectRoot, filePath);
    // Normalise to forward slashes for URI
    return `file:///${abs.replace(/\\/g, '/').replace(/^\//, '')}`;
  }

  _fromUri(uri) {
    if (uri.startsWith('file:///')) {
      let p = uri.slice(8); // Remove file:///
      if (process.platform === 'win32' && /^[a-zA-Z]:/.test(p)) {
        // Windows: file:///C:/path → C:/path
      } else {
        p = '/' + p; // Unix: file:///home → /home
      }
      return p.replace(/\//g, path.sep);
    }
    return uri;
  }

  async _ensureFileOpen(uri) {
    if (this._openFiles.has(uri)) return;

    const filePath = this._fromUri(uri);
    if (!fs.existsSync(filePath)) return;

    const content = fs.readFileSync(filePath, 'utf-8');
    const ext = path.extname(filePath);
    const languageId = this._extToLanguageId(ext);

    this._sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text: content,
      },
    });
    this._openFiles.add(uri);
  }

  _extToLanguageId(ext) {
    const map = {
      '.ts': 'typescript', '.tsx': 'typescriptreact',
      '.js': 'javascript', '.jsx': 'javascriptreact',
      '.py': 'python', '.go': 'go', '.rs': 'rust', '.cs': 'csharp',
      '.lua': 'lua', '.dart': 'dart',
    };
    return map[ext] || 'plaintext';
  }

  // ─── Private: Response Normalization ────────────────────────────────────

  _normalizeLocations(result) {
    if (!result) return [];
    const items = Array.isArray(result) ? result : [result];
    return items.map(loc => {
      if (loc.targetUri) {
        // LocationLink format
        return {
          uri: loc.targetUri,
          filePath: this._fromUri(loc.targetUri),
          range: loc.targetRange || loc.targetSelectionRange,
        };
      }
      // Location format
      return {
        uri: loc.uri,
        filePath: this._fromUri(loc.uri),
        range: loc.range,
      };
    }).filter(loc => loc.uri);
  }

  /** LSP SymbolKind enum → human-readable name */
  static _symbolKindName(kind) {
    const names = [
      '', 'File', 'Module', 'Namespace', 'Package', 'Class', 'Method',
      'Property', 'Field', 'Constructor', 'Enum', 'Interface', 'Function',
      'Variable', 'Constant', 'String', 'Number', 'Boolean', 'Array',
      'Object', 'Key', 'Null', 'EnumMember', 'Struct', 'Event',
      'Operator', 'TypeParameter',
    ];
    return names[kind] || `Kind(${kind})`;
  }

  _normalizeSymbols(result) {
    if (!result) return [];
    // Can be DocumentSymbol[] (hierarchical) or SymbolInformation[] (flat)
    return result.map(sym => {
      const base = {
        name: sym.name,
        kind: sym.kind,
        kindName: LSPAdapter._symbolKindName(sym.kind),
        detail: sym.detail || '',
      };
      if (sym.range) {
        // DocumentSymbol format (hierarchical)
        base.range = sym.range;
        base.selectionRange = sym.selectionRange;
        if (sym.children) {
          base.children = this._normalizeSymbols(sym.children);
        }
      } else if (sym.location) {
        // SymbolInformation format (flat)
        base.range = sym.location.range;
        base.uri = sym.location.uri;
        base.filePath = this._fromUri(sym.location.uri);
      }
      return base;
    });
  }

  _extractHoverContent(contents) {
    if (!contents) return '';
    if (typeof contents === 'string') return contents;
    if (contents.value) return contents.value; // MarkupContent
    if (Array.isArray(contents)) {
      return contents.map(c => typeof c === 'string' ? c : c.value || '').join('\n');
    }
    return JSON.stringify(contents);
  }

  _extractDocumentation(doc) {
    if (!doc) return '';
    if (typeof doc === 'string') return doc;
    if (doc.value) return doc.value;
    return '';
  }

  // ─── Private: CodeGraph Integration ─────────────────────────────────────

  /**
   * Flatten LSP hierarchical document symbols into CodeGraph's flat Map.
   */
  _flattenSymbolsIntoCodeGraph(symbols, relFile, codeGraph, parentName = '') {
    const kindMap = {
      5: 'class', 6: 'method', 7: 'property', 10: 'enum',
      11: 'interface', 12: 'function', 13: 'property', 14: 'property',
      23: 'class', // Struct
    };

    for (const sym of symbols) {
      const kind = kindMap[sym.kind] || 'function';
      const name = parentName ? `${parentName}.${sym.name}` : sym.name;
      const id = `${relFile}::${sym.name}`;
      const line = sym.range ? sym.range.start.line + 1 : 0; // LSP is 0-based, CodeGraph is 1-based

      if (!codeGraph._symbols.has(id)) {
        codeGraph._symbols.set(id, {
          id, kind, name: sym.name, file: relFile, line,
          signature: sym.detail || '', summary: `[LSP:${sym.kindName}]`,
        });
      }

      // Recurse into children
      if (sym.children && sym.children.length > 0) {
        this._flattenSymbolsIntoCodeGraph(sym.children, relFile, codeGraph, sym.name);
      }
    }
  }

  _summarizeCapabilities() {
    if (!this.serverCapabilities) return 'none';
    const caps = [];
    if (this.serverCapabilities.definitionProvider) caps.push('definition');
    if (this.serverCapabilities.referencesProvider) caps.push('references');
    if (this.serverCapabilities.hoverProvider) caps.push('hover');
    if (this.serverCapabilities.documentSymbolProvider) caps.push('documentSymbol');
    if (this.serverCapabilities.completionProvider) caps.push('completion');
    if (this.serverCapabilities.diagnosticProvider || this.serverCapabilities.textDocumentSync) caps.push('diagnostics');
    return caps.join(', ') || 'basic';
  }

  _assertConnected() {
    if (!this._connected) throw new Error(`[LSPAdapter] Not connected. Call connect() first.`);
  }
}

module.exports = { LSPAdapter, LSPCodec, LSP_SERVERS };
