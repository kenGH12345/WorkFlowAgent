/**
 * Code Graph – Shared Type Constants
 *
 * Single source of truth for SymbolKind and other shared enumerations
 * used across code-graph.js, code-graph-parsers.js, code-graph-worker.js,
 * and all Mixin modules.
 *
 * Previously, SymbolKind was duplicated in code-graph.js (canonical) and
 * code-graph-parsers.js (re-declared to avoid circular require). This file
 * eliminates that duplication — all consumers now import from here.
 *
 * @module code-graph-types
 */

'use strict';

// ─── Symbol Types ─────────────────────────────────────────────────────────────

const SymbolKind = Object.freeze({
  CLASS:     'class',
  FUNCTION:  'function',
  METHOD:    'method',
  MODULE:    'module',
  INTERFACE: 'interface',
  ENUM:      'enum',
  PROPERTY:  'property',
});

module.exports = { SymbolKind };
