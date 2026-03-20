/**
 * MCP Adapters – unified re-export from adapters/ directory.
 *
 * Each adapter lives in its own file for maintainability:
 *   base.js                          – MCPAdapter base class, HttpMixin, MCPRegistry
 *   tapd-adapter.js                  – Tencent TAPD project management
 *   devtools-adapter.js              – CI/CD, code review, PR comments
 *   package-registry-adapter.js      – npm/PyPI/crates.io version & deprecation
 *   security-cve-adapter.js          – OSV.dev vulnerability scanning
 *   web-search-adapter.js            – Web search (Tavily/Brave/fetch)
 *   lsp-adapter.js                   – Language Server Protocol bridge
 *   code-quality-adapter.js          – SonarQube/SonarCloud/local code quality metrics
 *   ci-status-adapter.js             – CI/CD pipeline status injection
 *   license-compliance-adapter.js    – Open-source license compliance checking
 *   doc-gen-adapter.js               – API doc skeleton & CHANGELOG generation
 *   llm-cost-router-adapter.js       – LLM cost-aware routing & budget enforcement
 *   container-sandbox-adapter.js     – Docker/Podman container-based sandboxed execution
 *   test-infra-adapter.js            – Coverage analysis, flaky tests, perf regression
 *   figma-design-adapter.js          – Figma design token extraction & component tree
 */

'use strict';

const { MCPAdapter, HttpMixin, MCPRegistry }   = require('./base');
const { TAPDAdapter }                          = require('./tapd-adapter');
const { DevToolsAdapter }                      = require('./devtools-adapter');
const { PackageRegistryAdapter }               = require('./package-registry-adapter');
const { SecurityCVEAdapter }                   = require('./security-cve-adapter');
const { WebSearchAdapter }                     = require('./web-search-adapter');
const { LSPAdapter, LSPCodec, LSP_SERVERS }    = require('./lsp-adapter');
const { CodeQualityAdapter }                   = require('./code-quality-adapter');
const { CIStatusAdapter }                      = require('./ci-status-adapter');
const { LicenseComplianceAdapter, LICENSE_RISK, classifyLicenseRisk } = require('./license-compliance-adapter');
const { DocGenAdapter }                        = require('./doc-gen-adapter');
const { LLMCostRouterAdapter, FALLBACK_PRICING, ROLE_PROFILES } = require('./llm-cost-router-adapter');
const { ContainerSandboxAdapter, DEFAULT_IMAGES, DEFAULT_LIMITS } = require('./container-sandbox-adapter');
const { TestInfraAdapter, DEFAULT_THRESHOLDS } = require('./test-infra-adapter');
const { FigmaDesignAdapter }                   = require('./figma-design-adapter');

module.exports = {
  // Base
  MCPAdapter,
  HttpMixin,
  MCPRegistry,
  // Adapters
  TAPDAdapter,
  DevToolsAdapter,
  PackageRegistryAdapter,
  SecurityCVEAdapter,
  WebSearchAdapter,
  LSPAdapter,
  CodeQualityAdapter,
  CIStatusAdapter,
  LicenseComplianceAdapter,
  DocGenAdapter,
  LLMCostRouterAdapter,
  ContainerSandboxAdapter,
  TestInfraAdapter,
  FigmaDesignAdapter,
  // LSP extras
  LSPCodec,
  LSP_SERVERS,
  // License extras
  LICENSE_RISK,
  classifyLicenseRisk,
  // LLM cost extras
  FALLBACK_PRICING,
  ROLE_PROFILES,
  // Container extras
  DEFAULT_IMAGES,
  DEFAULT_LIMITS,
  // Test infra extras
  DEFAULT_THRESHOLDS,
  // Figma design (no extras)
};
