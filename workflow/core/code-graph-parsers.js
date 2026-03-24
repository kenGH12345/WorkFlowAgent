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

// SymbolKind: single source of truth in code-graph-types.js (A-3 fix)
const { SymbolKind } = require('./code-graph-types');

// ─── Pre-Processing Utilities (P1 optimisation) ──────────────────────────────

/**
 * Strip string literals and comments from source code to prevent false-positive
 * regex matches inside quoted text or commented-out code.
 *
 * Strategy per language:
 *   - JS/TS/Go/Dart/C#: remove // line comments, /* block comments *​/, and
 *     string literals (single, double, backtick/verbatim).
 *   - Python: remove # line comments and string literals (single, double, triple-quoted).
 *   - Lua: remove -- line comments, --[[ block comments ]], and string literals.
 *
 * Preserves line count (replaces removed content with spaces on the same line,
 * and keeps newlines intact) so that line numbers remain accurate for symbol
 * extraction that follows.
 *
 * @param {string} content - Raw file content
 * @param {string} ext - File extension (e.g. '.js', '.cs')
 * @returns {string} Content with strings/comments replaced by whitespace
 */
function stripCommentsAndStrings(content, ext) {
  // Build a regex that matches all comment and string literal forms for the language.
  // We replace matched content with spaces (preserving newlines) to keep line numbers stable.
  let pattern;

  switch (ext) {
    case '.js': case '.ts':
      // Order matters: template literals, block comments, line comments, strings
      pattern = /`(?:[^`\\]|\\.)*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
      break;
    case '.cs':
      // C# verbatim strings (@"..."), interpolated ($"..."), block comments, line comments, strings
      pattern = /@"(?:[^"]|"")*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
      break;
    case '.go':
      // Go raw strings (`...`), block comments, line comments, strings
      pattern = /`[^`]*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\]|\\.)*"/g;
      break;
    case '.dart':
      // Dart triple-quoted strings, block comments, line comments, strings
      pattern = /"""[\s\S]*?"""|'''[\s\S]*?'''|\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
      break;
    case '.py':
      // Python triple-quoted strings, line comments, strings
      pattern = /"""[\s\S]*?"""|'''[\s\S]*?'''|#[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
      break;
    case '.lua':
      // Lua block comments (--[[ ... ]]), block strings ([[ ... ]]), line comments, strings
      pattern = /--\[\[[\s\S]*?\]\]|\[\[[\s\S]*?\]\]|--[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
      break;
    default:
      return content; // Unknown language: return as-is
  }

  return content.replace(pattern, (match) => {
    // Replace each character with a space, but preserve newlines
    return match.replace(/[^\n]/g, ' ');
  });
}

/**
 * Join multi-line declarations by detecting unclosed parentheses.
 *
 * When a line contains an opening parenthesis `(` but no matching `)`,
 * subsequent lines are concatenated (with a space separator) until the
 * parentheses balance out. This allows regex patterns to match function
 * signatures that span multiple lines.
 *
 * Returns an array of { text, originalLine } objects so callers can map
 * back to the correct source line number.
 *
 * @param {string[]} lines - Source lines (already stripped of comments/strings)
 * @returns {Array<{ text: string, originalLine: number }>}
 */
function joinMultilineDeclarations(lines) {
  const result = [];
  let i = 0;

  while (i < lines.length) {
    let text = lines[i];
    const originalLine = i;

    // Count unbalanced parens in this line
    let depth = 0;
    for (const ch of text) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }

    // If parens are unbalanced (more opens than closes), join subsequent lines
    // Limit to 5 continuation lines to avoid runaway joins on malformed code
    let joined = 0;
    while (depth > 0 && i + 1 < lines.length && joined < 5) {
      i++;
      joined++;
      const nextLine = lines[i].trim();
      text += ' ' + nextLine;
      for (const ch of nextLine) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
      }
    }

    result.push({ text: text.trim(), originalLine });
    i++;
  }

  return result;
}

/**
 * Determine the indentation level of a line (number of leading spaces/tabs).
 * Tabs count as 4 spaces for consistency.
 *
 * @param {string} rawLine - The original (untrimmed) source line
 * @returns {number} Indentation level in equivalent spaces
 */
function getIndentLevel(rawLine) {
  let indent = 0;
  for (const ch of rawLine) {
    if (ch === ' ') indent++;
    else if (ch === '\t') indent += 4;
    else break;
  }
  return indent;
}

// ─── Parser Mixin ─────────────────────────────────────────────────────────────

const CodeGraphParsersMixin = {

  // ─── Symbol Extraction (dispatcher) ───────────────────────────────────────

  _extractSymbols(content, relPath, ext) {
    // P1: Pre-process content to strip comments and string literals,
    // preventing false-positive matches inside quoted/commented-out code.
    const stripped = stripCommentsAndStrings(content, ext);
    const lines = stripped.split('\n');
    // Keep original lines for indentation detection (stripped lines preserve whitespace structure)
    const originalLines = content.split('\n');
    switch (ext) {
      case '.js': case '.ts': this._extractJsSymbols(lines, relPath, originalLines); break;
      case '.cs':             this._extractCsSymbols(lines, relPath, originalLines); break;
      case '.lua':            this._extractLuaSymbols(lines, relPath); break;
      case '.go':             this._extractGoSymbols(lines, relPath); break;
      case '.py':             this._extractPySymbols(lines, relPath, originalLines); break;
      case '.dart':           this._extractDartSymbols(lines, relPath, originalLines); break;
    }
  },

  _addSymbol(kind, name, file, line, signature = '', summary = '') {
    const id = `${file}::${name}`;
    if (!this._symbols.has(id)) {
      this._symbols.set(id, { id, kind, name, file, line, signature, summary });
    }
  },

  // ─── JavaScript / TypeScript ──────────────────────────────────────────────

  _extractJsSymbols(lines, file, originalLines) {
    // P1: Join multi-line declarations so regex can match signatures spanning multiple lines
    const joined = joinMultilineDeclarations(lines);
    // Use original lines for doc comment extraction (comments are stripped from `lines`)
    const rawLines = originalLines || lines;

    for (const { text: line, originalLine: idx } of joined) {
      const trimmed = line.trim ? line.trim() : line;
      // P1: Indentation-aware filtering — skip deeply nested declarations (indent > 8 spaces)
      // to reduce false positives from inner classes, nested functions inside callbacks, etc.
      // Top-level and first-level nesting (class methods) are always kept.
      const indent = originalLines ? getIndentLevel(originalLines[idx] || '') : 0;

      const classMatch = trimmed.match(/^(?:export\s+)?class\s+(\w+)/);
      if (classMatch) {
        // Classes: only skip if very deeply nested (indent > 12)
        if (indent <= 12) {
          const summary = this._extractJsDocSummary(rawLines, idx);
          this._addSymbol(SymbolKind.CLASS, classMatch[1], file, idx + 1, '', summary);
        }
        continue;
      }
      const fnMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/);
      if (fnMatch) {
        if (indent <= 8) {
          const summary = this._extractJsDocSummary(rawLines, idx);
          this._addSymbol(SymbolKind.FUNCTION, fnMatch[1], file, idx + 1, fnMatch[2].slice(0, 40), summary);
        }
        continue;
      }
      const arrowMatch = trimmed.match(/^(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(?([^)]*)\)?\s*=>/);
      if (arrowMatch) {
        if (indent <= 8) {
          const summary = this._extractJsDocSummary(rawLines, idx);
          this._addSymbol(SymbolKind.FUNCTION, arrowMatch[1], file, idx + 1, arrowMatch[2].slice(0, 40), summary);
        }
        continue;
      }
      const methodMatch = trimmed.match(/^(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*\{/);
      if (methodMatch && !['if', 'for', 'while', 'switch', 'catch'].includes(methodMatch[1])) {
        // Methods: allow slightly deeper nesting (class methods are typically indented)
        if (indent <= 12) {
          const summary = this._extractJsDocSummary(rawLines, idx);
          this._addSymbol(SymbolKind.METHOD, methodMatch[1], file, idx + 1, methodMatch[2].slice(0, 40), summary);
        }
      }
    }
  },

  // ─── C# ───────────────────────────────────────────────────────────────────

  _extractCsSymbols(lines, file, originalLines) {
    // P1: Join multi-line declarations for C# method signatures
    const joined = joinMultilineDeclarations(lines);
    const rawLines = originalLines || lines;

    for (const { text: line, originalLine: idx } of joined) {
      const trimmed = line.trim ? line.trim() : line;
      const indent = originalLines ? getIndentLevel(originalLines[idx] || '') : 0;

      const typeMatch = trimmed.match(/^(?:public|internal|protected|private)?\s*(?:abstract|sealed|static|partial)?\s*(?:abstract|sealed|static|partial)?\s*(class|struct|interface|enum)\s+(\w+)/);
      if (typeMatch) {
        // Types: skip only very deeply nested (indent > 16, e.g. nested class inside nested class)
        if (indent <= 16) {
          const summary = this._extractXmlDocSummary(rawLines, idx);
          this._addSymbol(typeMatch[1] === 'interface' ? SymbolKind.INTERFACE : typeMatch[1] === 'enum' ? SymbolKind.ENUM : SymbolKind.CLASS, typeMatch[2], file, idx + 1, '', summary);
        }
        continue;
      }
      // P1: Expanded C# method regex to include ALL access modifiers (not just public).
      // Previously only matched `public` methods, causing internal/protected/private methods
      // to be completely invisible in the code graph. Now captures all accessibility levels.
      const methodMatch = trimmed.match(/^(?:public|internal|protected|private)\s+(?:static\s+|override\s+|virtual\s+|async\s+|new\s+|sealed\s+|abstract\s+)*([\w<>\[\]?,\s]+?)\s+(\w+)\s*\(([^)]*)\)/);
      if (methodMatch) {
        const name = methodMatch[2];
        if (!['if', 'while', 'for', 'foreach', 'switch', 'using', 'return'].includes(name)) {
          if (indent <= 16) {
            const summary = this._extractXmlDocSummary(rawLines, idx);
            this._addSymbol(SymbolKind.METHOD, name, file, idx + 1, methodMatch[3].slice(0, 40), summary);
          }
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

  _extractPySymbols(lines, file, originalLines) {
    // P1: Join multi-line declarations for Python function signatures
    const joined = joinMultilineDeclarations(lines);
    const rawLines = originalLines || lines;

    for (const { text, originalLine: idx } of joined) {
      const trimmed = text.trim ? text.trim() : text;
      // P1: Indentation-aware filtering for Python
      // Python uses indentation for scope, so we can reliably detect nesting depth.
      // Top-level (indent 0) and class-level (indent 4-8) symbols are always kept.
      // Deeply nested functions (indent > 8) are likely internal helpers.
      const indent = originalLines ? getIndentLevel(originalLines[idx] || '') : 0;

      const classMatch = trimmed.match(/^class\s+(\w+)/);
      if (classMatch) {
        if (indent <= 8) {
          this._addSymbol(SymbolKind.CLASS, classMatch[1], file, idx + 1, '', '');
        }
        continue;
      }
      const fnMatch = trimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/);
      if (fnMatch) {
        // Allow class methods (indent 4-8) and top-level functions (indent 0)
        if (indent <= 8) {
          const summary = this._extractPyDocSummary(rawLines, idx);
          this._addSymbol(SymbolKind.FUNCTION, fnMatch[1], file, idx + 1, fnMatch[2].slice(0, 40), summary);
        }
      }
    }
  },

  // ─── Dart ─────────────────────────────────────────────────────────────────

  _extractDartSymbols(lines, file, originalLines) {
    // P1: Join multi-line declarations for Dart
    const joined = joinMultilineDeclarations(lines);
    const rawLines = originalLines || lines;

    for (const { text: line, originalLine: idx } of joined) {
      const trimmed = line.trim ? line.trim() : line;
      const indent = originalLines ? getIndentLevel(originalLines[idx] || '') : 0;

      const classMatch = trimmed.match(/^(?:abstract\s+)?class\s+(\w+)/);
      if (classMatch) {
        if (indent <= 8) {
          const summary = this._extractDartDocSummary(rawLines, idx);
          this._addSymbol(SymbolKind.CLASS, classMatch[1], file, idx + 1, '', summary);
        }
        continue;
      }
      const fnMatch = trimmed.match(/^(?:[\w<>?]+\s+)+(\w+)\s*\(([^)]*)\)\s*(?:async\s*)?\{/);
      if (fnMatch && !['if', 'for', 'while', 'switch'].includes(fnMatch[1])) {
        if (indent <= 12) {
          const summary = this._extractDartDocSummary(rawLines, idx);
          this._addSymbol(SymbolKind.FUNCTION, fnMatch[1], file, idx + 1, fnMatch[2].slice(0, 40), summary);
        }
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
      // Also check for plain // comments (used when JSDoc block was stripped)
      if (line.startsWith('//')) {
        const match = line.match(/^\/\/\s+(.+)/);
        if (match && !match[1].startsWith('@')) return match[1].trim().slice(0, 80);
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
        // P0-3 fix: capture ALL import paths (relative, npm packages, path aliases)
        // Previously `if (!dep.startsWith('.')) continue` discarded non-relative deps,
        // causing the module graph to miss npm packages and path aliases (e.g. @app/core).
        // Now we keep everything; downstream consumers can filter if needed.
        if (dep) imports.push(dep);
      }
    } else if (ext === '.lua') {
      const matches = content.matchAll(/require\(['"]([^'"]+)['"]\)/g);
      for (const m of matches) imports.push(m[1]);
    } else if (ext === '.go') {
      // P1-4 fix: only capture Go imports from import blocks, not arbitrary quoted strings.
      // Also skip Go stdlib paths.
      const GO_STDLIB_PREFIXES = new Set([
        'fmt', 'os', 'io', 'log', 'net', 'sync', 'time', 'math', 'sort',
        'strings', 'strconv', 'bytes', 'bufio', 'path', 'regexp', 'errors',
        'context', 'crypto', 'encoding', 'html', 'text', 'testing', 'reflect',
        'runtime', 'debug', 'flag', 'archive', 'compress', 'database', 'image',
        'index', 'mime', 'plugin', 'unicode', 'unsafe', 'embed', 'go',
      ]);
      const importBlockMatch = content.match(/import\s*\(([\s\S]*?)\)/g);
      const singleImportMatch = content.matchAll(/import\s+"([^"]+)"/g);
      const allImportPaths = [];
      if (importBlockMatch) {
        for (const block of importBlockMatch) {
          const pathMatches = block.matchAll(/"([^"]+)"/g);
          for (const pm of pathMatches) allImportPaths.push(pm[1]);
        }
      }
      for (const m of singleImportMatch) allImportPaths.push(m[1]);
      for (const imp of allImportPaths) {
        const topSegment = imp.split('/')[0];
        if (!GO_STDLIB_PREFIXES.has(topSegment)) {
          imports.push(imp);
        }
      }
    } else if (ext === '.py') {
      // P1-4 fix: filter Python stdlib modules to reduce false import edges.
      const PY_STDLIB = new Set([
        'os', 'sys', 're', 'io', 'json', 'math', 'time', 'datetime', 'logging',
        'pathlib', 'collections', 'functools', 'itertools', 'typing', 'abc',
        'copy', 'shutil', 'subprocess', 'threading', 'multiprocessing',
        'unittest', 'argparse', 'dataclasses', 'enum', 'hashlib', 'hmac',
        'http', 'urllib', 'socket', 'ssl', 'email', 'html', 'xml', 'csv',
        'sqlite3', 'struct', 'pickle', 'configparser', 'secrets',
        'random', 'statistics', 'decimal', 'fractions', 'tempfile', 'glob',
        'asyncio', 'concurrent', 'signal', 'queue', 'heapq',
        'bisect', 'array', 'weakref', 'types', 'operator',
      ]);
      const matches = content.matchAll(/^(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm);
      for (const m of matches) {
        const dep = m[1] || m[2];
        const topLevel = dep.split('.')[0];
        if (!PY_STDLIB.has(topLevel)) {
          imports.push(dep);
        }
      }
    }
    if (imports.length > 0) this._importEdges.set(relPath, imports);
  },

  /**
   * P0-2 fix: Reduced false positives in call edge extraction.
   *
   * Previous approach: any word token matching a known symbol name was treated as
   * a "call" — e.g. a variable named `config` would create a false edge to every
   * symbol named `config` in the project. This produced 60-80% false positive rates.
   *
   * New approach: require function-call syntax evidence. A token is only considered
   * a call if the raw source contains `token(` (function invocation pattern). For
   * pre-extracted token sets (where raw content is unavailable), we still filter out
   * the NOISY_SYMBOL_NAMES set and require the callee to be a function/method.
   */
  _extractCallEdges(content, relPath, ext, preExtractedTokens) {
    const fileSymbols = this.getFileSymbols(relPath);
    if (fileSymbols.length === 0) return;

    // Build name → symbolId map, preferring same-file symbols
    const nameToId = new Map();
    const nameToKind = new Map();
    for (const sym of this._symbols.values()) {
      const existing = nameToId.get(sym.name);
      if (!existing || sym.file === relPath) {
        nameToId.set(sym.name, sym.id);
        nameToKind.set(sym.name, sym.kind);
      }
    }

    // P0-2: Build a Set of confirmed call tokens using function-call syntax.
    // A call requires `name(` pattern in source code (not just token presence).
    // Note: `this` is the CodeGraph instance (mixin is applied via Object.assign).
    const isNoisyName = (name) => {
      // Inline the noisy name check to avoid circular require.
      // Short names (<= 3 chars) are always noise.
      const baseName = name.includes(':') ? name.split(':').pop() : name;
      if (baseName.length <= 3) return true;
      // Use the CodeGraph static method if available (mixed-in context)
      if (this.constructor && this.constructor.isNoisyName) {
        return this.constructor.isNoisyName(name);
      }
      return false;
    };
    let confirmedCallTokens;

    if (content) {
      // When raw source is available: scan for `identifier(` patterns
      confirmedCallTokens = new Set();
      const callPattern = /\b(\w+)\s*\(/g;
      let match;
      while ((match = callPattern.exec(content)) !== null) {
        const name = match[1];
        // Skip language keywords
        if (['if', 'for', 'while', 'switch', 'catch', 'return', 'throw',
             'new', 'typeof', 'instanceof', 'function', 'class',
             'require', 'import'].includes(name)) continue;
        confirmedCallTokens.add(name);
      }
    } else if (preExtractedTokens) {
      // Fallback: when only word tokens are available (e.g. incremental build),
      // filter to only function/method symbols and exclude noisy names.
      confirmedCallTokens = new Set();
      for (const token of preExtractedTokens) {
        if (isNoisyName(token)) continue;
        const kind = nameToKind.get(token);
        // Only consider tokens that map to function/method/class symbols
        if (kind === 'function' || kind === 'method' || kind === 'class') {
          confirmedCallTokens.add(token);
        }
      }
    } else {
      return; // No source data available
    }

    for (const sym of fileSymbols) {
      const calls = [];
      for (const token of confirmedCallTokens) {
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

// ─── Standalone Functions (for Worker Threads) ─────────────────────────────────
// These are pure functions that don't depend on `this` (no CodeGraph instance).
// Used by code-graph-worker.js to avoid duplicating 250+ lines of parsing logic.
// The Mixin methods above call `this._addSymbol()` etc; these standalone versions
// return plain arrays/objects for serialization across the Worker boundary.

// Keywords to exclude from bare-function-call pattern matching (JS/TS)
const JS_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'catch', 'try',
  'return', 'throw', 'new', 'delete', 'typeof', 'instanceof', 'void',
  'with', 'break', 'continue', 'default',
]);

const JS_BARE_PATTERNS = [
  /^(?:static\s+)?(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*\{/,
];

// ─── Doc Summary Extractors (standalone) ────────────────────────────────────

function extractJsDocSummary(lines, fnLine) {
  for (let i = fnLine - 1; i >= Math.max(0, fnLine - 10); i--) {
    const line = lines[i].trim();
    const match = line.match(/^\*\s+(.+)/) || line.match(/^\/\/\s+(.+)/);
    if (match && !match[1].startsWith('@')) return match[1].trim().slice(0, 80);
    if (line === '/**' || line === '*/') continue;
    if (!line.startsWith('*') && !line.startsWith('//') && line !== '') break;
  }
  return '';
}

function extractXmlDocSummary(lines, fnLine) {
  for (let i = fnLine - 1; i >= Math.max(0, fnLine - 5); i--) {
    const line = lines[i].trim();
    const match = line.match(/<summary>\s*(.+?)\s*<\/summary>/);
    if (match) return match[1].trim().slice(0, 80);
  }
  return '';
}

function extractLuaCommentSummary(lines, fnLine) {
  for (let i = fnLine - 1; i >= Math.max(0, fnLine - 5); i--) {
    const line = lines[i].trim();
    const match = line.match(/^--\s+(.+)/);
    if (match) return match[1].trim().slice(0, 80);
    if (!line.startsWith('--')) break;
  }
  return '';
}

function extractGoDocSummary(lines, fnLine) {
  for (let i = fnLine - 1; i >= Math.max(0, fnLine - 5); i--) {
    const line = lines[i].trim();
    const match = line.match(/^\/\/\s+(.+)/);
    if (match) return match[1].trim().slice(0, 80);
    if (!line.startsWith('//')) break;
  }
  return '';
}

function extractPyDocSummary(lines, fnLine) {
  if (fnLine + 1 < lines.length) {
    const next = lines[fnLine + 1].trim();
    const match = next.match(/^"""(.+?)"""/) || next.match(/^'''(.+?)'''/) || next.match(/^"""(.+)/);
    if (match) return match[1].trim().slice(0, 80);
  }
  return '';
}

/**
 * Extract symbols from file content based on extension (standalone, no `this`).
 * Returns array of { name, kind, line, signature, summary } objects.
 *
 * P1: Now applies pre-processing (comment/string stripping, multi-line joining,
 * indentation-aware filtering) matching the Mixin methods for quality parity.
 *
 * @param {string[]} rawLines - File content split by newlines (ORIGINAL, unprocessed)
 * @param {string} ext - File extension (e.g. '.js', '.cs')
 * @param {string} [rawContent] - Original file content (for stripCommentsAndStrings)
 * @returns {Array<{ name: string, kind: string, line: number, signature: string, summary: string }>}
 */
function extractSymbolsStandalone(rawLines, ext, rawContent) {
  const results = [];
  const seen = new Set();

  function addSym(kind, name, line, signature, summary) {
    if (!name || seen.has(name)) return;
    seen.add(name);
    results.push({ name, kind, line, signature: signature || '', summary: summary || '' });
  }

  // P1: Pre-process — strip comments/strings if raw content is available
  let lines = rawLines;
  let originalLines = rawLines;
  if (rawContent) {
    const stripped = stripCommentsAndStrings(rawContent, ext);
    lines = stripped.split('\n');
    // originalLines remain the unstripped version for indentation checks
  }

  switch (ext) {
    case '.js': case '.ts': {
      // P1: Apply multi-line join
      const joined = joinMultilineDeclarations(lines);
      for (const { text: line, originalLine: idx } of joined) {
        const trimmed = typeof line === 'string' ? line.trim() : line;
        const indent = getIndentLevel(originalLines[idx] || '');

        const classMatch = trimmed.match(/^(?:export\s+)?class\s+(\w+)/);
        if (classMatch) {
          if (indent <= 12) {
            addSym(SymbolKind.CLASS, classMatch[1], idx + 1, '', extractJsDocSummary(originalLines, idx));
          }
          continue;
        }
        const itMatch = trimmed.match(/^(?:export\s+)?(?:interface|enum|type)\s+(\w+)/);
        if (itMatch) {
          if (indent <= 12) {
            addSym(SymbolKind.INTERFACE, itMatch[1], idx + 1, '', extractJsDocSummary(originalLines, idx));
          }
          continue;
        }
        const fnMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/);
        if (fnMatch) {
          if (indent <= 8) {
            addSym(SymbolKind.FUNCTION, fnMatch[1], idx + 1, fnMatch[2].slice(0, 40), extractJsDocSummary(originalLines, idx));
          }
          continue;
        }
        const arrowMatch = trimmed.match(/^(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(?([^)]*)\)?\s*=>/);
        if (arrowMatch) {
          if (indent <= 8) {
            addSym(SymbolKind.FUNCTION, arrowMatch[1], idx + 1, arrowMatch[2].slice(0, 40), extractJsDocSummary(originalLines, idx));
          }
          continue;
        }
        for (const pattern of JS_BARE_PATTERNS) {
          const match = trimmed.match(pattern);
          if (match && match[1] && !JS_KEYWORDS.has(match[1])) {
            if (indent <= 12) {
              addSym(SymbolKind.METHOD, match[1], idx + 1, (match[2] || '').slice(0, 40), '');
            }
            break;
          }
        }
      }
      break;
    }
    case '.cs': {
      // P1: Apply multi-line join + expanded method regex
      const joined = joinMultilineDeclarations(lines);
      for (const { text: line, originalLine: idx } of joined) {
        const trimmed = typeof line === 'string' ? line.trim() : line;
        const indent = getIndentLevel(originalLines[idx] || '');

        const typeMatch = trimmed.match(/^(?:public|internal|protected|private)?\s*(?:abstract|sealed|static|partial)?\s*(?:abstract|sealed|static|partial)?\s*(class|struct|interface|enum)\s+(\w+)/);
        if (typeMatch) {
          if (indent <= 16) {
            const kind = typeMatch[1] === 'interface' ? SymbolKind.INTERFACE : typeMatch[1] === 'enum' ? SymbolKind.ENUM : SymbolKind.CLASS;
            addSym(kind, typeMatch[2], idx + 1, '', extractXmlDocSummary(originalLines, idx));
          }
          continue;
        }
        // P1: Expanded regex — match ALL access modifiers, not just public
        const methodMatch = trimmed.match(/^(?:public|internal|protected|private)\s+(?:static\s+|override\s+|virtual\s+|async\s+|new\s+|sealed\s+|abstract\s+)*([\w<>\[\]?,\s]+?)\s+(\w+)\s*\(([^)]*)\)/);
        if (methodMatch && !['if', 'while', 'for', 'foreach', 'switch', 'using', 'return'].includes(methodMatch[2])) {
          if (indent <= 16) {
            addSym(SymbolKind.METHOD, methodMatch[2], idx + 1, methodMatch[3].slice(0, 40), extractXmlDocSummary(originalLines, idx));
          }
        }
      }
      break;
    }
    case '.lua': {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('--')) continue;
        const fnMatch = line.match(/^function\s+([\w.:]+)\s*\(([^)]*)\)/);
        if (fnMatch) {
          addSym(SymbolKind.FUNCTION, fnMatch[1], i + 1, fnMatch[2].slice(0, 40), extractLuaCommentSummary(originalLines, i));
          continue;
        }
        const classMatch = line.match(/^(?:local\s+)?(\w+)\s*=\s*(?:class\s*\(|BaseClass\s*\(|\{\})/);
        if (classMatch && classMatch[1].length > 1 && classMatch[1] !== '_') {
          addSym(SymbolKind.CLASS, classMatch[1], i + 1, '', '');
          continue;
        }
        const localFn = line.match(/^local\s+function\s+(\w+)\s*\(([^)]*)\)/);
        if (localFn) {
          addSym(SymbolKind.FUNCTION, localFn[1], i + 1, localFn[2].slice(0, 40), extractLuaCommentSummary(originalLines, i));
        }
      }
      break;
    }
    case '.go': {
      // P1: Apply multi-line join for Go (func signatures can span lines)
      const joined = joinMultilineDeclarations(lines);
      for (const { text: line, originalLine: idx } of joined) {
        const trimmed = typeof line === 'string' ? line.trim() : line;
        const fnMatch = trimmed.match(/^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(([^)]*)\)/);
        if (fnMatch) {
          addSym(SymbolKind.FUNCTION, fnMatch[1], idx + 1, fnMatch[2].slice(0, 40), extractGoDocSummary(originalLines, idx));
          continue;
        }
        const structMatch = trimmed.match(/^type\s+(\w+)\s+struct\s*\{/);
        if (structMatch) { addSym(SymbolKind.CLASS, structMatch[1], idx + 1, '', extractGoDocSummary(originalLines, idx)); continue; }
        const ifaceMatch = trimmed.match(/^type\s+(\w+)\s+interface\s*\{/);
        if (ifaceMatch) { addSym(SymbolKind.INTERFACE, ifaceMatch[1], idx + 1, '', extractGoDocSummary(originalLines, idx)); }
      }
      break;
    }
    case '.py': {
      // P1: Apply multi-line join + indentation-aware filtering
      const joined = joinMultilineDeclarations(lines);
      for (const { text, originalLine: idx } of joined) {
        const trimmed = typeof text === 'string' ? text.trim() : text;
        const indent = getIndentLevel(originalLines[idx] || '');

        const classMatch = trimmed.match(/^class\s+(\w+)/);
        if (classMatch) {
          if (indent <= 8) {
            addSym(SymbolKind.CLASS, classMatch[1], idx + 1, '', extractPyDocSummary(originalLines, idx));
          }
          continue;
        }
        const fnMatch = trimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/);
        if (fnMatch) {
          if (indent <= 8) {
            addSym(SymbolKind.FUNCTION, fnMatch[1], idx + 1, fnMatch[2].slice(0, 40), extractPyDocSummary(originalLines, idx));
          }
        }
      }
      break;
    }
    case '.dart': {
      // P1: Apply multi-line join + indentation-aware filtering
      const joined = joinMultilineDeclarations(lines);
      for (const { text: line, originalLine: idx } of joined) {
        const trimmed = typeof line === 'string' ? line.trim() : line;
        const indent = getIndentLevel(originalLines[idx] || '');

        const classMatch = trimmed.match(/^(?:abstract\s+)?class\s+(\w+)/);
        if (classMatch) {
          if (indent <= 8) {
            addSym(SymbolKind.CLASS, classMatch[1], idx + 1, '', '');
          }
          continue;
        }
        const fnMatch = trimmed.match(/^(?:static\s+)?(?:Future|void|String|int|double|bool|dynamic|var|\w+)\s+(\w+)\s*\(([^)]*)\)/);
        if (fnMatch) {
          if (indent <= 12) {
            addSym(SymbolKind.FUNCTION, fnMatch[1], idx + 1, fnMatch[2].slice(0, 40), '');
          }
        }
      }
      break;
    }
    default:
      return [];
  }
  return results;
}

/**
 * Extract import/require paths from content based on extension (standalone, no `this`).
 * Returns array of dependency strings.
 *
 * @param {string} content - Full file content
 * @param {string} ext - File extension
 * @returns {string[]}
 */
function extractImportPathsStandalone(content, ext) {
  const imports = [];
  if (ext === '.js' || ext === '.ts') {
    const matches = content.matchAll(/require\(['"]([^'"]+)['"]\)|import\s+.*?from\s+['"]([^'"]+)['"]/g);
    for (const m of matches) {
      const dep = m[1] || m[2];
      // P0-3 fix: capture ALL import paths (relative + npm packages + path aliases)
      if (dep) imports.push(dep);
    }
  } else if (ext === '.lua') {
    const matches = content.matchAll(/require\(['"]([^'"]+)['"]\)/g);
    for (const m of matches) imports.push(m[1]);
  } else if (ext === '.go') {
    // P1-4 fix: only parse import blocks, skip Go stdlib
    const GO_STDLIB_PREFIXES = new Set([
      'fmt', 'os', 'io', 'log', 'net', 'sync', 'time', 'math', 'sort',
      'strings', 'strconv', 'bytes', 'bufio', 'path', 'regexp', 'errors',
      'context', 'crypto', 'encoding', 'html', 'text', 'testing', 'reflect',
      'runtime', 'debug', 'flag', 'archive', 'compress', 'database', 'image',
      'index', 'mime', 'plugin', 'unicode', 'unsafe', 'embed', 'go',
    ]);
    const importBlockMatch = content.match(/import\s*\(([\s\S]*?)\)/g);
    const singleImportMatch = content.matchAll(/import\s+"([^"]+)"/g);
    const allImportPaths = [];
    if (importBlockMatch) {
      for (const block of importBlockMatch) {
        const pathMatches = block.matchAll(/"([^"]+)"/g);
        for (const pm of pathMatches) allImportPaths.push(pm[1]);
      }
    }
    for (const m of singleImportMatch) allImportPaths.push(m[1]);
    for (const imp of allImportPaths) {
      const topSegment = imp.split('/')[0];
      if (!GO_STDLIB_PREFIXES.has(topSegment)) imports.push(imp);
    }
  } else if (ext === '.py') {
    // P1-4 fix: filter Python stdlib modules
    const PY_STDLIB = new Set([
      'os', 'sys', 're', 'io', 'json', 'math', 'time', 'datetime', 'logging',
      'pathlib', 'collections', 'functools', 'itertools', 'typing', 'abc',
      'copy', 'shutil', 'subprocess', 'threading', 'multiprocessing',
      'unittest', 'argparse', 'dataclasses', 'enum', 'hashlib', 'hmac',
      'http', 'urllib', 'socket', 'ssl', 'email', 'html', 'xml', 'csv',
      'sqlite3', 'struct', 'pickle', 'configparser', 'secrets',
      'random', 'statistics', 'decimal', 'fractions', 'tempfile', 'glob',
      'asyncio', 'concurrent', 'signal', 'queue', 'heapq',
      'bisect', 'array', 'weakref', 'types', 'operator',
    ]);
    const matches = content.matchAll(/^(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm);
    for (const m of matches) {
      const dep = m[1] || m[2];
      const topLevel = dep.split('.')[0];
      if (!PY_STDLIB.has(topLevel)) imports.push(dep);
    }
  }
  return imports;
}

module.exports = {
  CodeGraphParsersMixin,
  SymbolKind,
  // Standalone functions for Worker Threads (P1-3)
  extractSymbolsStandalone,
  extractImportPathsStandalone,
  // P1: Pre-processing utilities (exported for worker thread usage)
  stripCommentsAndStrings,
  joinMultilineDeclarations,
  getIndentLevel,
};
