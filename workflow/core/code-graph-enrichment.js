/**
 * Code Graph – Enrichment Mixin (P1-1)
 *
 * Extracted from code-graph.js to reduce the god file.
 * Contains lazy symbol enrichment logic: reading source lines around a symbol
 * to fill in full signature, inheritance, class members, and inferred summaries.
 *
 * "Scan shallow, query deep" – during scan we only store skeleton info (name,
 * file, line). At query time we lazily read ~30 source lines around the symbol
 * to fill in missing signature, summary, and structural relationships.
 * Results are cached in-memory (never written back to JSON) so each symbol
 * is enriched at most once per process lifetime.
 *
 * These methods are mixed into CodeGraph.prototype via Object.assign,
 * so all `this._root`, `this._symbols`, etc. references resolve correctly.
 *
 * @module code-graph-enrichment
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Enrichment Mixin ─────────────────────────────────────────────────────────

const CodeGraphEnrichmentMixin = {

  /**
   * Read a small window of source lines from disk.
   * @param {string} relPath - Relative file path (as stored in symbol.file)
   * @param {number} startLine - 1-based start line
   * @param {number} count - Number of lines to read
   * @returns {string[]}
   */
  /**
   * Read a small window of source lines from disk.
   *
   * P1-2 fix: Added file-level content caching. When enriching N symbols
   * from the same file, the file is read from disk only once. The cache
   * is bounded (LRU eviction at 50 files) to avoid unbounded memory growth.
   *
   * @param {string} relPath - Relative file path
   * @param {number} startLine - 1-based line number to start from
   * @param {number} count - Number of lines to read
   * @returns {string[]}
   */
  _readSourceLines(relPath, startLine, count) {
    try {
      const absPath = path.join(this._root, relPath);

      // P1-2 fix: use per-instance file content cache
      if (!this._sourceFileCache) {
        this._sourceFileCache = new Map();
      }

      let lines = this._sourceFileCache.get(relPath);
      if (!lines) {
        if (!fs.existsSync(absPath)) return [];
        const content = fs.readFileSync(absPath, 'utf-8');
        lines = content.split('\n');

        // LRU eviction: keep at most 50 files in cache
        if (this._sourceFileCache.size >= 50) {
          const firstKey = this._sourceFileCache.keys().next().value;
          this._sourceFileCache.delete(firstKey);
        }
        this._sourceFileCache.set(relPath, lines);
      }

      const start = Math.max(0, startLine - 1);
      return lines.slice(start, start + count);
    } catch (_) {
      return [];
    }
  },

  /**
   * Infer a human-readable summary from a CamelCase / snake_case symbol name.
   * @param {string} name
   * @returns {string}
   */
  _inferSummaryFromName(name) {
    if (!name || name.length < 4) return '';
    let clean = name;
    const words = clean
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/_/g, ' ')
      .replace(/:/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 0);
    if (words.length <= 1) return '';
    return words.join(' ');
  },

  /**
   * Extract inheritance/extends info from a source line.
   * Supports: JS/TS (extends), C# (: Base, IFoo), Go (embedding), Python (class Foo(Bar)).
   *
   * @param {string} declLine - The declaration line
   * @param {string} ext - File extension
   * @returns {string[]} List of parent/interface names
   */
  _extractInheritance(declLine, ext) {
    if (!declLine) return [];
    const trimmed = declLine.trim();

    if (ext === '.js' || ext === '.ts' || ext === '.dart') {
      const m = trimmed.match(/extends\s+([\w.]+)/);
      const impl = trimmed.match(/implements\s+([\w.,\s]+)/);
      const results = [];
      if (m) results.push(m[1]);
      if (impl) results.push(...impl[1].split(',').map(s => s.trim()).filter(Boolean));
      return results;
    }
    if (ext === '.cs') {
      const m = trimmed.match(/(?:class|struct|interface)\s+\w+(?:\s*<[^>]+>)?\s*:\s*([^{]+)/);
      if (m) {
        return m[1].split(',').map(s => s.trim()).filter(s => s && !s.startsWith('where'));
      }
    }
    if (ext === '.py') {
      const m = trimmed.match(/class\s+\w+\s*\(([^)]+)\)/);
      if (m) {
        return m[1].split(',').map(s => s.trim()).filter(s => s && s !== 'object');
      }
    }
    return [];
  },

  /**
   * Extract fields and methods from a class body (first ~50 lines).
   * @param {string[]} lines - Lines starting after class declaration
   * @param {string} ext - File extension
   * @returns {{ fields: string[], methods: string[] }}
   */
  _extractClassMembers(lines, ext) {
    const fields = [];
    const methods = [];
    const maxScan = Math.min(lines.length, 50);

    for (let i = 0; i < maxScan; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) continue;

      if (ext === '.cs') {
        const fieldMatch = line.match(/^public\s+(?:static\s+)?([\w<>\[\]?,]+)\s+(\w+)\s*[{;=]/);
        if (fieldMatch && !line.includes('(')) {
          fields.push(fieldMatch[2]);
          continue;
        }
        const methodMatch = line.match(/^(?:public|protected|internal)\s+(?:static\s+|override\s+|virtual\s+|async\s+)*[\w<>\[\]?,\s]+?\s+(\w+)\s*\(/);
        if (methodMatch && !['if', 'while', 'for', 'foreach', 'switch', 'using', 'return'].includes(methodMatch[1])) {
          methods.push(methodMatch[1]);
          continue;
        }
      } else if (ext === '.js' || ext === '.ts') {
        const mMatch = line.match(/^(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/);
        if (mMatch && !['if', 'for', 'while', 'switch', 'catch', 'constructor'].includes(mMatch[1])) {
          methods.push(mMatch[1]);
          continue;
        }
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
  },

  /**
   * Extract the full function signature from source lines.
   * @param {string[]} lines - Source lines starting from the function declaration
   * @param {string} ext - File extension
   * @returns {string} Full signature
   */
  _extractFullSignature(lines, ext) {
    if (!lines || lines.length === 0) return '';
    const joined = lines.slice(0, 5).join(' ').replace(/\s+/g, ' ');
    const firstLine = (lines[0] || '').replace(/\s+/g, ' ');

    if (ext === '.cs') {
      const m = joined.match(/(?:public|private|protected|internal)\s+(?:static\s+|override\s+|virtual\s+|async\s+)*([\w<>\[\]?,\s]+?)\s+\w+\s*\(([^)]*)\)/);
      if (m) return `${m[1].trim()} (${m[2].trim()})`.slice(0, 120);
    } else if (ext === '.js' || ext === '.ts') {
      const jsRe = /(?:function\s+\w+|\w+)\s*\(([^)]*)\)(?:\s*:\s*([\w<>\[\]|&,\s]+))?/;
      const m = firstLine.match(jsRe) || joined.match(jsRe);
      if (m) {
        const params = m[1].trim();
        const ret = m[2] ? `: ${m[2].trim()}` : '';
        return `(${params})${ret}`.slice(0, 120);
      }
    } else if (ext === '.go') {
      const m = joined.match(/func\s+(?:\([^)]+\)\s+)?\w+\s*\(([^)]*)\)\s*(\([^)]*\)|[\w*]+)?/);
      if (m) {
        const params = m[1].trim();
        const ret = m[2] ? ` ${m[2].trim()}` : '';
        return `(${params})${ret}`.slice(0, 120);
      }
    } else if (ext === '.py') {
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
  },

  /**
   * Extract the constructor signature from a class body.
   * @param {string[]} lines - Lines starting from class declaration
   * @param {string} ext - File extension
   * @returns {string} Constructor parameter list, or ''
   */
  _extractConstructorSignature(lines, ext) {
    if (!lines || lines.length === 0) return '';
    const bodyLines = lines.slice(1, 30).join(' ').replace(/\s+/g, ' ');

    if (ext === '.js' || ext === '.ts') {
      const m = bodyLines.match(/constructor\s*\(([^)]*)\)/);
      if (m) return `constructor(${m[1].trim()})`.slice(0, 120);
    } else if (ext === '.cs') {
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
      const className = (lines[0] || '').match(/type\s+(\w+)/);
      if (className) {
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
  },

  /**
   * Extract a class-level declaration signature.
   * @param {string} declLine - The class declaration line
   * @param {string} ext - File extension
   * @returns {string} Class declaration signature, or ''
   */
  _extractClassDeclSignature(declLine, ext) {
    if (!declLine) return '';
    const trimmed = declLine.trim()
      .replace(/\s*\{?\s*$/, '')
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
  },

  /**
   * Infer a summary from a symbol's name, kind, and structural context.
   * Much richer than a simple CamelCase split.
   *
   * @param {object} sym - Symbol entry
   * @returns {string} Human-readable inferred summary, or ''
   */
  _inferSummaryFromContext(sym) {
    if (!sym.name || sym.name.length < 4) return '';

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
      const nameLower = words.join(' ');

      if (/store|cache|repository|registry/.test(nameLower)) {
        const subject = words.filter(w => !/store|cache|repository|registry/.test(w)).join(' ');
        return `Storage/management class for ${subject || 'data'}`;
      }
      if (/engine|processor|handler|worker/.test(nameLower)) {
        const subject = words.filter(w => !/engine|processor|handler|worker/.test(w)).join(' ');
        return `Processing engine for ${subject || 'tasks'}`;
      }
      if (/builder|factory|creator/.test(nameLower)) {
        const subject = words.filter(w => !/builder|factory|creator/.test(w)).join(' ');
        return `Constructs ${subject || 'objects'}`;
      }
      if (/adapter|bridge|wrapper|proxy/.test(nameLower)) {
        const subject = words.filter(w => !/adapter|bridge|wrapper|proxy/.test(w)).join(' ');
        return `Adapter/wrapper for ${subject || 'external interface'}`;
      }
      if (/loader|reader|parser|scanner/.test(nameLower)) {
        const subject = words.filter(w => !/loader|reader|parser|scanner/.test(w)).join(' ');
        return `Loads/parses ${subject || 'data'}`;
      }
      if (sym.kind === 'interface' || sym.name.startsWith('I') && /^I[A-Z]/.test(sym.name)) {
        return `Interface for ${words.filter(w => w !== 'i').join(' ')}`;
      }
      return `${words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')} class`;
    }

    if (sym.kind === 'function' || sym.kind === 'method') {
      const verb = words[0];
      const rest = words.slice(1).join(' ');

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

      return `${words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}${paramHint}${privateSuffix}`;
    }

    if (sym.kind === 'enum') {
      return `Enumeration of ${words.join(' ')} values`;
    }

    return words.join(' ');
  },

  /**
   * Lazily enrich a symbol with detailed information from source code.
   * Called at query time (not scan time) to fill missing signature, summary,
   * inheritance, and class members. Results are cached in-memory.
   *
   * @param {object} sym - Symbol entry from the index
   * @returns {object} Enriched symbol (same object, mutated)
   */
  _enrichSymbol(sym) {
    if (sym._enriched) return sym;
    sym._enriched = true;

    sym._originalSignature = sym.signature || '';

    const ext = path.extname(sym.file);
    const lines = this._readSourceLines(sym.file, Math.max(1, sym.line - 5), 40);
    if (lines.length === 0) return sym;

    const declOffset = Math.min(5, sym.line - 1);
    const declLine = lines[declOffset] || '';

    // ── 1. Full Signature ──
    if (!sym.signature || sym.signature.length >= 39) {
      if (sym.kind === 'class' || sym.kind === 'interface') {
        const ctorSig = this._extractConstructorSignature(lines.slice(declOffset), ext);
        if (ctorSig) sym._constructorSignature = ctorSig;
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

      // Go struct embedding
      if (ext === '.go' && sym._extends.length === 0) {
        for (let i = declOffset + 1; i < Math.min(lines.length, declOffset + 15); i++) {
          const bodyLine = (lines[i] || '').trim();
          if (bodyLine === '}') break;
          const embedMatch = bodyLine.match(/^(\*?[A-Z]\w+)$/);
          if (embedMatch) sym._extends.push(embedMatch[1]);
        }
      }

      // ── 3. Class Members Summary ──
      const members = this._extractClassMembers(lines.slice(declOffset + 1), ext);
      sym._fields = members.fields;
      sym._methods = members.methods;
    }

    // ── 4. Inferred Summary ──
    if (!sym.summary) {
      const inlineComment = declLine.match(/\/\/\s*(.+)$/) || declLine.match(/--\s*(.+)$/);
      if (inlineComment) {
        sym.summary = inlineComment[1].trim().slice(0, 80);
      } else {
        for (let i = declOffset - 1; i >= 0; i--) {
          const prev = (lines[i] || '').trim();
          if (prev.startsWith('//') || prev.startsWith('--') || prev.startsWith('#')) {
            const cleaned = prev.replace(/^[\/\/#-]+\s*/, '').trim();
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
            continue;
          } else {
            break;
          }
        }
        if (!sym.summary) {
          const inferred = this._inferSummaryFromContext(sym);
          if (inferred) sym._inferredSummary = inferred;
        }
      }
    }

    return sym;
  },

};

module.exports = { CodeGraphEnrichmentMixin };
