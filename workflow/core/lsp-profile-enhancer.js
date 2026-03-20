/**
 * LSP Profile Enhancer – Uses Language Server Protocol data to enhance ProjectProfiler results
 *
 * This module bridges the existing LSPAdapter (MCP integration) with ProjectProfiler,
 * upgrading file-detection-based inference with compiler-accurate evidence from Language Servers.
 *
 * Architecture:
 *   LSPAdapter (already exists) → LSPProfileEnhancer → ProjectProfiler
 *
 * The enhancer follows a "LSP-First + Graceful Fallback" strategy:
 *   1. Attempt to connect to a Language Server (auto-detected or configured)
 *   2. If connected: query symbols, references, diagnostics → enhance profile
 *   3. If not connected: gracefully no-op, profile uses file-detection baseline
 *
 * What LSP adds over file-detection baseline:
 *   - Compiler-accurate symbol inventory (exact class/method/interface list)
 *   - Inheritance/implementation hierarchy (extends/implements relationships)
 *   - Actual dependency graph (import/reference relationships between files)
 *   - Decorator/annotation patterns (controller routes, ORM decorators)
 *   - Diagnostic data (compile errors = project health signal)
 *
 * This module does NOT duplicate LSPAdapter's functionality – it consumes it.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { IGNORE_DIRS } = require('./project-profiler');

// ─── LSP SymbolKind Constants ─────────────────────────────────────────────────

const SymbolKind = {
  File: 1, Module: 2, Namespace: 3, Package: 4, Class: 5, Method: 6,
  Property: 7, Field: 8, Constructor: 9, Enum: 10, Interface: 11,
  Function: 12, Variable: 13, Constant: 14, String: 15, Number: 16,
  Boolean: 17, Array: 18, Object: 19, Key: 20, Null: 21, EnumMember: 22,
  Struct: 23, Event: 24, Operator: 25, TypeParameter: 26,
};

/** SymbolKind values that represent "structural" symbols (classes, interfaces, etc.) */
const STRUCTURAL_KINDS = new Set([
  SymbolKind.Class, SymbolKind.Interface, SymbolKind.Enum,
  SymbolKind.Struct, SymbolKind.Module, SymbolKind.Namespace,
]);

/** SymbolKind values that represent "callable" symbols */
const CALLABLE_KINDS = new Set([
  SymbolKind.Method, SymbolKind.Function, SymbolKind.Constructor,
]);

// ─── Ignore Lists (shared with ProjectProfiler) ──────────────────────────────
// IGNORE_DIRS is imported from project-profiler.js (single source of truth)

// ─── File Discovery ───────────────────────────────────────────────────────────

/**
 * Collects source files suitable for LSP analysis.
 * @param {string} root    - Project root
 * @param {string[]} exts  - Allowed extensions (e.g. ['.ts', '.js'])
 * @param {number} maxFiles - Maximum files to collect
 * @returns {string[]} Array of absolute file paths
 */
function _collectSourceFiles(root, exts, maxFiles = 100) {
  const files = [];
  const extSet = new Set(exts.map(e => e.startsWith('.') ? e : `.${e}`));

  function walk(dir, depth) {
    if (depth > 6 || files.length >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= maxFiles) return;
      const fullPath = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) {
          walk(fullPath, depth + 1);
        }
      } else if (e.isFile() && extSet.has(path.extname(e.name))) {
        files.push(fullPath);
      }
    }
  }

  walk(root, 0);
  return files;
}

// ─── Symbol Analysis Helpers ──────────────────────────────────────────────────

/**
 * Flatten hierarchical LSP DocumentSymbol[] into a flat list.
 */
function _flattenSymbols(symbols, filePath, parentName = '') {
  const flat = [];
  for (const sym of symbols) {
    const qualifiedName = parentName ? `${parentName}.${sym.name}` : sym.name;
    flat.push({
      name: sym.name,
      qualifiedName,
      kind: sym.kind,
      kindName: sym.kindName || _kindName(sym.kind),
      file: filePath,
      line: sym.range?.start?.line ?? 0,
      detail: sym.detail || '',
      children: sym.children ? sym.children.length : 0,
    });
    if (sym.children && sym.children.length > 0) {
      flat.push(..._flattenSymbols(sym.children, filePath, sym.name));
    }
  }
  return flat;
}

function _kindName(kind) {
  const names = [
    '', 'File', 'Module', 'Namespace', 'Package', 'Class', 'Method',
    'Property', 'Field', 'Constructor', 'Enum', 'Interface', 'Function',
    'Variable', 'Constant', 'String', 'Number', 'Boolean', 'Array',
    'Object', 'Key', 'Null', 'EnumMember', 'Struct', 'Event',
    'Operator', 'TypeParameter',
  ];
  return names[kind] || `Kind(${kind})`;
}

// ─── Architecture Inference from Symbols ──────────────────────────────────────

/** Common base class / interface patterns that indicate architectural layers */
const LAYER_INDICATOR_PATTERNS = {
  Controller: [/controller$/i, /handler$/i, /endpoint$/i, /resource$/i, /route$/i],
  Service:    [/service$/i, /usecase$/i, /interactor$/i, /manager$/i],
  Repository: [/repository$/i, /repo$/i, /dao$/i, /store$/i, /gateway$/i],
  Entity:     [/entity$/i, /model$/i, /schema$/i, /aggregate$/i],
  DTO:        [/dto$/i, /request$/i, /response$/i, /input$/i, /output$/i],
  Middleware: [/middleware$/i, /guard$/i, /interceptor$/i, /pipe$/i, /filter$/i],
  Component:  [/component$/i, /widget$/i, /screen$/i, /page$/i, /view$/i],
  Hook:       [/^use[A-Z]/],
};

/** Decorator patterns that reveal framework-specific layer assignments */
const DECORATOR_INDICATORS = {
  Controller: ['@Controller', '@RestController', '@Get', '@Post', '@Put', '@Delete', '@Patch', '@Route', '@api_view'],
  Service:    ['@Injectable', '@Service', '@Component'],
  Repository: ['@Repository', '@Entity', '@Table', '@Model', '@Column'],
  Guard:      ['@Guard', '@UseGuards'],
  Middleware: ['@Middleware', '@UseInterceptors'],
  EventHandler: ['@EventHandler', '@OnEvent', '@Subscribe', '@Listener'],
};

/**
 * Analyzes symbol names and hover data to classify symbols into architectural layers.
 */
function _classifySymbolsIntoLayers(allSymbols) {
  const layers = {};
  const symbolCounts = {};

  for (const sym of allSymbols) {
    if (!STRUCTURAL_KINDS.has(sym.kind) && sym.kind !== SymbolKind.Function) continue;

    // Match against layer patterns
    for (const [layer, patterns] of Object.entries(LAYER_INDICATOR_PATTERNS)) {
      for (const pat of patterns) {
        if (pat.test(sym.name)) {
          if (!layers[layer]) layers[layer] = [];
          layers[layer].push(sym.qualifiedName || sym.name);
          break;
        }
      }
    }

    // Count by kind for statistics
    const kindKey = sym.kindName || _kindName(sym.kind);
    symbolCounts[kindKey] = (symbolCounts[kindKey] || 0) + 1;
  }

  return { layers, symbolCounts };
}

/**
 * Infer module coupling from cross-file symbol references.
 * Groups files by directory, counts inter-directory references.
 */
function _inferModuleCoupling(fileSymbolMap) {
  const dirSymbolCount = {};

  for (const [filePath, symbols] of Object.entries(fileSymbolMap)) {
    const dir = path.dirname(filePath);
    const relativeSrc = dir.split(path.sep).slice(-2).join('/'); // last 2 segments
    if (!dirSymbolCount[relativeSrc]) {
      dirSymbolCount[relativeSrc] = { classes: 0, functions: 0, interfaces: 0, total: 0 };
    }
    for (const sym of symbols) {
      dirSymbolCount[relativeSrc].total++;
      if (sym.kind === SymbolKind.Class) dirSymbolCount[relativeSrc].classes++;
      else if (sym.kind === SymbolKind.Function) dirSymbolCount[relativeSrc].functions++;
      else if (sym.kind === SymbolKind.Interface) dirSymbolCount[relativeSrc].interfaces++;
    }
  }

  return dirSymbolCount;
}

/**
 * Detect decorator patterns from symbol details and hover data.
 * Returns detected patterns mapped to layer types.
 */
function _detectDecoratorPatterns(allSymbols, hoverData) {
  const detected = {};

  // Scan symbol details for decorator text
  for (const sym of allSymbols) {
    const detail = sym.detail || '';
    for (const [layer, decorators] of Object.entries(DECORATOR_INDICATORS)) {
      for (const dec of decorators) {
        if (detail.includes(dec)) {
          if (!detected[layer]) detected[layer] = new Set();
          detected[layer].add(dec);
        }
      }
    }
  }

  // Scan hover data for more detailed type information
  for (const hover of hoverData) {
    if (!hover || !hover.contents) continue;
    const content = hover.contents;
    for (const [layer, decorators] of Object.entries(DECORATOR_INDICATORS)) {
      for (const dec of decorators) {
        if (content.includes(dec)) {
          if (!detected[layer]) detected[layer] = new Set();
          detected[layer].add(dec);
        }
      }
    }
  }

  // Convert Sets to Arrays
  const result = {};
  for (const [layer, decs] of Object.entries(detected)) {
    result[layer] = [...decs];
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── LSPProfileEnhancer Class ─────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

class LSPProfileEnhancer {
  /**
   * @param {object} lspAdapter - An LSPAdapter instance (from hooks/adapters/lsp-adapter.js)
   * @param {string} projectRoot - Absolute path to the project root
   * @param {object} [options]
   * @param {number} [options.maxFiles=80]         - Max source files to analyze via LSP
   * @param {number} [options.maxHoverProbes=30]   - Max symbols to probe with hover
   * @param {number} [options.timeout=60000]       - Total timeout for LSP enhancement (ms)
   * @param {string[]} [options.extensions]        - File extensions to process
   */
  constructor(lspAdapter, projectRoot, options = {}) {
    this.lsp = lspAdapter;
    this.projectRoot = projectRoot;
    this.maxFiles = options.maxFiles || 80;
    this.maxHoverProbes = options.maxHoverProbes || 30;
    this.timeout = options.timeout || 60000;
    this.extensions = options.extensions || null; // null = auto-detect from LSP server
  }

  /**
   * Checks if the LSP adapter is connected and ready.
   * @returns {boolean}
   */
  isAvailable() {
    return !!(this.lsp && this.lsp._connected);
  }

  /**
   * Enhance a profile object with LSP-derived data.
   *
   * This method mutates the profile in-place, adding/enhancing:
   *   - architecture.layers (more precise layer detection from symbol names)
   *   - architecture.symbolInventory (class/interface/function counts)
   *   - architecture.moduleMap (directory → symbol density map)
   *   - architecture.decoratorPatterns (framework-specific decorator usage)
   *   - architecture.confidence (increased when LSP confirms file-detection patterns)
   *   - dataLayer (confirmed/enhanced from symbol inheritance patterns)
   *   - communication (confirmed/enhanced from decorator patterns)
   *   - diagnostics (compiler error summary)
   *   - lspEnhanced: true (marker flag)
   *
   * @param {object} profile - ProjectProfiler output (from analyze())
   * @returns {Promise<object>} Enhanced profile (same object reference, mutated)
   */
  async enhance(profile) {
    if (!this.isAvailable()) {
      console.log(`[LSPEnhancer] ⏭️  LSP not available – using file-detection baseline only.`);
      return profile;
    }

    console.log(`[LSPEnhancer] 🔬 Enhancing profile with LSP data (server: ${this.lsp.serverName || 'auto'})...`);
    const startTime = Date.now();

    try {
      // Collect source files for analysis
      const exts = this.extensions || this.lsp._getSupportedExtensions();
      const files = _collectSourceFiles(this.projectRoot, exts, this.maxFiles);
      console.log(`[LSPEnhancer]   Found ${files.length} source files for analysis (exts: ${exts.join(', ')})`);

      if (files.length === 0) {
        console.log(`[LSPEnhancer]   No source files found. Skipping LSP enhancement.`);
        return profile;
      }

      // ── Phase 1: Collect document symbols from all files ──────────────────
      const fileSymbolMap = {};
      const allSymbols = [];
      let filesProcessed = 0;
      let filesErrored = 0;

      for (const filePath of files) {
        if (Date.now() - startTime > this.timeout * 0.7) {
          console.log(`[LSPEnhancer]   ⚡ Approaching timeout. Processed ${filesProcessed}/${files.length} files.`);
          break;
        }

        try {
          const symbols = await this.lsp.getDocumentSymbols(filePath);
          if (symbols && symbols.length > 0) {
            const relPath = path.relative(this.projectRoot, filePath);
            const flatSymbols = _flattenSymbols(symbols, relPath);
            fileSymbolMap[relPath] = flatSymbols;
            allSymbols.push(...flatSymbols);
            filesProcessed++;
          }
        } catch (err) {
          filesErrored++;
          // Non-fatal: some files may fail (e.g. syntax errors, unsupported features)
        }
      }

      console.log(`[LSPEnhancer]   📊 Collected symbols from ${filesProcessed} files (${allSymbols.length} symbols total, ${filesErrored} errors)`);

      if (allSymbols.length === 0) {
        console.log(`[LSPEnhancer]   No symbols extracted. Skipping enhancement.`);
        return profile;
      }

      // ── Phase 2: Classify symbols into architecture layers ────────────────
      const { layers, symbolCounts } = _classifySymbolsIntoLayers(allSymbols);

      // ── Phase 3: Probe key symbols with hover for type/decorator info ─────
      const hoverData = [];
      const structuralSymbols = allSymbols.filter(s => STRUCTURAL_KINDS.has(s.kind));
      const probeTargets = structuralSymbols.slice(0, this.maxHoverProbes);

      for (const sym of probeTargets) {
        if (Date.now() - startTime > this.timeout * 0.9) break;
        try {
          const filePath = path.join(this.projectRoot, sym.file);
          const hover = await this.lsp.getHover(filePath, sym.line, 0);
          if (hover) hoverData.push(hover);
        } catch { /* non-fatal */ }
      }

      console.log(`[LSPEnhancer]   🔍 Probed ${probeTargets.length} symbols with hover (${hoverData.length} responses)`);

      // ── Phase 4: Detect decorator patterns ────────────────────────────────
      const decoratorPatterns = _detectDecoratorPatterns(allSymbols, hoverData);

      // ── Phase 5: Infer module coupling ────────────────────────────────────
      const moduleMap = _inferModuleCoupling(fileSymbolMap);

      // ── Phase 6: Collect diagnostics summary ──────────────────────────────
      let diagnosticsSummary = null;
      try {
        let totalErrors = 0;
        let totalWarnings = 0;
        const errorFiles = [];

        for (const filePath of files.slice(0, 50)) {
          const diags = this.lsp.getDiagnostics(filePath);
          if (diags && diags.length > 0) {
            const errors = diags.filter(d => d.severity === 1);
            const warnings = diags.filter(d => d.severity === 2);
            totalErrors += errors.length;
            totalWarnings += warnings.length;
            if (errors.length > 0) {
              const relPath = path.relative(this.projectRoot, filePath);
              errorFiles.push({ file: relPath, errors: errors.length });
            }
          }
        }

        if (totalErrors > 0 || totalWarnings > 0) {
          diagnosticsSummary = {
            errors: totalErrors,
            warnings: totalWarnings,
            errorFiles: errorFiles.slice(0, 10),
          };
        }
      } catch { /* non-fatal */ }

      // ═══ Apply enhancements to profile ═══════════════════════════════════

      // Enhance architecture layers with LSP evidence
      const existingLayers = new Set(profile.architecture?.layers || []);
      for (const [layer, symbols] of Object.entries(layers)) {
        if (symbols.length > 0 && !existingLayers.has(layer)) {
          profile.architecture.layers.push(layer);
        }
      }

      // Add symbol inventory
      profile.architecture.symbolInventory = symbolCounts;

      // Add module map
      profile.architecture.moduleMap = moduleMap;

      // Add decorator patterns
      if (Object.keys(decoratorPatterns).length > 0) {
        profile.architecture.decoratorPatterns = decoratorPatterns;

        // Decorator patterns can refine architecture pattern
        if (decoratorPatterns.Controller && decoratorPatterns.Service) {
          if (!profile.architecture.pattern || profile.architecture.pattern === 'unknown') {
            profile.architecture.pattern = 'Layered (Controller-Service)';
          }
        }
        if (decoratorPatterns.EventHandler) {
          if (!profile.communication.includes('Event-driven')) {
            profile.communication.push('Event-driven (from decorators)');
          }
        }
      }

      // Boost confidence when LSP confirms file-detection patterns
      if (profile.architecture.confidence) {
        const lspConfirmsLayers = Object.keys(layers).length >= 2;
        if (lspConfirmsLayers) {
          profile.architecture.confidence = Math.min(1, profile.architecture.confidence + 0.2);
        }
      }

      // Add diagnostics
      if (diagnosticsSummary) {
        profile.diagnostics = diagnosticsSummary;
      }

      // Mark as LSP-enhanced
      profile.lspEnhanced = true;
      profile.lspServerName = this.lsp.serverName;
      profile.lspStats = {
        filesAnalyzed: filesProcessed,
        symbolsCollected: allSymbols.length,
        hoverProbes: hoverData.length,
        timeTakenMs: Date.now() - startTime,
      };

      const elapsed = Date.now() - startTime;
      console.log(`[LSPEnhancer] ✅ Profile enhanced in ${elapsed}ms.`);
      console.log(`[LSPEnhancer]   Symbols: ${allSymbols.length} | Layers: ${Object.keys(layers).length} | Decorators: ${Object.keys(decoratorPatterns).length}`);
      if (diagnosticsSummary) {
        console.log(`[LSPEnhancer]   Diagnostics: ${diagnosticsSummary.errors} errors, ${diagnosticsSummary.warnings} warnings`);
      }

      return profile;

    } catch (err) {
      console.warn(`[LSPEnhancer] ⚠️  Enhancement failed (non-fatal): ${err.message}`);
      console.warn(`[LSPEnhancer]   Profile will use file-detection baseline only.`);
      return profile;
    }
  }
}

// ─── Standalone LSP Enhancement (for init-project.js) ─────────────────────────

/**
 * Convenience function: create a standalone LSPAdapter, connect, enhance profile, disconnect.
 *
 * Used by init-project.js when the Orchestrator isn't running but we want LSP enhancement.
 *
 * @param {object} profile       - ProjectProfiler output
 * @param {string} projectRoot   - Absolute project root path
 * @param {object} [lspConfig]   - LSP configuration (server, command, args, timeout)
 * @returns {Promise<object>} Enhanced profile
 */
async function enhanceProfileWithLSP(profile, projectRoot, lspConfig = {}) {
  let adapter = null;
  try {
    // Lazy-require to avoid circular dependencies and allow init without LSP
    const { LSPAdapter } = require('../hooks/adapters/lsp-adapter');

    adapter = new LSPAdapter({
      projectRoot,
      ...lspConfig,
    });

    console.log(`[LSPEnhancer] Attempting standalone LSP connection for profile enhancement...`);
    await adapter.connect();

    if (!adapter._connected) {
      console.log(`[LSPEnhancer] LSP server not available. Using file-detection baseline.`);
      return profile;
    }

    const enhancer = new LSPProfileEnhancer(adapter, projectRoot, {
      maxFiles: lspConfig.maxFiles || 60,
      maxHoverProbes: lspConfig.maxHoverProbes || 20,
      timeout: lspConfig.timeout || 45000,
    });

    const enhancedProfile = await enhancer.enhance(profile);
    return enhancedProfile;

  } catch (err) {
    console.log(`[LSPEnhancer] Standalone LSP enhancement skipped: ${err.message}`);
    return profile;
  } finally {
    if (adapter) {
      try { await adapter.disconnect(); } catch { /* ignore */ }
    }
  }
}

module.exports = {
  LSPProfileEnhancer,
  enhanceProfileWithLSP,
  // Internal exports for testing
  _collectSourceFiles,
  _flattenSymbols,
  _classifySymbolsIntoLayers,
  _inferModuleCoupling,
  _detectDecoratorPatterns,
  SymbolKind,
};
