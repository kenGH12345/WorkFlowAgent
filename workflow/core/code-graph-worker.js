/**
 * Code Graph Worker Thread – Parallel file processing for large projects.
 *
 * This worker receives a batch of file paths and performs:
 *  1. File reading (fs.readFileSync)
 *  2. Symbol extraction (regex-based)
 *  3. Import extraction (regex-based)
 *  4. Word token extraction (for call-edge analysis)
 *
 * Results are posted back to the main thread as a serialisable array.
 *
 * Used by CodeGraph.build() when project size exceeds WORKER_THRESHOLD files.
 * For smaller projects, the main thread handles everything directly.
 *
 * Design: zero external dependencies, pure Node.js.
 */

'use strict';

const { parentPort, workerData, isMainThread } = require('worker_threads');
const fs   = require('fs');
const path = require('path');

// Guard: this file is designed to run inside a Worker thread.
// If loaded from the main thread (e.g. by require()), skip execution.
if (isMainThread || !workerData) {
  module.exports = { _workerModule: true };
  return;
}

// ─── Regex patterns (duplicated from code-graph.js for isolation) ─────────────
// Workers are self-contained – they don't require the CodeGraph class.
// This small duplication is intentional to avoid cross-thread module sharing.

// Keywords to exclude from bare-function-call pattern matching
const JS_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'catch', 'try',
  'return', 'throw', 'new', 'delete', 'typeof', 'instanceof', 'void',
  'with', 'break', 'continue', 'default',
]);

// P2-8: Moved to module level – avoids re-creation per function call
const JS_BARE_PATTERNS = [
  /^(?:static\s+)?(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*\{/,
];

// ─── SymbolKind constants (mirrors code-graph.js) ─────────────────────────────
const SymbolKind = {
  CLASS:     'class',
  FUNCTION:  'function',
  METHOD:    'method',
  MODULE:    'module',
  INTERFACE: 'interface',
  ENUM:      'enum',
  PROPERTY:  'property',
};

/**
 * Extract JSDoc summary from lines above the given line index.
 * Mirrors CodeGraph._extractJsDocSummary() logic.
 */
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

/**
 * Extract XML doc summary for C# files.
 * Mirrors CodeGraph._extractXmlDocSummary() logic.
 */
function extractXmlDocSummary(lines, fnLine) {
  for (let i = fnLine - 1; i >= Math.max(0, fnLine - 5); i--) {
    const line = lines[i].trim();
    const match = line.match(/<summary>\s*(.+?)\s*<\/summary>/);
    if (match) return match[1].trim().slice(0, 80);
  }
  return '';
}

/**
 * Extract Lua comment summary above the given line.
 */
function extractLuaCommentSummary(lines, fnLine) {
  for (let i = fnLine - 1; i >= Math.max(0, fnLine - 5); i--) {
    const line = lines[i].trim();
    const match = line.match(/^--\s+(.+)/);
    if (match) return match[1].trim().slice(0, 80);
    if (!line.startsWith('--')) break;
  }
  return '';
}

/**
 * Extract Go doc comment above the given line.
 */
function extractGoDocSummary(lines, fnLine) {
  for (let i = fnLine - 1; i >= Math.max(0, fnLine - 5); i--) {
    const line = lines[i].trim();
    const match = line.match(/^\/\/\s+(.+)/);
    if (match) return match[1].trim().slice(0, 80);
    if (!line.startsWith('//')) break;
  }
  return '';
}

/**
 * Extract Python docstring summary.
 */
function extractPyDocSummary(lines, fnLine) {
  if (fnLine + 1 < lines.length) {
    const next = lines[fnLine + 1].trim();
    const match = next.match(/^"""(.+?)"""/) || next.match(/^'''(.+?)'''/) || next.match(/^"""(.+)/);
    if (match) return match[1].trim().slice(0, 80);
  }
  return '';
}

/**
 * Extract symbols from file content based on extension.
 * Returns array of { name, kind, line, signature, summary } objects.
 *
 * P0-1/2/3 fix: Now extracts full symbol info (kind, signature, summary)
 * matching the main-thread _extractJsSymbols/_extractCsSymbols/etc. logic,
 * so worker path produces identical quality to the main-thread path.
 */
function extractSymbols(lines, ext) {
  const results = [];
  const seen = new Set();

  function addSym(kind, name, line, signature, summary) {
    if (!name || seen.has(name)) return;
    seen.add(name);
    results.push({ name, kind, line, signature: signature || '', summary: summary || '' });
  }

  switch (ext) {
    case '.js': case '.ts': {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        // class Foo / class Foo extends Bar
        const classMatch = line.match(/^(?:export\s+)?class\s+(\w+)/);
        if (classMatch) {
          addSym(SymbolKind.CLASS, classMatch[1], i + 1, '', extractJsDocSummary(lines, i));
          continue;
        }
        // interface / enum / type
        const itMatch = line.match(/^(?:export\s+)?(?:interface|enum|type)\s+(\w+)/);
        if (itMatch) {
          addSym(SymbolKind.INTERFACE, itMatch[1], i + 1, '', extractJsDocSummary(lines, i));
          continue;
        }
        // function foo(...) / async function foo(...)
        const fnMatch = line.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/);
        if (fnMatch) {
          addSym(SymbolKind.FUNCTION, fnMatch[1], i + 1, fnMatch[2].slice(0, 40), extractJsDocSummary(lines, i));
          continue;
        }
        // const foo = (...) => / const foo = function(...)
        const arrowMatch = line.match(/^(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(?([^)]*)\)?\s*=>/);
        if (arrowMatch) {
          addSym(SymbolKind.FUNCTION, arrowMatch[1], i + 1, arrowMatch[2].slice(0, 40), extractJsDocSummary(lines, i));
          continue;
        }
        // method inside class: methodName(...) {
        for (const pattern of JS_BARE_PATTERNS) {
          const match = line.match(pattern);
          if (match && match[1] && !JS_KEYWORDS.has(match[1])) {
            addSym(SymbolKind.METHOD, match[1], i + 1, (match[2] || '').slice(0, 40), '');
            break;
          }
        }
      }
      break;
    }
    case '.cs': {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const typeMatch = line.match(/^(?:public|internal|protected|private)?\s*(?:abstract|sealed|static|partial)?\s*(?:abstract|sealed|static|partial)?\s*(class|struct|interface|enum)\s+(\w+)/);
        if (typeMatch) {
          const kind = typeMatch[1] === 'interface' ? SymbolKind.INTERFACE : typeMatch[1] === 'enum' ? SymbolKind.ENUM : SymbolKind.CLASS;
          addSym(kind, typeMatch[2], i + 1, '', extractXmlDocSummary(lines, i));
          continue;
        }
        const methodMatch = line.match(/^public\s+(?:static\s+|override\s+|virtual\s+|async\s+)*([\w<>\[\]?,\s]+?)\s+(\w+)\s*\(([^)]*)\)/);
        if (methodMatch && !['if', 'while', 'for', 'foreach', 'switch', 'using', 'return'].includes(methodMatch[2])) {
          addSym(SymbolKind.METHOD, methodMatch[2], i + 1, methodMatch[3].slice(0, 40), extractXmlDocSummary(lines, i));
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
          addSym(SymbolKind.FUNCTION, fnMatch[1], i + 1, fnMatch[2].slice(0, 40), extractLuaCommentSummary(lines, i));
          continue;
        }
        const classMatch = line.match(/^(?:local\s+)?(\w+)\s*=\s*(?:class\s*\(|BaseClass\s*\(|\{\})/);
        if (classMatch && classMatch[1].length > 1 && classMatch[1] !== '_') {
          addSym(SymbolKind.CLASS, classMatch[1], i + 1, '', '');
          continue;
        }
        const localFn = line.match(/^local\s+function\s+(\w+)\s*\(([^)]*)\)/);
        if (localFn) {
          addSym(SymbolKind.FUNCTION, localFn[1], i + 1, localFn[2].slice(0, 40), extractLuaCommentSummary(lines, i));
        }
      }
      break;
    }
    case '.go': {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const fnMatch = line.match(/^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(([^)]*)\)/);
        if (fnMatch) {
          addSym(SymbolKind.FUNCTION, fnMatch[1], i + 1, fnMatch[2].slice(0, 40), extractGoDocSummary(lines, i));
          continue;
        }
        const structMatch = line.match(/^type\s+(\w+)\s+struct\s*\{/);
        if (structMatch) { addSym(SymbolKind.CLASS, structMatch[1], i + 1, '', extractGoDocSummary(lines, i)); continue; }
        const ifaceMatch = line.match(/^type\s+(\w+)\s+interface\s*\{/);
        if (ifaceMatch) { addSym(SymbolKind.INTERFACE, ifaceMatch[1], i + 1, '', extractGoDocSummary(lines, i)); }
      }
      break;
    }
    case '.py': {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const classMatch = line.match(/^class\s+(\w+)/);
        if (classMatch) { addSym(SymbolKind.CLASS, classMatch[1], i + 1, '', extractPyDocSummary(lines, i)); continue; }
        const fnMatch = line.match(/^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/);
        if (fnMatch) { addSym(SymbolKind.FUNCTION, fnMatch[1], i + 1, fnMatch[2].slice(0, 40), extractPyDocSummary(lines, i)); }
      }
      break;
    }
    case '.dart': {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const classMatch = line.match(/^(?:abstract\s+)?class\s+(\w+)/);
        if (classMatch) { addSym(SymbolKind.CLASS, classMatch[1], i + 1, '', ''); continue; }
        const fnMatch = line.match(/^(?:static\s+)?(?:Future|void|String|int|double|bool|dynamic|var|\w+)\s+(\w+)\s*\(([^)]*)\)/);
        if (fnMatch) { addSym(SymbolKind.FUNCTION, fnMatch[1], i + 1, fnMatch[2].slice(0, 40), ''); }
      }
      break;
    }
    default:
      return [];
  }
  return results;
}

/**
 * Extract import/require paths from content based on extension.
 * Returns array of dependency strings.
 */
function extractImportPaths(content, ext) {
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
  return imports;
}

// ─── Main worker logic ────────────────────────────────────────────────────────

const { filePaths, projectRoot } = workerData;
const results = [];

for (const filePath of filePaths) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const relPath = path.relative(projectRoot, filePath).replace(/\\/g, '/');
    const ext     = path.extname(filePath);
    const lines   = content.split('\n');

    // Extract all three things in one read
    const symbols    = extractSymbols(lines, ext);
    const imports    = extractImportPaths(content, ext);
    const wordTokens = [...new Set(content.match(/\b\w+\b/g) || [])];

    results.push({
      relPath,
      ext,
      symbols,
      imports,
      wordTokens,
      lineCount: lines.length,
    });
  } catch (err) {
    // Skip unreadable files – report back with null
    results.push({ relPath: path.relative(projectRoot, filePath).replace(/\\/g, '/'), error: err.message });
  }
}

parentPort.postMessage(results);
