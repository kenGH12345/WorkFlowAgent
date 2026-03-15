/**
 * Thick Tools (厚工具) – High-level summarisation scripts
 *
 * Thick tools offload computation to code, returning only distilled summaries.
 * They produce minimal tokens, high signal-to-noise ratio output.
 *
 * Use thick tools when:
 *  - Project is large (Monorepo, > 500 files)
 *  - You need a summary, not raw content
 *  - Token budget is a concern
 *
 * ✅  Thick tools: Token-minimal, high signal-to-noise, low hallucination risk.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PROJECT_SCALE, LLM } = require('../core/constants');
const { estimateTokens } = require('./thin-tools');

// ─── Thick Tool: getUnfinishedChanges ─────────────────────────────────────────

/**
 * Scans a directory for files modified after a given timestamp.
 * Returns a compact summary instead of raw file contents.
 * Equivalent to: cli.js --func getUnfinishedChanges
 *
 * @param {string} dirPath
 * @param {Date}   [since]   - Only include files modified after this date
 * @param {string[]} [extensions] - File extensions to include
 * @returns {{ summary: string, files: Array, meta: object }}
 */
function getUnfinishedChanges(dirPath, since = null, extensions = ['.js', '.ts', '.json', '.md']) {
  if (!fs.existsSync(dirPath)) {
    throw new Error(`[ThickTools:getUnfinishedChanges] Directory not found: "${dirPath}"`);
  }

  const changedFiles = [];
  _scanChanges(dirPath, dirPath, changedFiles, since, extensions);

  const summary = _buildChangesSummary(changedFiles);
  const estimatedTokens = estimateTokens(summary);

  console.log(`[ThickTools:getUnfinishedChanges] Found ${changedFiles.length} changed files. ~${estimatedTokens} tokens.`);

  return {
    summary,
    files: changedFiles,
    meta: {
      tool: 'getUnfinishedChanges',
      estimatedTokens,
      fileCount: changedFiles.length,
      note: 'Thick tool: summarised output, low token cost, high signal-to-noise.',
    },
  };
}

function _scanChanges(baseDir, currentDir, results, since, extensions) {
  const ignore = ['node_modules', '.git', 'dist', 'build', 'output'];
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (ignore.some(ig => entry.name === ig || entry.name.startsWith('.'))) continue;
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      _scanChanges(baseDir, fullPath, results, since, extensions);
    } else if (entry.isFile() && extensions.includes(path.extname(entry.name))) {
      const stat = fs.statSync(fullPath);
      if (!since || stat.mtimeMs > since.getTime()) {
        results.push({
          path: path.relative(baseDir, fullPath),
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        });
      }
    }
  }
}

function _buildChangesSummary(files) {
  if (files.length === 0) return 'No unfinished changes found.';
  const lines = [`## Unfinished Changes (${files.length} files)\n`];
  for (const f of files) {
    lines.push(`- ${f.path}  (${f.size} bytes, modified: ${f.modifiedAt})`);
  }
  return lines.join('\n');
}

// ─── Thick Tool: getProjectStructure ─────────────────────────────────────────

/**
 * Returns a compact tree-style summary of the project structure.
 * Limits depth to avoid token explosion on large Monorepos.
 *
 * @param {string} dirPath
 * @param {number} [maxDepth=3]
 * @returns {{ summary: string, meta: object }}
 */
function getProjectStructure(dirPath, maxDepth = 3) {
  if (!fs.existsSync(dirPath)) {
    throw new Error(`[ThickTools:getProjectStructure] Directory not found: "${dirPath}"`);
  }

  const lines = [];
  _buildTree(dirPath, '', 0, maxDepth, lines);
  const summary = lines.join('\n');
  const estimatedTokens = estimateTokens(summary);

  return {
    summary,
    meta: {
      tool: 'getProjectStructure',
      estimatedTokens,
      maxDepth,
      note: 'Thick tool: depth-limited tree, low token cost.',
    },
  };
}

function _buildTree(dirPath, prefix, depth, maxDepth, lines) {
  if (depth > maxDepth) {
    lines.push(`${prefix}... (truncated at depth ${maxDepth})`);
    return;
  }
  const ignore = ['node_modules', '.git', 'dist', 'build'];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    .filter(e => !ignore.includes(e.name) && !e.name.startsWith('.'));

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const isLast = i === entries.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? prefix + '    ' : prefix + '│   ';
    lines.push(`${prefix}${connector}${entry.name}${entry.isDirectory() ? '/' : ''}`);
    if (entry.isDirectory()) {
      _buildTree(path.join(dirPath, entry.name), childPrefix, depth + 1, maxDepth, lines);
    }
  }
}

// ─── Tool Selector ────────────────────────────────────────────────────────────

/**
 * Automatically selects thin or thick tools based on project scale.
 * Implements Requirement 4.4: prefer thick tools for large Monorepos.
 *
 * @param {string} dirPath
 * @returns {{ strategy: 'thin'|'thick', reason: string }}
 */
function selectToolStrategy(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return { strategy: 'thin', reason: 'Directory not found, defaulting to thin tools.' };
  }

  let fileCount = 0;
  try {
    fileCount = _countFiles(dirPath, 0);
  } catch (_) {
    return { strategy: 'thin', reason: 'Could not count files, defaulting to thin tools.' };
  }

  if (fileCount >= PROJECT_SCALE.MONOREPO_FILE_THRESHOLD) {
    console.log(`[ToolSelector] Large project detected (${fileCount} files). Using THICK tools strategy.`);
    return {
      strategy: 'thick',
      reason: `Project has ${fileCount} files (≥ ${PROJECT_SCALE.MONOREPO_FILE_THRESHOLD}). Thick tools selected for token efficiency.`,
    };
  }

  console.log(`[ToolSelector] Small project detected (${fileCount} files). Using THIN tools strategy.`);
  return {
    strategy: 'thin',
    reason: `Project has ${fileCount} files (< ${PROJECT_SCALE.MONOREPO_FILE_THRESHOLD}). Thin tools are sufficient.`,
  };
}

function _countFiles(dirPath, count) {
  const ignore = ['node_modules', '.git', 'dist', 'build'];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (ignore.includes(entry.name) || entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      count = _countFiles(path.join(dirPath, entry.name), count);
    } else {
      count++;
    }
    // Early exit: propagate the over-threshold signal up the call stack
    if (count > PROJECT_SCALE.MONOREPO_FILE_THRESHOLD) return count;
  }
  return count;
}

// ─── Thick Tool: scanCodeSymbols ─────────────────────────────────────────────

/**
 * Scans .cs and .lua source files to extract key symbols:
 * classes, public methods, enums, global functions, etc.
 * Returns a compact markdown summary grouped by file type.
 *
 * @param {string} dirPath - Root directory to scan
 * @param {object} [options]
 * @param {string[]} [options.extensions]  - File extensions to scan (default: ['.cs', '.lua'])
 * @param {string[]} [options.ignoreDirs]  - Directories to skip
 * @param {number}   [options.maxFiles]    - Max files per extension to avoid token explosion
 * @returns {{ summary: string, meta: object }}
 */
function scanCodeSymbols(dirPath, options = {}) {
  const {
    extensions = ['.cs', '.lua'],
    ignoreDirs = ['node_modules', '.git', 'dist', 'build', 'output', 'Library', 'Temp', 'obj', 'Packages'],
    maxFiles = 80,
  } = options;

  if (!fs.existsSync(dirPath)) {
    throw new Error(`[ThickTools:scanCodeSymbols] Directory not found: "${dirPath}"`);
  }

  const resultsByExt = {};
  for (const ext of extensions) {
    resultsByExt[ext] = [];
  }

  _scanSymbolFiles(dirPath, dirPath, resultsByExt, extensions, ignoreDirs, maxFiles);

  const sections = [];
  for (const ext of extensions) {
    const files = resultsByExt[ext];
    if (files.length === 0) continue;
    const extLabel = ext === '.cs' ? 'C# Code Symbols' : ext === '.lua' ? 'Lua Code Symbols' : `${ext} Symbols`;
    sections.push(`## ${extLabel} (${files.length} files scanned)\n`);
    for (const f of files) {
      if (f.symbols.length === 0) continue;
      sections.push(`### ${f.relativePath}`);
      sections.push(f.symbols.map(s => `- ${s}`).join('\n'));
      sections.push('');
    }
  }

  const summary = sections.join('\n');
  const estimatedTokens = estimateTokens(summary);
  const totalFiles = extensions.reduce((n, e) => n + resultsByExt[e].length, 0);

  console.log(`[ThickTools:scanCodeSymbols] Scanned ${totalFiles} files. ~${estimatedTokens} tokens.`);

  return {
    summary,
    meta: {
      tool: 'scanCodeSymbols',
      estimatedTokens,
      totalFiles,
      note: 'Thick tool: symbol-level summary of .cs and .lua files.',
    },
  };
}

function _scanSymbolFiles(baseDir, currentDir, resultsByExt, extensions, ignoreDirs, maxFiles) {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (ignoreDirs.includes(entry.name) || entry.name.startsWith('.')) continue;
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      _scanSymbolFiles(baseDir, fullPath, resultsByExt, extensions, ignoreDirs, maxFiles);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (!extensions.includes(ext)) continue;
      if (resultsByExt[ext].length >= maxFiles) continue;
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const symbols = ext === '.cs' ? _extractCSharpSymbols(content) : _extractLuaSymbols(content);
        if (symbols.length > 0) {
          resultsByExt[ext].push({
            relativePath: path.relative(baseDir, fullPath).replace(/\\/g, '/'),
            symbols,
          });
        }
      } catch (_) { /* skip unreadable files */ }
    }
  }
}

/**
 * Extracts key symbols from C# source code.
 * Captures: namespace, class/struct/interface/enum declarations, public methods/properties.
 */
function _extractCSharpSymbols(content) {
  const symbols = [];
  const lines = content.split('\n');

  // Namespace
  const nsMatch = content.match(/^\s*namespace\s+([\w.]+)/m);
  if (nsMatch) symbols.push(`namespace ${nsMatch[1]}`);

  for (const line of lines) {
    const trimmed = line.trim();

    // Class / struct / interface / enum
    const typeMatch = trimmed.match(/^(?:public|internal|protected|private)?\s*(?:abstract|sealed|static|partial)?\s*(?:abstract|sealed|static|partial)?\s*(class|struct|interface|enum)\s+(\w+)/);
    if (typeMatch) {
      symbols.push(`${typeMatch[1]} ${typeMatch[2]}`);
      continue;
    }

    // Public methods (exclude constructors noise by requiring return type pattern)
    const methodMatch = trimmed.match(/^public\s+(?:static\s+|override\s+|virtual\s+|async\s+|readonly\s+)*([\w<>\[\]?,\s]+?)\s+(\w+)\s*\(/);
    if (methodMatch) {
      const returnType = methodMatch[1].trim();
      const methodName = methodMatch[2];
      // Skip common false positives
      if (!['if', 'while', 'for', 'foreach', 'switch', 'using', 'return'].includes(methodName)) {
        symbols.push(`public ${returnType} ${methodName}()`);
      }
      continue;
    }

    // Public properties
    const propMatch = trimmed.match(/^public\s+(?:static\s+|readonly\s+|override\s+)*([\w<>\[\]?,\s]+?)\s+(\w+)\s*\{\s*get/);
    if (propMatch) {
      symbols.push(`prop ${propMatch[2]} : ${propMatch[1].trim()}`);
    }
  }

  return symbols;
}

/**
 * Extracts key symbols from Lua source code.
 * Captures: module/class table declarations, global functions, local functions exposed via table.
 */
function _extractLuaSymbols(content) {
  const symbols = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('--')) continue; // skip comments

    // Global function: function FuncName(...)
    const globalFnMatch = trimmed.match(/^function\s+([\w.:]+)\s*\(/);
    if (globalFnMatch) {
      symbols.push(`function ${globalFnMatch[1]}()`);
      continue;
    }

    // Local function assigned to table: M.FuncName = function(...)
    const tableFnMatch = trimmed.match(/^([\w]+\.[\w.]+)\s*=\s*function\s*\(/);
    if (tableFnMatch) {
      symbols.push(`function ${tableFnMatch[1]}()`);
      continue;
    }

    // Class/module table definition: local ClassName = {} or ClassName = {}
    const classMatch = trimmed.match(/^(?:local\s+)?(\w+)\s*=\s*(?:class\s*\(|BaseClass\s*\(|\{\})/);
    if (classMatch && classMatch[1] !== '_' && classMatch[1].length > 1) {
      symbols.push(`class/module ${classMatch[1]}`);
    }
  }

  return symbols;
}

module.exports = { getUnfinishedChanges, getProjectStructure, selectToolStrategy, scanCodeSymbols };
