/**
 * MCP Adapter – Model Context Protocol integration (façade).
 *
 * This file is a backward-compatible re-export of all MCP adapters.
 * The actual implementations have been split into individual files under
 * the adapters/ directory for maintainability:
 *
 *   adapters/base.js                       – MCPAdapter, HttpMixin, MCPRegistry
 *   adapters/tapd-adapter.js               – TAPDAdapter
 *   adapters/devtools-adapter.js           – DevToolsAdapter
 *   adapters/package-registry-adapter.js   – PackageRegistryAdapter
 *   adapters/security-cve-adapter.js       – SecurityCVEAdapter
 *   adapters/web-search-adapter.js         – WebSearchAdapter
 *   adapters/lsp-adapter.js                – LSPAdapter
 *   adapters/code-quality-adapter.js       – CodeQualityAdapter
 *   adapters/ci-status-adapter.js          – CIStatusAdapter
 *   adapters/license-compliance-adapter.js – LicenseComplianceAdapter
 *   adapters/doc-gen-adapter.js            – DocGenAdapter
 *   adapters/llm-cost-router-adapter.js    – LLMCostRouterAdapter
 *   adapters/container-sandbox-adapter.js  – ContainerSandboxAdapter
 *   adapters/test-infra-adapter.js         – TestInfraAdapter
 *   adapters/figma-design-adapter.js       – FigmaDesignAdapter
 *
 * All existing `require('./hooks/mcp-adapter')` imports continue to work.
 */

'use strict';

module.exports = require('./adapters');
