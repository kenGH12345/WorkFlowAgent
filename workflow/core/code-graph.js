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
const { translateMdFile } = require('./i18n-translator');

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

// ─── CodeGraph ────────────────────────────────────────────────────────────────

class CodeGraph {
  /**
   * @param {object} options
   * @param {string}   options.projectRoot  - Root directory to scan
   * @param {string}   options.outputDir    - Where to write output files
   * @param {string[]} [options.extensions] - File extensions to scan
   * @param {string[]} [options.ignoreDirs] - Directories to skip
   * @param {number}   [options.maxFiles]   - Max files to scan (token safety)
   */
  constructor({
    projectRoot,
    outputDir,
    extensions = ['.js', '.ts', '.cs', '.lua', '.go', '.py', '.dart'],
    ignoreDirs = ['node_modules', '.git', 'build', 'dist', 'output', 'Library', 'Temp', 'obj', 'Packages', '.dart_tool'],
    maxFiles   = 200,
    llmCall    = null,
  } = {}) {
    this._root       = projectRoot;
    this._outputDir  = outputDir;
    this._extensions = new Set(extensions);
    this._ignoreDirs = new Set(ignoreDirs);
    this._maxFiles   = maxFiles;
    this._llmCall    = llmCall;

    /** @type {Map<string, SymbolEntry>} symbolId → entry */
    this._symbols = new Map();
    /** @type {Map<string, string[]>} symbolId → list of called symbolIds */
    this._callEdges = new Map();
    /** @type {Map<string, string[]>} filePath → list of imported filePaths */
    this._importEdges = new Map();
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Scan the project and build the code graph.
   * @returns {{ symbolCount: number, fileCount: number, edgeCount: number, graphPath: string }}
   */
  async build() {
    console.log(`\n[CodeGraph] 🔍 Building code graph for: ${this._root}`);
    this._symbols.clear();
    this._callEdges.clear();
    this._importEdges.clear();

    const files = this._collectFiles(this._root);
    console.log(`[CodeGraph] Scanning ${files.length} files...`);

    for (const filePath of files) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const relPath = path.relative(this._root, filePath).replace(/\\/g, '/');
        const ext     = path.extname(filePath);

        this._extractSymbols(content, relPath, ext);
        this._extractImports(content, relPath, ext);
      } catch (_) { /* skip unreadable files */ }
    }

    // Build call edges (second pass – needs all symbols indexed first)
    for (const filePath of files) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const relPath = path.relative(this._root, filePath).replace(/\\/g, '/');
        const ext     = path.extname(filePath);
        this._extractCallEdges(content, relPath, ext);
      } catch (_) {}
    }

    const edgeCount = [...this._callEdges.values()].reduce((n, v) => n + v.length, 0);
    console.log(`[CodeGraph] ✅ Built: ${this._symbols.size} symbols, ${edgeCount} call edges, ${this._importEdges.size} modules`);

    const graphPath = this._writeOutput();
    return {
      symbolCount: this._symbols.size,
      fileCount:   files.length,
      edgeCount,
      graphPath,
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
    const q = query.toLowerCase();
    const results = [];
    for (const sym of this._symbols.values()) {
      if (kind && sym.kind !== kind) continue;
      if (file && !sym.file.includes(file)) continue;
      if (sym.name.toLowerCase().includes(q) ||
          sym.summary?.toLowerCase().includes(q) ||
          sym.file.toLowerCase().includes(q)) {
        results.push(sym);
        if (results.length >= limit) break;
      }
    }
    return results;
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
      if (s.signature) lines.push(`- **Signature**: \`(${s.signature})\``);
      if (s.summary)   lines.push(`- **Summary**: ${s.summary}`);
      if (result.calls.length > 0) {
        lines.push(`- **Calls**: ${result.calls.slice(0, 5).map(id => `\`${id.split('::')[1] || id}\``).join(', ')}`);
      }
      if (result.calledBy.length > 0) {
        lines.push(`- **Called by**: ${result.calledBy.slice(0, 5).map(id => `\`${id.split('::')[1] || id}\``).join(', ')}`);
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
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      this._symbols.clear();
      this._callEdges.clear();
      this._importEdges.clear();
      for (const sym of (data.symbols || [])) {
        this._symbols.set(sym.id, sym);
      }
      for (const [k, v] of Object.entries(data.callEdges || {})) {
        this._callEdges.set(k, v);
      }
      for (const [k, v] of Object.entries(data.importEdges || {})) {
        this._importEdges.set(k, v);
      }
      console.log(`[CodeGraph] 📂 Loaded from disk: ${this._symbols.size} symbols`);
    } catch (err) {
      console.warn(`[CodeGraph] Failed to load from disk: ${err.message}`);
    }
  }

  /**
   * Builds the query result object for a found symbol.
   * @private
   */
  _buildQueryResult(sym, includeCallGraph, includeFileSymbols) {
    const calls    = includeCallGraph ? (this._callEdges.get(sym.id) || []) : [];
    const calledBy = includeCallGraph ? (() => {
      const cb = [];
      for (const [callerId, callees] of this._callEdges) {
        if (callees.includes(sym.id)) cb.push(callerId);
      }
      return cb;
    })() : [];
    const fileSymbols = includeFileSymbols ? this.getFileSymbols(sym.file) : [];
    return { symbol: sym, calls, calledBy, fileSymbols };
  }

  /**
   * Returns a compact Markdown summary suitable for AGENTS.md injection.
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
      `> Query: \`/graph search <keyword>\` | \`/graph file <path>\` | \`/graph calls <symbol>\``,
      '',
    ];

    for (const [file, symbols] of byFile) {
      lines.push(`### ${file}`);
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
        this._addSymbol(SymbolKind.METHOD, methodMatch[1], file, i + 1, methodMatch[2].slice(0, 40), '');
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
        this._addSymbol(SymbolKind.CLASS, classMatch[1], file, i + 1, '', '');
        continue;
      }
      // void foo(...) / Future<T> foo(...) / String foo(...)
      const fnMatch = line.match(/^(?:[\w<>?]+\s+)+(\w+)\s*\(([^)]*)\)\s*(?:async\s*)?\{/);
      if (fnMatch && !['if', 'for', 'while', 'switch'].includes(fnMatch[1])) {
        this._addSymbol(SymbolKind.FUNCTION, fnMatch[1], file, i + 1, fnMatch[2].slice(0, 40), '');
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
      const match = next.match(/^"""(.+?)"""|^'''(.+?)'''|^"""(.+)/);
      if (match) return (match[1] || match[2] || match[3]).trim().slice(0, 80);
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

  _extractCallEdges(content, relPath, ext) {
    // For each symbol in this file, find which other known symbols it calls
    const fileSymbols = this.getFileSymbols(relPath);
    if (fileSymbols.length === 0) return;

    // Build a set of all known symbol names for fast lookup
    const allNames = new Set([...this._symbols.values()].map(s => s.name));

    for (const sym of fileSymbols) {
      const calls = [];
      // Simple heuristic: find function call patterns matching known symbol names
      for (const name of allNames) {
        if (name === sym.name) continue;
        // Match: name( or name.something( or :name(
        const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[.(:]`, 'g');
        if (pattern.test(content)) {
          const calleeId = this._findIdByName(name, relPath);
          if (calleeId) calls.push(calleeId);
        }
      }
      if (calls.length > 0) {
        this._callEdges.set(sym.id, [...new Set(calls)]);
      }
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  _findByName(name) {
    for (const sym of this._symbols.values()) {
      if (sym.name === name) return sym;
    }
    return null;
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
        if (e.isDirectory()) {
          if (!this._ignoreDirs.has(e.name)) walk(path.join(d, e.name));
        } else if (this._extensions.has(path.extname(e.name))) {
          results.push(path.join(d, e.name));
          if (results.length >= this._maxFiles) return;
        }
      }
    };
    walk(dir);
    return results;
  }

  // ─── Output Writers ───────────────────────────────────────────────────────

  _writeOutput() {
    try {
      if (!fs.existsSync(this._outputDir)) {
        fs.mkdirSync(this._outputDir, { recursive: true });
      }

      // Write JSON index
      const jsonPath = path.join(this._outputDir, 'code-graph.json');
      const graphData = {
        generatedAt:  new Date().toISOString(),
        projectRoot:  this._root,
        symbolCount:  this._symbols.size,
        symbols:      [...this._symbols.values()],
        callEdges:    Object.fromEntries(this._callEdges),
        importEdges:  Object.fromEntries(this._importEdges),
      };
      fs.writeFileSync(jsonPath, JSON.stringify(graphData, null, 2), 'utf-8');

      // Write Markdown summary
      const mdPath = path.join(this._outputDir, 'code-graph.md');
      fs.writeFileSync(mdPath, this.toMarkdown(), 'utf-8');

      // Auto-generate Chinese translation (non-blocking)
      translateMdFile(mdPath, this._llmCall).catch(() => {});

      console.log(`[CodeGraph] 📄 Written: ${jsonPath}`);
      return jsonPath;
    } catch (err) {
      console.warn(`[CodeGraph] Failed to write output: ${err.message}`);
      return null;
    }
  }
}

module.exports = { CodeGraph, SymbolKind };
