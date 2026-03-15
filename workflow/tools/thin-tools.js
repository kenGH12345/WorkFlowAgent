/**
 * Thin Tools (薄工具) – Low-level file system adapters
 *
 * Thin tools directly expose raw file system operations (ls, read).
 * They are simple but produce high-noise, high-token-cost output.
 *
 * Use thin tools when:
 *  - Project is small (< 500 files)
 *  - You need the raw, unprocessed file content
 *  - Debugging or exploration is needed
 *
 * ⚠️  WARNING: Thin tools produce high token consumption.
 *     For large projects, prefer thick tools (thick-tools.js).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PROJECT_SCALE, LLM } = require('../core/constants');

// ─── Token Estimation ─────────────────────────────────────────────────────────

/**
 * Estimates the token count of a string using a simple chars/token ratio.
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  return Math.ceil(text.length / LLM.CHARS_PER_TOKEN);
}

/**
 * Annotates a result with token cost metadata.
 * @param {string} content
 * @param {string} toolName
 * @returns {{ content: string, meta: { tool, estimatedTokens, warning } }}
 */
function annotateWithTokenCost(content, toolName) {
  const estimatedTokens = estimateTokens(content);
  const warning = estimatedTokens > LLM.HALLUCINATION_RISK_THRESHOLD
    ? `⚠️  High token cost (${estimatedTokens} tokens). Consider using thick tools for summarisation.`
    : null;

  if (warning) console.warn(`[ThinTools:${toolName}] ${warning}`);

  return {
    content,
    meta: {
      tool: toolName,
      estimatedTokens,
      warning,
      note: 'Thin tool: raw output, high noise, high token cost.',
    },
  };
}

// ─── Thin Tool: ls ────────────────────────────────────────────────────────────

/**
 * Lists files in a directory (recursive).
 * Equivalent to `ls -R` but returns structured data.
 *
 * @param {string} dirPath   - Directory to list
 * @param {Object} [options]
 * @param {string[]} [options.extensions]    - Filter by file extensions (e.g. ['.js', '.ts'])
 * @param {string[]} [options.ignore]        - Directory/file names to ignore (exact match)
 * @param {boolean}  [options.ignoreDotFiles] - Whether to skip dot-files/dot-dirs (default: true).
 *                                             Set to false to include .env, .eslintrc, etc.
 * @returns {{ content: string, meta: object }}
 */
function ls(dirPath, options = {}) {
  const {
    extensions = [],
    ignore = ['node_modules', '.git', 'dist', 'build'],
    // N83 fix: separate dot-file filtering from the ignore list so callers can
    // opt-in to dot-files (e.g. to read .env or .eslintrc) without having to
    // enumerate every possible dot-file name in the ignore array.
    ignoreDotFiles = true,
  } = options;

  if (!fs.existsSync(dirPath)) {
    throw new Error(`[ThinTools:ls] Directory not found: "${dirPath}"`);
  }

  const results = [];
  _walkDir(dirPath, dirPath, results, extensions, ignore, ignoreDotFiles);

  const content = results.join('\n');
  return annotateWithTokenCost(content, 'ls');
}

function _walkDir(baseDir, currentDir, results, extensions, ignore, ignoreDotFiles) {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    // N83 fix: check ignore list (exact name match) and dot-file filter independently.
    // Previously both were collapsed into a single some() with OR semantics, making
    // dot-file skipping impossible to disable via the ignore option.
    if (ignore.some(ig => entry.name === ig)) continue;
    if (ignoreDotFiles && entry.name.startsWith('.')) continue;
    const fullPath = path.join(currentDir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);
    if (entry.isDirectory()) {
      results.push(`${relativePath}/`);
      _walkDir(baseDir, fullPath, results, extensions, ignore, ignoreDotFiles);
    } else if (entry.isFile()) {
      if (extensions.length === 0 || extensions.includes(path.extname(entry.name))) {
        const stat = fs.statSync(fullPath);
        results.push(`${relativePath} (${stat.size} bytes)`);
      }
    }
  }
}

// ─── Thin Tool: read ──────────────────────────────────────────────────────────

/**
 * Reads a file and returns its raw content.
 * Annotates with token cost estimate.
 *
 * @param {string} filePath
 * @returns {{ content: string, meta: object }}
 */
function read(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`[ThinTools:read] File not found: "${filePath}"`);
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  return annotateWithTokenCost(content, 'read');
}

// ─── Thin Tool: readLines ─────────────────────────────────────────────────────

/**
 * Reads specific line ranges from a file.
 * Reduces token cost compared to reading the full file.
 *
 * @param {string} filePath
 * @param {number} startLine - 1-based start line
 * @param {number} endLine   - 1-based end line (inclusive)
 * @returns {{ content: string, meta: object }}
 */
function readLines(filePath, startLine, endLine) {
  const { content: fullContent } = read(filePath);
  const lines = fullContent.split('\n');
  const slice = lines.slice(startLine - 1, endLine).join('\n');
  return annotateWithTokenCost(slice, 'readLines');
}

module.exports = { ls, read, readLines, estimateTokens };
