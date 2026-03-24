/**
 * Orchestrator MCP Initialization (P1-1 extract from index.js)
 *
 * Initialises the MCPRegistry and auto-registers all MCP adapters
 * based on workflow.config.js settings. Also sets up Smart Context Selection,
 * Adapter Telemetry, and Adapter Plugin Registry.
 *
 * Extracted from the Orchestrator constructor to reduce index.js size.
 */

'use strict';

const { HOOK_EVENTS } = require('./constants');
const { MCPRegistry, TAPDAdapter, DevToolsAdapter, PackageRegistryAdapter, SecurityCVEAdapter, WebSearchAdapter, LSPAdapter, CodeQualityAdapter, CIStatusAdapter, LicenseComplianceAdapter, DocGenAdapter, LLMCostRouterAdapter, ContainerSandboxAdapter, TestInfraAdapter, FigmaDesignAdapter } = require('../hooks/mcp-adapter');
const { SmartContextSelector } = require('./smart-context-selector');
const { AdapterTelemetry } = require('./adapter-telemetry');
const { AdapterPluginRegistry, createBuiltinPlugins } = require('./adapter-plugin-registry');
const { detectIDEEnvironment, shouldSkipLSPAdapter } = require('./ide-detection');

/**
 * Initialises all MCP-related subsystems on the Orchestrator instance.
 * Called at the end of the Orchestrator constructor.
 *
 * @param {object} orch - The Orchestrator instance (this)
 */
function initMCPSubsystems(orch) {
  const cfgMcp = (orch._config && orch._config.mcp) || {};

  // ── MCP (Model Context Protocol) Integration ──────────────────────────────
  orch.mcpRegistry = new MCPRegistry();

  if (cfgMcp.tapd) {
    orch.mcpRegistry.register(new TAPDAdapter(cfgMcp.tapd));
  }
  if (cfgMcp.devtools) {
    orch.mcpRegistry.register(new DevToolsAdapter(cfgMcp.devtools));
  }
  if (cfgMcp.webSearch) {
    orch.mcpRegistry.register(new WebSearchAdapter(cfgMcp.webSearch));
  }
  if (cfgMcp.packageRegistry !== false) {
    orch.mcpRegistry.register(new PackageRegistryAdapter(cfgMcp.packageRegistry || {}));
  }
  if (cfgMcp.securityCVE !== false) {
    orch.mcpRegistry.register(new SecurityCVEAdapter(cfgMcp.securityCVE || {}));
  }
  if (cfgMcp.lsp !== false) {
    const lspConfig = typeof cfgMcp.lsp === 'object' ? cfgMcp.lsp : {};
    orch.mcpRegistry.register(new LSPAdapter({
      projectRoot: orch.projectRoot,
      ...lspConfig,
    }));
  }
  if (cfgMcp.codeQuality !== false) {
    const cqConfig = typeof cfgMcp.codeQuality === 'object' ? cfgMcp.codeQuality : {};
    orch.mcpRegistry.register(new CodeQualityAdapter({
      projectRoot: orch.projectRoot,
      ...cqConfig,
    }));
  }
  if (cfgMcp.ciStatus !== false) {
    const ciConfig = typeof cfgMcp.ciStatus === 'object' ? cfgMcp.ciStatus : {};
    orch.mcpRegistry.register(new CIStatusAdapter({
      projectRoot: orch.projectRoot,
      ...ciConfig,
    }));
  }
  if (cfgMcp.licenseCompliance !== false) {
    const lcConfig = typeof cfgMcp.licenseCompliance === 'object' ? cfgMcp.licenseCompliance : {};
    orch.mcpRegistry.register(new LicenseComplianceAdapter({
      projectRoot: orch.projectRoot,
      ...lcConfig,
    }));
  }
  if (cfgMcp.docGen !== false) {
    const dgConfig = typeof cfgMcp.docGen === 'object' ? cfgMcp.docGen : {};
    orch.mcpRegistry.register(new DocGenAdapter({
      projectRoot: orch.projectRoot,
      outputDir: orch._outputDir || require('./constants').PATHS.OUTPUT_DIR,
      ...dgConfig,
    }));
  }
  if (cfgMcp.llmCostRouter !== false) {
    const lcrConfig = typeof cfgMcp.llmCostRouter === 'object' ? cfgMcp.llmCostRouter : {};
    orch.mcpRegistry.register(new LLMCostRouterAdapter(lcrConfig));
  }
  if (cfgMcp.containerSandbox) {
    const csConfig = typeof cfgMcp.containerSandbox === 'object' ? cfgMcp.containerSandbox : {};
    orch.mcpRegistry.register(new ContainerSandboxAdapter({
      projectRoot: orch.projectRoot,
      ...csConfig,
    }));
  }
  if (cfgMcp.testInfra !== false) {
    const tiConfig = typeof cfgMcp.testInfra === 'object' ? cfgMcp.testInfra : {};
    orch.mcpRegistry.register(new TestInfraAdapter({
      projectRoot: orch.projectRoot,
      ...tiConfig,
    }));
  }
  if (cfgMcp.figmaDesign) {
    const fdConfig = typeof cfgMcp.figmaDesign === 'object' ? cfgMcp.figmaDesign : {};
    orch.mcpRegistry.register(new FigmaDesignAdapter(fdConfig));
  }

  // Wire MCP into HookSystem
  orch.hooks.on(HOOK_EVENTS.WORKFLOW_COMPLETE, async (payload) => {
    await orch.mcpRegistry.broadcastNotify('workflow_complete', payload).catch(() => {});
  });
  orch.hooks.on(HOOK_EVENTS.WORKFLOW_ERROR, async (payload) => {
    await orch.mcpRegistry.broadcastNotify('workflow_error', {
      error: payload.error?.message ?? String(payload.error),
      state: payload.state,
    }).catch(() => {});
  });

  orch.services.registerValue('mcpRegistry', orch.mcpRegistry);

  // ── Smart Context Selection ────────────────────────────────────────────────
  orch.smartContextSelector = new SmartContextSelector(orch.projectRoot, orch._config);
  orch.services.registerValue('smartContextSelector', orch.smartContextSelector);

  // ── Adapter Telemetry ──────────────────────────────────────────────────────
  orch._adapterTelemetry = new AdapterTelemetry();
  orch.services.registerValue('adapterTelemetry', orch._adapterTelemetry);

  // ── Adapter Plugin Registry ────────────────────────────────────────────────
  orch._pluginRegistry = new AdapterPluginRegistry();
  orch.services.registerValue('pluginRegistry', orch._pluginRegistry);
  const builtinPlugins = createBuiltinPlugins();
  for (const plugin of builtinPlugins) {
    orch._pluginRegistry.register(plugin);
  }

  // ── IDE Environment Detection ──────────────────────────────────────────────
  // Detect whether we're running inside an IDE (Cursor, VS Code, etc.)
  // This affects LSP adapter behavior and prompt guidance.
  // Supports config overrides: ide.forceStandalone / ide.forceIDE
  const ideDetection = detectIDEEnvironment({ config: orch._config });
  orch.ideDetection = ideDetection;
  orch.services.registerValue('ideDetection', ideDetection);

  // ── Logging summary ───────────────────────────────────────────────────────
  console.log(`[Orchestrator] 🔌 AdapterPluginRegistry initialised with ${builtinPlugins.length} built-in plugin(s).`);

  // Show IDE-first mode status
  if (ideDetection.isInsideIDE) {
    console.log(`[Orchestrator] 🏠 IDE-First mode: ${ideDetection.ideName} detected. Agent prompts will prefer IDE tools.`);
    if (ideDetection.capabilities.builtinLSP) {
      console.log(`[Orchestrator]    LSP: IDE-native (self-spawned LSP skipped)`);
    }
    if (ideDetection.capabilities.codebaseSearch) {
      console.log(`[Orchestrator]    Search: IDE codebase_search preferred over CodeGraph.search()`);
    }
  }

  const adapters = [
    cfgMcp.tapd && 'TAPD',
    cfgMcp.devtools && 'DevTools',
    cfgMcp.webSearch && `WebSearch(${cfgMcp.webSearch.provider || 'fetch'})`,
    cfgMcp.packageRegistry !== false && 'PackageRegistry',
    cfgMcp.securityCVE !== false && 'SecurityCVE(OSV.dev)',
    cfgMcp.lsp !== false && (shouldSkipLSPAdapter() ? 'LSP(IDE-native, self-spawn skipped)' : `LSP(${(typeof cfgMcp.lsp === 'object' && cfgMcp.lsp.server) || 'auto-detect'})`),
    cfgMcp.codeQuality !== false && `CodeQuality(${(typeof cfgMcp.codeQuality === 'object' && cfgMcp.codeQuality.backend) || 'local'})`,
    cfgMcp.ciStatus !== false && 'CIStatus',
    cfgMcp.licenseCompliance !== false && 'LicenseCompliance(ClearlyDefined)',
    cfgMcp.docGen !== false && 'DocGen',
    cfgMcp.llmCostRouter !== false && 'LLMCostRouter(OpenRouter)',
    cfgMcp.containerSandbox && `ContainerSandbox(${(typeof cfgMcp.containerSandbox === 'object' && cfgMcp.containerSandbox.runtime) || 'auto'})`,
    cfgMcp.testInfra !== false && 'TestInfra',
    cfgMcp.figmaDesign && 'FigmaDesign(Figma API)',
  ].filter(Boolean);
  if (adapters.length > 0) {
    console.log(`[Orchestrator] 🔌 MCPRegistry initialised with ${adapters.join(' + ')} adapter(s).`);
  }

  // Wire CodeQuality adapter into EntropyGC for deeper quality analysis
  if (cfgMcp.codeQuality !== false) {
    try {
      const cqAdapter = orch.mcpRegistry.get('code-quality');
      orch.entropyGC._codeQualityAdapter = cqAdapter;
    } catch (_) { /* adapter not registered */ }
  }
}

module.exports = { initMCPSubsystems };
