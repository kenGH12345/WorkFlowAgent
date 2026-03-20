/**
 * Code Graph – Language Parsers Mixin (P2-A)
 *
 * Extracted from code-graph.js to reduce the 3592-line god file.
 * Contains all language-specific symbol extraction, doc comment parsing,
 * and import/call edge extraction logic.
 *
 * Supported languages: JS/TS, C#, Lua, Go, Python, Dart
 *
 * These methods are mixed into CodeGraph.prototype via Object.assign,
 * so all `this._symbols`, `this._callEdges`, etc. references resolve correctly.
 *
 * @module code-graph-parsers
 */

'use strict';

const path = require('path');

// SymbolKind is re-declared here as a convenience constant to avoid circular require.
// The canonical definition is in code-graph.js; these values are identical.
const SymbolKind = {
  CLASS:     'class',
  FUNCTION:  'function',
  METHOD:    'method',
  MODULE:    'module',
  INTERFACE: 'interface',
  ENUM:      'enum',
  PROPERTY:  'property',
};

// ─── Parser Mixin ─────────────────────────────────────────────────────────────

const CodeGraphParsersMixin = {

  // ─── Symbol Extraction (dispatcher) ───────────────────────────────────────

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
  },

  _addSymbol(kind, name, file, line, signature = '', summary = '') {
    const id = `${file}::${name}`;
    if (!this._symbols.has(id)) {
      this._symbols.set(id, { id, kind, name, file, line, signature, summary });
    }
  },

  // ─── JavaScript / TypeScript ──────────────────────────────────────────────

  _extractJsSymbols(lines, file) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const classMatch = line.match(/^(?:export\s+)?class\s+(\w+)/);
      if (classMatch) {
        const summary = this._extractJsDocSummary(lines, i);
        this._addSymbol(SymbolKind.CLASS, classMatch[1], file, i + 1, '', summary);
        continue;
      }
      const fnMatch = line.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/);
      if (fnMatch) {
        const summary = this._extractJsDocSummary(lines, i);
        this._addSymbol(SymbolKind.FUNCTION, fnMatch[1], file, i + 1, fnMatch[2].slice(0, 40), summary);
        continue;
      }
      const arrowMatch = line.match(/^(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(?([^)]*)\)?\s*=>/);
      if (arrowMatch) {
        const summary = this._extractJsDocSummary(lines, i);
        this._addSymbol(SymbolKind.FUNCTION, arrowMatch[1], file, i + 1, arrowMatch[2].slice(0, 40), summary);
        continue;
      }
      const methodMatch = line.match(/^(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*\{/);
      if (methodMatch && !['if', 'for', 'while', 'switch', 'catch'].includes(methodMatch[1])) {
        const summary = this._extractJsDocSummary(lines, i);
        this._addSymbol(SymbolKind.METHOD, methodMatch[1], file, i + 1, methodMatch[2].slice(0, 40), summary);
      }
    }
  },

  // ─── C# ───────────────────────────────────────────────────────────────────

  _extractCsSymbols(lines, file) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const typeMatch = line.match(/^(?:public|internal|protected|private)?\s*(?:abstract|sealed|static|partial)?\s*(?:abstract|sealed|static|partial)?\s*(class|struct|interface|enum)\s+(\w+)/);
      if (typeMatch) {
        const summary = this._extractXmlDocSummary(lines, i);
        this._addSymbol(typeMatch[1] === 'interface' ? SymbolKind.INTERFACE : typeMatch[1] === 'enum' ? SymbolKind.ENUM : SymbolKind.CLASS, typeMatch[2], file, i + 1, '', summary);
        continue;
      }
      const methodMatch = line.match(/^public\s+(?:static\s+|override\s+|virtual\s+|async\s+)*([\w<>\[\]?,\s]+?)\s+(\w+)\s*\(([^)]*)\)/);
      if (methodMatch) {
        const name = methodMatch[2];
        if (!['if', 'while', 'for', 'foreach', 'switch', 'using', 'return'].includes(name)) {
          const summary = this._extractXmlDocSummary(lines, i);
          this._addSymbol(SymbolKind.METHOD, name, file, i + 1, methodMatch[3].slice(0, 40), summary);
        }
      }
    }
  },

  // ─── Lua ──────────────────────────────────────────────────────────────────

  _extractLuaSymbols(lines, file) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('--')) continue;
      const fnMatch = line.match(/^function\s+([\w.:]+)\s*\(([^)]*)\)/);
      if (fnMatch) {
        const summary = this._extractLuaCommentSummary(lines, i);
        this._addSymbol(SymbolKind.FUNCTION, fnMatch[1], file, i + 1, fnMatch[2].slice(0, 40), summary);
        continue;
      }
      const classMatch = line.match(/^(?:local\s+)?(\w+)\s*=\s*(?:class\s*\(|BaseClass\s*\(|\{\})/);
      if (classMatch && classMatch[1].length > 1 && classMatch[1] !== '_') {
        this._addSymbol(SymbolKind.MODULE, classMatch[1], file, i + 1, '', '');
      }
    }
  },

  // ─── Go ───────────────────────────────────────────────────────────────────

  _extractGoSymbols(lines, file) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const typeMatch = line.match(/^type\s+(\w+)\s+(struct|interface)/);
      if (typeMatch) {
        this._addSymbol(typeMatch[2] === 'interface' ? SymbolKind.INTERFACE : SymbolKind.CLASS, typeMatch[1], file, i + 1, '', '');
        continue;
      }
      const fnMatch = line.match(/^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(([^)]*)\)/);
      if (fnMatch) {
        const summary = this._extractGoDocSummary(lines, i);
        this._addSymbol(SymbolKind.FUNCTION, fnMatch[1], file, i + 1, fnMatch[2].slice(0, 40), summary);
      }
    }
  },

  // ─── Python ───────────────────────────────────────────────────────────────

  _extractPySymbols(lines, file) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const classMatch = trimmed.match(/^class\s+(\w+)/);
      if (classMatch) {
        this._addSymbol(SymbolKind.CLASS, classMatch[1], file, i + 1, '', '');
        continue;
      }
      const fnMatch = trimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/);
      if (fnMatch) {
        const summary = this._extractPyDocSummary(lines, i);
        this._addSymbol(SymbolKind.FUNCTION, fnMatch[1], file, i + 1, fnMatch[2].slice(0, 40), summary);
      }
    }
  },

  // ─── Dart ─────────────────────────────────────────────────────────────────

  _extractDartSymbols(lines, file) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const classMatch = line.match(/^(?:abstract\s+)?class\s+(\w+)/);
      if (classMatch) {
        const summary = this._extractDartDocSummary(lines, i);
        this._addSymbol(SymbolKind.CLASS, classMatch[1], file, i + 1, '', summary);
        continue;
      }
      const fnMatch = line.match(/^(?:[\w<>?]+\s+)+(\w+)\s*\(([^)]*)\)\s*(?:async\s*)?\{/);
      if (fnMatch && !['if', 'for', 'while', 'switch'].includes(fnMatch[1])) {
        const summary = this._extractDartDocSummary(lines, i);
        this._addSymbol(SymbolKind.FUNCTION, fnMatch[1], file, i + 1, fnMatch[2].slice(0, 40), summary);
      }
    }
  },

  // ─── Comment/Doc Summary Extractors ───────────────────────────────────────

  /** JSDoc: /** ... *\/ */
  _extractJsDocSummary(lines, fnLine) {
    for (let i = fnLine - 1; i >= Math.max(0, fnLine - 8); i--) {
      const line = lines[i].trim();
      if (line.startsWith('* ') || line.startsWith('*/')) {
        const descMatch = line.match(/^\*\s+([^@].+)/);
        if (descMatch) return descMatch[1].trim().slice(0, 80);
      }
    }
    return '';
  },

  /** C# XML: /// <summary>...</summary> */
  _extractXmlDocSummary(lines, fnLine) {
    for (let i = fnLine - 1; i >= Math.max(0, fnLine - 5); i--) {
      const line = lines[i].trim();
      const match = line.match(/\/\/\/\s*<summary>\s*(.+?)\s*(?:<\/summary>)?$/);
      if (match) return match[1].trim().slice(0, 80);
      const match2 = line.match(/\/\/\/\s+(.+)/);
      if (match2 && !match2[1].startsWith('<')) return match2[1].trim().slice(0, 80);
    }
    return '';
  },

  /** Lua: -- comment above function */
  _extractLuaCommentSummary(lines, fnLine) {
    if (fnLine > 0) {
      const prev = lines[fnLine - 1].trim();
      const match = prev.match(/^--+\s*(.+)/);
      if (match) return match[1].trim().slice(0, 80);
    }
    return '';
  },

  /** Go: // comment above func */
  _extractGoDocSummary(lines, fnLine) {
    for (let i = fnLine - 1; i >= Math.max(0, fnLine - 5); i--) {
      const line = lines[i].trim();
      const match = line.match(/^\/\/\s+(.+)/);
      if (match) return match[1].trim().slice(0, 80);
      if (!line.startsWith('//')) break;
    }
    return '';
  },

  /** Python: \"\"\"docstring\"\"\" on next line */
  _extractPyDocSummary(lines, fnLine) {
    if (fnLine + 1 < lines.length) {
      const next = lines[fnLine + 1].trim();
      const match = next.match(/^"""(.+?)"""$|^'''(.+?)'''$|^"""(.+)/);
      if (match) return (match[1] || match[2] || match[3]).trim().slice(0, 80);
    }
    return '';
  },

  /** Dart: /// doc comment */
  _extractDartDocSummary(lines, fnLine) {
    for (let i = fnLine - 1; i >= Math.max(0, fnLine - 8); i--) {
      const line = lines[i].trim();
      const match = line.match(/^\/\/\/\s+(.+)/);
      if (match) {
        const text = match[1].trim();
        if (text && !text.startsWith('@') && !text.startsWith('[') && text.length > 3) {
          return text.slice(0, 80);
        }
      }
      const commentMatch = line.match(/^\/\/\s+(.+)/);
      if (commentMatch && !line.startsWith('///')) {
        const text = commentMatch[1].trim();
        if (text && text.length > 5) return text.slice(0, 80);
      }
      if (line && !line.startsWith('//') && !line.startsWith('@') && line !== '') break;
    }
    return '';
  },

  // ─── Import/Call Edge Extraction ──────────────────────────────────────────

  _extractImports(content, relPath, ext) {
    const imports = [];
    if (ext === '.js' || ext === '.ts') {
      const matches = content.matchAll(/require\(['"]([^'"]+)['"]\)|import\s+.*?from\s+['"]([^'"]+)['"]/g);
      for (const m of matches) {
        const dep = m[1] || m[2];
        if (dep && !dep.startsWith('.')) continue;
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
  },

  _extractCallEdges(content, relPath, ext, preExtractedTokens) {
    const fileSymbols = this.getFileSymbols(relPath);
    if (fileSymbols.length === 0) return;

    const nameToId = new Map();
    for (const sym of this._symbols.values()) {
      const existing = nameToId.get(sym.name);
      if (!existing || sym.file === relPath) {
        nameToId.set(sym.name, sym.id);
      }
    }

    const wordTokens = preExtractedTokens || new Set(content.match(/\b\w+\b/g) || []);

    const fileSymbolNames = new Set(fileSymbols.map(s => s.name));
    for (const sym of fileSymbols) {
      const calls = [];
      for (const token of wordTokens) {
        if (token === sym.name) continue;
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
  },
};

module.exports = { CodeGraphParsersMixin, SymbolKind };
