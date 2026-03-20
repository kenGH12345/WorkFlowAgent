/**
 * MCP Adapter Helpers
 *
 * Extracted from context-budget-manager.js (P0 decomposition – ADR-33).
 * Contains: packageRegistryHelper, securityCVEHelper, ciStatusHelper,
 *           licenseComplianceHelper, docGenHelper, llmCostRouterHelper,
 *           figmaDesignHelper, testInfraHelper, codeQualityHelper,
 *           formatCodeQualityBlock
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Package Registry + Security CVE Helpers ─────────────────────────────────

function _detectRegistry(projectRoot) {
  if (fs.existsSync(path.join(projectRoot, 'package.json'))) return 'npm';
  if (fs.existsSync(path.join(projectRoot, 'requirements.txt')) || fs.existsSync(path.join(projectRoot, 'pyproject.toml'))) return 'pypi';
  if (fs.existsSync(path.join(projectRoot, 'Cargo.toml'))) return 'crates';
  return 'npm';
}

function _extractDependencies(projectRoot, registry) {
  const deps = [];
  try {
    if (registry === 'npm') {
      const pkgPath = path.join(projectRoot, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        for (const [name, ver] of Object.entries(allDeps)) {
          deps.push({ name, currentVersion: String(ver), registry: 'npm' });
        }
      }
    } else if (registry === 'pypi') {
      const reqPath = path.join(projectRoot, 'requirements.txt');
      if (fs.existsSync(reqPath)) {
        const lines = fs.readFileSync(reqPath, 'utf-8').split('\n');
        for (const line of lines) {
          const match = line.trim().match(/^([a-zA-Z0-9_-]+)(?:[=><!~]+(.+))?$/);
          if (match) {
            deps.push({ name: match[1], currentVersion: match[2] || null, registry: 'pypi' });
          }
        }
      }
    } else if (registry === 'crates') {
      const cargoPath = path.join(projectRoot, 'Cargo.toml');
      if (fs.existsSync(cargoPath)) {
        const content = fs.readFileSync(cargoPath, 'utf-8');
        const depMatch = content.match(/\[dependencies\]([\s\S]*?)(?=\[|$)/i);
        if (depMatch) {
          const lines = depMatch[1].split('\n');
          for (const line of lines) {
            const m = line.match(/^\s*([a-zA-Z0-9_-]+)\s*=\s*["']?([0-9][^"']*)/)
              || line.match(/^\s*([a-zA-Z0-9_-]+)\s*=\s*\{[^}]*version\s*=\s*["']([^"']+)/);
            if (m) {
              deps.push({ name: m[1], currentVersion: m[2], registry: 'crates' });
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn(`[Orchestrator] Failed to extract dependencies (${registry}): ${err.message}`);
  }
  return deps;
}

/**
 * Queries the PackageRegistryAdapter for dependency version/deprecation status.
 * @param {Orchestrator} orch
 * @param {Array} [depList]
 * @param {object} [opts]
 * @returns {Promise<{block:string, results:Array, hasIssues:boolean}|null>}
 */
async function packageRegistryHelper(orch, depList, opts = {}) {
  const { maxPackages = 15, label = 'PackageRegistry' } = opts;
  try {
    if (!orch.services || !orch.services.has('mcpRegistry')) return null;
    const registry = orch.services.resolve('mcpRegistry');
    let adapter;
    try { adapter = registry.get('package-registry'); } catch (_) { return null; }
    if (!adapter) return null;

    if (!depList || depList.length === 0) {
      const reg = _detectRegistry(orch.projectRoot);
      depList = _extractDependencies(orch.projectRoot, reg);
    }
    if (depList.length === 0) return null;

    const toCheck = depList.slice(0, maxPackages);
    console.log(`[Orchestrator] \uD83D\uDCE6 ${label}: checking ${toCheck.length} package(s)...`);

    const results = await adapter.batchCheck(toCheck);
    const issues = results.filter(r => r.deprecated || r.outdated || r.error);
    const hasIssues = issues.length > 0;

    if (hasIssues) {
      console.log(`[Orchestrator] \uD83D\uDCE6 ${label}: ${issues.length} issue(s) found (${issues.filter(r=>r.deprecated).length} deprecated, ${issues.filter(r=>r.outdated).length} outdated).`);
    } else {
      console.log(`[Orchestrator] \uD83D\uDCE6 ${label}: all ${results.length} packages OK.`);
    }

    const lines = results.map(r => {
      let status = '\u2705 OK';
      const flags = [];
      if (r.error) { status = `\u26A0\uFE0F Error: ${r.error}`; }
      else {
        if (r.deprecated) flags.push(`\u26D4 DEPRECATED: ${r.deprecationMessage || 'marked as deprecated'}`);
        if (r.outdated) flags.push(`\u2B06\uFE0F Outdated: current=${r.currentVersion} → latest=${r.latestVersion}`);
        if (flags.length > 0) status = flags.join(' | ');
        else status = `\u2705 v${r.latestVersion}`;
      }
      return `| ${r.name} | ${r.currentVersion || 'N/A'} | ${r.latestVersion || 'N/A'} | ${status} |`;
    });

    const block = [
      `## \uD83D\uDCE6 Dependency Version Check`,
      `> Auto-scanned from project dependencies. Review deprecated/outdated packages and update if needed.`,
      ``,
      `| Package | Current | Latest | Status |`,
      `|---------|---------|--------|--------|`,
      ...lines,
    ].join('\n');

    return { block, results, hasIssues };
  } catch (err) {
    console.warn(`[Orchestrator] \uD83D\uDCE6 ${label} failed (non-fatal): ${err.message}`);
    return null;
  }
}

/**
 * Queries the SecurityCVEAdapter for known vulnerabilities.
 * @param {Orchestrator} orch
 * @param {Array} [depList]
 * @param {object} [opts]
 * @returns {Promise<{block:string, results:Array, totalVulns:number, criticalCount:number}|null>}
 */
async function securityCVEHelper(orch, depList, opts = {}) {
  const { maxPackages = 15, label = 'SecurityCVE' } = opts;
  try {
    if (!orch.services || !orch.services.has('mcpRegistry')) return null;
    const registry = orch.services.resolve('mcpRegistry');
    let adapter;
    try { adapter = registry.get('security-cve'); } catch (_) { return null; }
    if (!adapter) return null;

    if (!depList || depList.length === 0) {
      const reg = _detectRegistry(orch.projectRoot);
      const rawDeps = _extractDependencies(orch.projectRoot, reg);
      const ecosystemMap = { npm: 'npm', pypi: 'PyPI', crates: 'crates.io' };
      depList = rawDeps.map(d => ({
        name: d.name,
        version: d.currentVersion ? String(d.currentVersion).replace(/^[^0-9]*/, '') : undefined,
        ecosystem: ecosystemMap[d.registry] || d.registry,
      }));
    }
    if (depList.length === 0) return null;

    const toCheck = depList.slice(0, maxPackages);
    console.log(`[Orchestrator] \uD83D\uDEE1\uFE0F ${label}: checking ${toCheck.length} package(s) for CVEs...`);

    const results = await adapter.batchCheck(toCheck);

    let totalVulns = 0;
    let criticalCount = 0;
    let highCount = 0;
    const vulnPackages = [];

    for (const r of results) {
      if (r.vulnerabilities && r.vulnerabilities.length > 0) {
        totalVulns += r.vulnerabilities.length;
        for (const v of r.vulnerabilities) {
          if (v.severity === 'CRITICAL') criticalCount++;
          else if (v.severity === 'HIGH') highCount++;
        }
        vulnPackages.push(r);
      }
    }

    if (totalVulns > 0) {
      console.log(`[Orchestrator] \uD83D\uDEE1\uFE0F ${label}: \u26A0\uFE0F ${totalVulns} vulnerability(ies) found (${criticalCount} critical, ${highCount} high) across ${vulnPackages.length} package(s).`);
    } else {
      console.log(`[Orchestrator] \uD83D\uDEE1\uFE0F ${label}: \u2705 No known vulnerabilities found in ${results.length} package(s).`);
    }

    if (totalVulns === 0) {
      const block = [
        `## \uD83D\uDEE1\uFE0F Security Vulnerability Scan`,
        `> Checked ${results.length} dependencies against OSV.dev (GitHub Advisory DB, NVD).`,
        ``,
        `\u2705 **No known vulnerabilities found.**`,
      ].join('\n');
      return { block, results, totalVulns: 0, criticalCount: 0 };
    }

    const vulnLines = vulnPackages.map(r => {
      const vulnDetail = r.vulnerabilities.slice(0, 3).map(v => {
        const fix = v.fixedIn ? ` (fix: upgrade to ${v.fixedIn})` : '';
        return `  - **${v.id}** [${v.severity}]: ${v.summary}${fix}`;
      }).join('\n');
      const moreMsg = r.vulnerabilities.length > 3 ? `\n  - ... and ${r.vulnerabilities.length - 3} more` : '';
      return `### ${r.name}@${r.version} (${r.vulnerabilities.length} vuln(s))\n${vulnDetail}${moreMsg}`;
    }).join('\n\n');

    const block = [
      `## \uD83D\uDEE1\uFE0F Security Vulnerability Scan`,
      `> Checked ${results.length} dependencies against OSV.dev. **${totalVulns} vulnerability(ies) found.**`,
      criticalCount > 0 ? `> \u26A0\uFE0F **${criticalCount} CRITICAL severity** – immediate action required!` : '',
      ``,
      vulnLines,
    ].filter(Boolean).join('\n');

    return { block, results, totalVulns, criticalCount };
  } catch (err) {
    console.warn(`[Orchestrator] \uD83D\uDEE1\uFE0F ${label} failed (non-fatal): ${err.message}`);
    return null;
  }
}

// ─── CI Status Helper ─────────────────────────────────────────────────────────

async function ciStatusHelper(orch, opts = {}) {
  const { label = 'CIStatus' } = opts;
  try {
    if (!orch.services || !orch.services.has('mcpRegistry')) return null;
    const registry = orch.services.resolve('mcpRegistry');
    let adapter;
    try { adapter = registry.get('ci-status'); } catch (_) { return null; }
    if (!adapter || !adapter.isConnected) return null;

    console.log(`[Orchestrator] \uD83D\uDD04 ${label}: fetching CI pipeline status...`);
    const status = await adapter.getLastPipelineStatus();
    const block = adapter.formatStatusBlock(status);

    if (block) {
      console.log(`[Orchestrator] \uD83D\uDD04 ${label}: ${status.status} (provider: ${status.provider}).`);
    } else {
      console.log(`[Orchestrator] \uD83D\uDD04 ${label}: status unavailable or unknown.`);
    }

    return { block: block || '', status };
  } catch (err) {
    console.warn(`[Orchestrator] \uD83D\uDD04 ${label} failed (non-fatal): ${err.message}`);
    return null;
  }
}

// ─── License Compliance Helper ───────────────────────────────────────────────

async function licenseComplianceHelper(orch, opts = {}) {
  const { label = 'LicenseCompliance' } = opts;
  try {
    if (!orch.services || !orch.services.has('mcpRegistry')) return null;
    const registry = orch.services.resolve('mcpRegistry');
    let adapter;
    try { adapter = registry.get('license-compliance'); } catch (_) { return null; }
    if (!adapter || !adapter.isConnected) return null;

    console.log(`[Orchestrator] \uD83D\uDCDC ${label}: checking license compliance...`);
    const result = await adapter.checkLicenses();
    const block = adapter.formatLicenseBlock(result);

    if (result.highRiskCount > 0) {
      console.log(`[Orchestrator] \uD83D\uDCDC ${label}: \u26A0\uFE0F ${result.highRiskCount} HIGH-RISK license(s) detected!`);
    } else if (result.mediumRiskCount > 0) {
      console.log(`[Orchestrator] \uD83D\uDCDC ${label}: ${result.mediumRiskCount} MEDIUM-risk license(s) found.`);
    } else {
      console.log(`[Orchestrator] \uD83D\uDCDC ${label}: \u2705 All licenses compliant.`);
    }

    return { block: block || '', result };
  } catch (err) {
    console.warn(`[Orchestrator] \uD83D\uDCDC ${label} failed (non-fatal): ${err.message}`);
    return null;
  }
}

// ─── DocGen Helper ───────────────────────────────────────────────────────────

async function docGenHelper(orch, opts = {}) {
  const { maxFiles = 30, label = 'DocGen' } = opts;
  try {
    if (!orch.services || !orch.services.has('mcpRegistry')) return null;
    const registry = orch.services.resolve('mcpRegistry');
    let adapter;
    try { adapter = registry.get('doc-gen'); } catch (_) { return null; }
    if (!adapter || !adapter.isConnected) return null;

    console.log(`[Orchestrator] \uD83D\uDCDA ${label}: scanning for undocumented exports...`);
    const result = await adapter.findUndocumentedExports({ maxFiles });
    const block = adapter.formatUndocumentedBlock(result);

    if (result.undocumentedCount > 0) {
      console.log(`[Orchestrator] \uD83D\uDCDA ${label}: ${result.undocumentedCount}/${result.total} undocumented export(s).`);
    } else {
      console.log(`[Orchestrator] \uD83D\uDCDA ${label}: \u2705 All exports documented.`);
    }

    return { block: block || '', result };
  } catch (err) {
    console.warn(`[Orchestrator] \uD83D\uDCDA ${label} failed (non-fatal): ${err.message}`);
    return null;
  }
}

// ─── LLM Cost Router Helper ────────────────────────────────────────────────

async function llmCostRouterHelper(orch, opts = {}) {
  const { label = 'LLMCostRouter' } = opts;
  try {
    if (!orch.services || !orch.services.has('mcpRegistry')) return null;
    const registry = orch.services.resolve('mcpRegistry');
    let adapter;
    try { adapter = registry.get('llm-cost-router'); } catch (_) { return null; }
    if (!adapter || !adapter.isConnected) return null;

    const summary = adapter.getCostSummary();
    const block = adapter.formatCostBlock(summary);

    if (block) {
      console.log(`[Orchestrator] \uD83D\uDCB0 ${label}: $${summary.totalCostUsd.toFixed(4)} / $${summary.budgetUsd} (${summary.budgetPct.toFixed(1)}% used).`);
    }

    return { block: block || '', summary };
  } catch (err) {
    console.warn(`[Orchestrator] \uD83D\uDCB0 ${label} failed (non-fatal): ${err.message}`);
    return null;
  }
}

// ─── Figma Design Helper ────────────────────────────────────────────────────

async function figmaDesignHelper(orch, opts = {}) {
  const { label = 'FigmaDesign' } = opts;
  try {
    if (!orch.services || !orch.services.has('mcpRegistry')) return null;
    const registry = orch.services.resolve('mcpRegistry');
    let adapter;
    try { adapter = registry.get('figma-design'); } catch (_) { return null; }
    if (!adapter || !adapter.isConnected) return null;

    console.log(`[Orchestrator] 🎨 ${label}: extracting design specification from Figma...`);
    const spec = await adapter.extractDesignSpec();
    const block = adapter.formatDesignBlock(spec);

    if (block) {
      const colorCount = spec.designTokens?.colors?.length || 0;
      const fontCount = spec.designTokens?.typography?.length || 0;
      const compCount = spec.componentTree?.length || 0;
      console.log(`[Orchestrator] 🎨 ${label}: extracted ${colorCount} colors, ${fontCount} fonts, ${compCount} components from "${spec.fileName}".`);
    } else {
      console.log(`[Orchestrator] 🎨 ${label}: no design data extracted.`);
    }

    return { block: block || '', spec };
  } catch (err) {
    console.warn(`[Orchestrator] 🎨 ${label} failed (non-fatal): ${err.message}`);
    return null;
  }
}

// ─── Test Infra Helper ──────────────────────────────────────────────────────

async function testInfraHelper(orch, opts = {}) {
  const { label = 'TestInfra' } = opts;
  try {
    if (!orch.services || !orch.services.has('mcpRegistry')) return null;
    const registry = orch.services.resolve('mcpRegistry');
    let adapter;
    try { adapter = registry.get('test-infra'); } catch (_) { return null; }
    if (!adapter || !adapter.isConnected) return null;

    console.log(`[Orchestrator] \uD83E\uDDEA ${label}: analyzing test infrastructure...`);
    const [coverage, flakyTests, perfRegressions] = await Promise.all([
      adapter.getCoverageReport(),
      Promise.resolve(adapter.getFlakyTests()),
      Promise.resolve(adapter.getPerformanceRegressions()),
    ]);

    const block = adapter.formatTestInfraBlock(coverage, flakyTests, perfRegressions);

    if (coverage && coverage.available) {
      console.log(`[Orchestrator] \uD83E\uDDEA ${label}: coverage ${coverage.linePct.toFixed(1)}% lines, ${flakyTests.length} flaky, ${perfRegressions.length} regressions.`);
    } else {
      console.log(`[Orchestrator] \uD83E\uDDEA ${label}: no coverage data found.`);
    }

    return { block: block || '', coverage, flakyTests, perfRegressions };
  } catch (err) {
    console.warn(`[Orchestrator] \uD83E\uDDEA ${label} failed (non-fatal): ${err.message}`);
    return null;
  }
}

// ─── Code Quality Helper ─────────────────────────────────────────────────────

async function codeQualityHelper(orch, opts = {}) {
  const { maxIssues = 20, label = 'CodeQuality' } = opts;
  try {
    if (!orch.services || !orch.services.has('mcpRegistry')) return null;
    const registry = orch.services.resolve('mcpRegistry');
    let adapter;
    try { adapter = registry.get('code-quality'); } catch (_) { return null; }
    if (!adapter) return null;

    console.log(`[Orchestrator] 📊 ${label}: running code quality analysis...`);

    const projectMetrics = await adapter.getProjectMetrics();
    const issueResult = await adapter.getIssues({ maxResults: maxIssues });

    const metrics = projectMetrics.metrics || {};
    const gate = projectMetrics.qualityGate || { status: 'UNKNOWN' };
    const issues = issueResult.issues || issueResult || [];
    const backend = projectMetrics.backend || 'unknown';

    const totalIssues = Array.isArray(issues) ? issues.length : 0;

    if (gate.status === 'OK' && totalIssues === 0) {
      console.log(`[Orchestrator] 📊 ${label}: ✅ Quality gate passed. No issues found (${backend}).`);
    } else {
      console.log(`[Orchestrator] 📊 ${label}: ⚠️  Quality gate: ${gate.status}. ${totalIssues} issue(s) found (${backend}).`);
    }

    const block = formatCodeQualityBlock(projectMetrics, issues, gate);
    return { block, metrics, issues, qualityGate: gate };
  } catch (err) {
    console.warn(`[Orchestrator] 📊 ${label} failed (non-fatal): ${err.message}`);
    return null;
  }
}

function formatCodeQualityBlock(projectMetrics, issues, qualityGate) {
  const metrics = projectMetrics.metrics || {};
  const backend = projectMetrics.backend || 'local';
  const gate = qualityGate || { status: 'UNKNOWN', conditions: [] };

  const gateIcon = gate.status === 'OK' ? '✅' : gate.status === 'ERROR' ? '❌' : '⚠️';

  const lines = [
    `## 📊 Code Quality Analysis`,
    `> Source: ${backend} analysis | Quality Gate: ${gateIcon} ${gate.status}`,
    ``,
  ];

  const metricRows = [];
  if (metrics.complexity != null)         metricRows.push(`| Cyclomatic Complexity | ${metrics.complexity} |`);
  if (metrics.cognitiveComplexity != null) metricRows.push(`| Cognitive Complexity | ${metrics.cognitiveComplexity} |`);
  if (metrics.duplicatedLinesPct != null) metricRows.push(`| Code Duplication | ${typeof metrics.duplicatedLinesPct === 'number' ? metrics.duplicatedLinesPct.toFixed(1) + '%' : metrics.duplicatedLinesPct} |`);
  if (metrics.codeSmells != null)         metricRows.push(`| Code Smells | ${metrics.codeSmells} |`);
  if (metrics.bugs != null)               metricRows.push(`| Bugs | ${metrics.bugs} |`);
  if (metrics.vulnerabilities != null)    metricRows.push(`| Vulnerabilities | ${metrics.vulnerabilities} |`);
  if (metrics.coverage != null)           metricRows.push(`| Test Coverage | ${typeof metrics.coverage === 'number' ? metrics.coverage.toFixed(1) + '%' : metrics.coverage} |`);
  if (metrics.linesOfCode != null)        metricRows.push(`| Lines of Code | ${metrics.linesOfCode} |`);
  if (metrics.filesAnalysed != null)      metricRows.push(`| Files Analysed | ${metrics.filesAnalysed} |`);

  if (metricRows.length > 0) {
    lines.push(`### Metrics Summary`);
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(...metricRows);
    lines.push(``);
  }

  if (metrics.highComplexityFiles && metrics.highComplexityFiles.length > 0) {
    lines.push(`### ⚠️ High-Complexity Files (complexity > 20)`);
    for (const f of metrics.highComplexityFiles.slice(0, 5)) {
      lines.push(`- \`${f.file}\` – complexity: ${f.complexity}`);
    }
    lines.push(``);
  }

  const failedConditions = (gate.conditions || []).filter(c => c.status !== 'OK');
  if (failedConditions.length > 0) {
    lines.push(`### ❌ Failed Quality Gate Conditions`);
    for (const c of failedConditions) {
      lines.push(`- **${c.metric}**: actual=${c.actual}, threshold=${c.threshold} (${c.status})`);
    }
    lines.push(``);
  }

  const issueList = Array.isArray(issues) ? issues : [];
  if (issueList.length > 0) {
    lines.push(`### 🔍 Top Issues`);
    const severityIcon = { BLOCKER: '🔴', CRITICAL: '🔴', MAJOR: '🟡', MINOR: '🟢', INFO: 'ℹ️' };
    for (const issue of issueList.slice(0, 15)) {
      const icon = severityIcon[issue.severity] || '⚪';
      const location = issue.file ? `\`${issue.file}${issue.line ? ':' + issue.line : ''}\`` : '';
      lines.push(`- ${icon} **[${issue.severity}]** ${issue.message}${location ? ' – ' + location : ''}`);
    }
    if (issueList.length > 15) {
      lines.push(`- ... and ${issueList.length - 15} more issue(s)`);
    }
    lines.push(``);
  }

  lines.push(`> **Guidance**: Address CRITICAL/MAJOR issues first. High-complexity files should be refactored into smaller modules. Reduce code duplication by extracting shared utilities.`);

  return lines.join('\n');
}

module.exports = {
  packageRegistryHelper,
  securityCVEHelper,
  ciStatusHelper,
  licenseComplianceHelper,
  docGenHelper,
  llmCostRouterHelper,
  figmaDesignHelper,
  testInfraHelper,
  codeQualityHelper,
  formatCodeQualityBlock,
  // Internal utilities (exported for testing)
  _detectRegistry,
  _extractDependencies,
};
