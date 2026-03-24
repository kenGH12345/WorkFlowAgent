/**
 * IDE Detection – Detects whether WorkFlowAgent is running inside an IDE.
 *
 * When WorkFlowAgent runs inside an IDE (Cursor, VS Code + Copilot, Claude Code, CodeBuddy),
 * the AI Agent already has access to powerful built-in tools:
 *   - codebase_search (semantic/vector search)
 *   - grep_search     (ripgrep-powered exact text search)
 *   - view_code_item  (symbol-level code viewing)
 *   - read_file       (file reading)
 *   - list_dir        (directory listing)
 *   - IDE's built-in LSP (gotoDefinition, findReferences, hover, etc.)
 *
 * These capabilities overlap with self-built modules (CodeGraph, LSPAdapter).
 * This module detects the IDE environment so that:
 *   1. LSPAdapter can be skipped (IDE already runs a language server)
 *   2. Prompt instructions can guide Agents to use IDE tools first
 *   3. CodeGraph serves as a cache/fallback rather than the primary search engine
 *
 * Detection signals:
 *   - Environment variables set by IDE processes
 *   - Process tree inspection (parent process names)
 *   - Well-known file/socket indicators
 *
 * Architecture principle: IDE capabilities first, self-built as fallback.
 */

'use strict';

// ─── IDE Environment Signatures ───────────────────────────────────────────────

/**
 * Known IDE environment variable signatures.
 * Each IDE sets specific env vars when running extensions or integrated terminals.
 */
const IDE_SIGNATURES = {
  cursor: {
    name: 'Cursor',
    envVars: ['CURSOR_SESSION', 'CURSOR_TRACE_ID'],
    processNames: ['cursor', 'Cursor'],
    capabilities: {
      codebaseSearch: true,   // Semantic vector search (OpenAI embeddings + Turbopuffer)
      grepSearch: true,       // ripgrep-powered exact text search
      viewCodeItem: true,     // Symbol-level code viewer
      readFile: true,         // File reading
      listDir: true,          // Directory listing
      builtinLSP: true,      // Full LSP via IDE (definition, references, hover, symbols)
      terminal: true,         // Terminal command execution
      editFile: true,         // File editing
    },
  },
  vscode: {
    name: 'VS Code',
    envVars: ['VSCODE_PID', 'VSCODE_CWD', 'VSCODE_IPC_HOOK', 'TERM_PROGRAM'],
    processNames: ['code', 'Code'],
    termProgramValue: 'vscode',
    capabilities: {
      codebaseSearch: true,   // Via Copilot or extensions
      grepSearch: true,       // ripgrep-powered search
      viewCodeItem: true,     // Symbol-level code viewer
      readFile: true,         // File reading
      listDir: true,          // Directory listing
      builtinLSP: true,      // Full LSP via IDE
      terminal: true,         // Terminal command execution
      editFile: true,         // File editing
    },
  },
  claudeCode: {
    name: 'Claude Code',
    envVars: ['CLAUDE_CODE', 'ANTHROPIC_SESSION'],
    processNames: ['claude'],
    capabilities: {
      codebaseSearch: true,   // Built-in semantic search
      grepSearch: true,       // ripgrep-powered search
      viewCodeItem: true,     // Symbol-level code viewer
      readFile: true,         // File reading
      listDir: true,          // Directory listing
      builtinLSP: false,     // No direct LSP (uses tools instead)
      terminal: true,         // Terminal command execution
      editFile: true,         // File editing
    },
  },
  windsurf: {
    name: 'Windsurf',
    envVars: ['WINDSURF_SESSION'],
    processNames: ['windsurf', 'Windsurf'],
    capabilities: {
      codebaseSearch: true,
      grepSearch: true,
      viewCodeItem: true,
      readFile: true,
      listDir: true,
      builtinLSP: true,
      terminal: true,
      editFile: true,
    },
  },
  codeBuddy: {
    name: 'CodeBuddy',
    envVars: ['CODEBUDDY_API_KEY', 'CODEBUDDY_AUTH_TOKEN'],
    processNames: ['codebuddy', 'CodeBuddy'],
    capabilities: {
      codebaseSearch: true,   // Semantic search (built-in, VS Code fork)
      grepSearch: true,       // ripgrep-powered search
      viewCodeItem: true,     // Symbol-level code viewer
      readFile: true,         // File reading
      listDir: true,          // Directory listing
      builtinLSP: true,      // Full LSP via IDE (VS Code fork, complete LSP support)
      terminal: true,         // Terminal command execution
      editFile: true,         // File editing
    },
  },
};

// ─── Detection Result Cache ───────────────────────────────────────────────────

/** @type {IDEDetectionResult|null} Cached detection result (per-process singleton) */
let _cachedResult = null;

// ─── Detection Logic ──────────────────────────────────────────────────────────

/**
 * Detects whether the current process is running inside an IDE.
 *
 * @param {object} [options]
 * @param {boolean} [options.forceRedetect=false] - Bypass cache and re-detect
 * @param {object}  [options.config]              - workflow.config.js contents (for forceStandalone/forceIDE)
 * @returns {IDEDetectionResult}
 */
function detectIDEEnvironment(options = {}) {
  if (_cachedResult && !options.forceRedetect) {
    return _cachedResult;
  }

  // ── Configuration overrides ──────────────────────────────────────────────
  // Support `ide.forceStandalone: true` from workflow.config.js
  // This is useful in CI/CD where VSCODE_PID may be inherited from the parent
  // process but no IDE tools are actually available.
  const ideConfig = (options.config && options.config.ide) || {};

  const result = {
    /** @type {boolean} True if running inside any known IDE */
    isInsideIDE: false,
    /** @type {string|null} IDE name (e.g. 'Cursor', 'VS Code', 'Claude Code') */
    ideName: null,
    /** @type {string|null} IDE key (e.g. 'cursor', 'vscode', 'claudeCode') */
    ideKey: null,
    /** @type {object} Available IDE capabilities */
    capabilities: {
      codebaseSearch: false,
      grepSearch: false,
      viewCodeItem: false,
      readFile: false,
      listDir: false,
      builtinLSP: false,
      terminal: false,
      editFile: false,
    },
    /** @type {string[]} Detection signals that matched */
    matchedSignals: [],
    /** @type {string} Human-readable summary */
    summary: '',
  };

  const env = process.env;

  // ── forceStandalone: treat as non-IDE regardless of env vars ────────────
  if (ideConfig.forceStandalone) {
    result.summary = 'Running standalone (forced by ide.forceStandalone config)';
    _cachedResult = result;
    console.log(`[IDEDetection] 🖥️  ${result.summary}`);
    return result;
  }

  // ── forceIDE: override detection with a specific IDE identity ───────────
  if (ideConfig.forceIDE && IDE_SIGNATURES[ideConfig.forceIDE]) {
    const sig = IDE_SIGNATURES[ideConfig.forceIDE];
    result.isInsideIDE = true;
    result.ideName = sig.name;
    result.ideKey = ideConfig.forceIDE;
    result.capabilities = { ...sig.capabilities };
    result.matchedSignals = ['config:forceIDE'];
    result.summary = `Running as ${sig.name} (forced by ide.forceIDE config)`;
    _cachedResult = result;
    console.log(`[IDEDetection] 🏠 ${result.summary}`);
    return result;
  }

  for (const [ideKey, sig] of Object.entries(IDE_SIGNATURES)) {
    const signals = [];

    // Check environment variables
    for (const envVar of sig.envVars) {
      if (env[envVar]) {
        signals.push(`env:${envVar}=${env[envVar].slice(0, 20)}`);
      }
    }

    // Check TERM_PROGRAM for VS Code
    if (sig.termProgramValue && env.TERM_PROGRAM === sig.termProgramValue) {
      signals.push(`TERM_PROGRAM=${sig.termProgramValue}`);
    }

    // If any signal matched, we're inside this IDE
    if (signals.length > 0) {
      result.isInsideIDE = true;
      result.ideName = sig.name;
      result.ideKey = ideKey;
      result.capabilities = { ...sig.capabilities };
      result.matchedSignals = signals;
      result.summary = `Running inside ${sig.name} (detected via: ${signals.join(', ')})`;
      break;
    }
  }

  if (!result.isInsideIDE) {
    result.summary = 'Running standalone (no IDE detected)';
  }

  _cachedResult = result;

  // Log detection result
  if (result.isInsideIDE) {
    const caps = Object.entries(result.capabilities)
      .filter(([, v]) => v)
      .map(([k]) => k);
    console.log(`[IDEDetection] 🏠 ${result.summary}`);
    console.log(`[IDEDetection]    Available IDE capabilities: ${caps.join(', ')}`);
  } else {
    console.log(`[IDEDetection] 🖥️  ${result.summary}`);
  }

  return result;
}

/**
 * Returns whether the LSP adapter should be skipped because the IDE
 * already provides LSP capabilities.
 *
 * @returns {boolean} True if LSP adapter spawn should be skipped
 */
function shouldSkipLSPAdapter() {
  const detection = detectIDEEnvironment();
  return detection.isInsideIDE && detection.capabilities.builtinLSP;
}

/**
 * Returns whether CodeGraph search should defer to IDE's codebase_search.
 *
 * Note: CodeGraph is still valuable as a cache and for features the IDE doesn't
 * provide (hotspot analysis, module summary, reusable symbols digest).
 * This flag indicates that for raw search queries, the Agent should prefer
 * IDE's codebase_search tool over CodeGraph.search().
 *
 * @returns {boolean} True if IDE has semantic search capability
 */
function ideHasSemanticSearch() {
  const detection = detectIDEEnvironment();
  return detection.isInsideIDE && detection.capabilities.codebaseSearch;
}

/**
 * Generates a prompt guidance block that instructs AI Agents to prefer
 * IDE tools over self-built modules when running inside an IDE.
 *
 * This block is injected into Agent prompts by the PromptBuilder.
 *
 * @returns {string|null} Markdown guidance block, or null if not inside an IDE
 */
function generateIDEToolGuidance() {
  const detection = detectIDEEnvironment();
  if (!detection.isInsideIDE) return null;

  const lines = [
    `## 🏠 IDE Tool Guidance (${detection.ideName} detected)`,
    '',
    `> You are running inside **${detection.ideName}**. Prefer IDE-native tools over injected context for maximum accuracy and speed.`,
    '',
    '### Tool Priority (IDE-first, self-built fallback)',
    '',
    '| Need | ✅ Prefer (IDE tool) | 🔄 Fallback (self-built) |',
    '|------|---------------------|-------------------------|',
  ];

  if (detection.capabilities.codebaseSearch) {
    lines.push('| Semantic code search | `codebase_search` (vector/semantic) | CodeGraph.search() (TF-IDF) |');
  }
  if (detection.capabilities.grepSearch) {
    lines.push('| Exact text search | `grep_search` (ripgrep) | CodeGraph.search() (substring) |');
  }
  if (detection.capabilities.viewCodeItem) {
    lines.push('| Symbol lookup | `view_code_item` (compiler-accurate) | CodeGraph.querySymbol() (regex) |');
  }
  if (detection.capabilities.builtinLSP) {
    lines.push('| Go to definition | IDE built-in LSP | LSPAdapter (self-spawned) |');
    lines.push('| Find references | IDE built-in LSP | LSPAdapter (self-spawned) |');
    lines.push('| Type inference / hover | IDE built-in LSP (hover) | LSPAdapter.getHover() |');
  }
  if (detection.capabilities.readFile) {
    lines.push('| Read file content | `read_file` (real-time) | ContextLoader cache (static snapshot) |');
  }

  lines.push('');
  lines.push('### When to Use IDE Tools');
  lines.push('');
  lines.push('- **Searching code**: Use `codebase_search` for semantic queries ("where is authentication handled?")');
  lines.push('  and `grep_search` for exact matches ("find all uses of `validateToken`").');
  lines.push('- **Understanding symbols**: Use `view_code_item` to read a class or function definition.');
  lines.push('- **Type information**: Use IDE hover (LSP) to inspect types, signatures, and documentation of any symbol.');
  lines.push('- **Exploring structure**: Use `list_dir` to explore directory structure.');
  lines.push('');
  lines.push('### When to Use Self-Built Context (injected by workflow)');
  lines.push('');
  lines.push('- **Hotspot analysis**: Code Graph\'s hotspot/reusable symbols — IDE has no equivalent.');
  lines.push('- **Module summary**: Code Graph\'s module-level codebase overview — IDE has no equivalent.');
  lines.push('- **Skill/experience matching**: ContextLoader\'s domain skill injection — IDE has no equivalent.');
  lines.push('- **Project profiling**: ProjectProfiler\'s tech stack analysis — IDE has no equivalent.');
  lines.push('- **Architecture decisions**: Decision log (ADR) digest — IDE has no equivalent.');
  lines.push('');

  return lines.join('\n');
}

/**
 * Returns the cached detection result, or performs detection if not cached.
 * @returns {IDEDetectionResult}
 */
function getIDEDetectionResult() {
  return detectIDEEnvironment();
}

module.exports = {
  detectIDEEnvironment,
  shouldSkipLSPAdapter,
  ideHasSemanticSearch,
  generateIDEToolGuidance,
  getIDEDetectionResult,
  IDE_SIGNATURES,
};
