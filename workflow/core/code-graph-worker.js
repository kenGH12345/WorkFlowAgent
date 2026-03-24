/**
 * Code Graph Worker Thread – Parallel file processing for large projects.
 *
 * This worker receives a batch of file paths and performs:
 *  1. File reading (fs.readFileSync)
 *  2. Symbol extraction (via shared standalone parsers)
 *  3. Import extraction (via shared standalone parsers)
 *  4. Word token extraction (for call-edge analysis)
 *
 * Results are posted back to the main thread as a serialisable array.
 *
 * Used by CodeGraph.build() when project size exceeds WORKER_THRESHOLD files.
 * For smaller projects, the main thread handles everything directly.
 *
 * P1-3: Parsing logic is now shared with the main thread via standalone
 * functions exported from code-graph-parsers.js. This eliminates ~250 lines
 * of duplicated regex patterns that previously had to be maintained in sync.
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

// P1-3: Import shared standalone parsing functions from code-graph-parsers.js.
// These are pure functions (no `this` dependency) that produce identical results
// to the Mixin methods used by the main thread, ensuring quality parity.
const { extractSymbolsStandalone, extractImportPathsStandalone, stripCommentsAndStrings } = require('./code-graph-parsers');

// ─── Main worker logic ────────────────────────────────────────────────────────

const { filePaths, projectRoot } = workerData;
const results = [];

for (const filePath of filePaths) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const relPath = path.relative(projectRoot, filePath).replace(/\\/g, '/');
    const ext     = path.extname(filePath);
    const lines   = content.split('\n');

    // P1: Pass raw content to standalone extractor for pre-processing
    // (comment/string stripping, multi-line joining, indentation filtering)
    const symbols    = extractSymbolsStandalone(lines, ext, content);
    // P1: Strip comments/strings before import extraction to avoid false imports
    // from commented-out require/import statements
    const strippedContent = stripCommentsAndStrings(content, ext);
    const imports    = extractImportPathsStandalone(strippedContent, ext);
    const wordTokens = [...new Set(strippedContent.match(/\b\w+\b/g) || [])];

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
