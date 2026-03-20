/**
 * LicenseComplianceAdapter – Open-source license compliance checking.
 *
 * Checks project dependencies for license compatibility issues.
 * Detects risky licenses (GPL, AGPL, SSPL) that may conflict with
 * commercial/proprietary projects.
 *
 * Backends (in priority order):
 *   1. ClearlyDefined API (https://clearlydefined.io) – Free, no API key needed
 *   2. Local fallback – reads license fields from package.json / node_modules
 *
 * Usage:
 *   const adapter = new LicenseComplianceAdapter({ projectRoot: '/path/to/project' });
 *   await adapter.connect();
 *   const results = await adapter.checkLicenses();
 *   const block = adapter.formatLicenseBlock(results);
 */

'use strict';

const { MCPAdapter, HttpMixin } = require('./base');
const fs   = require('fs');
const path = require('path');

// ── License risk classification ────────────────────────────────────────────

/**
 * License risk levels:
 *   HIGH   – Strong copyleft: GPL, AGPL, SSPL, EUPL. Forces entire project to be open-sourced.
 *   MEDIUM – Weak copyleft: LGPL, MPL, EPL, CDDL. Modifications must be shared, but linking is OK.
 *   LOW    – Permissive: MIT, BSD, Apache-2.0, ISC, Unlicense. Safe for commercial use.
 *   UNKNOWN – License not detected or unrecognised.
 */
const LICENSE_RISK = {
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  UNKNOWN: 'UNKNOWN',
};

/**
 * Maps SPDX license identifiers to risk levels.
 * Case-insensitive matching is applied at lookup time.
 */
const LICENSE_RISK_MAP = {
  // HIGH risk – strong copyleft
  'GPL-2.0':         LICENSE_RISK.HIGH,
  'GPL-2.0-only':    LICENSE_RISK.HIGH,
  'GPL-2.0-or-later':LICENSE_RISK.HIGH,
  'GPL-3.0':         LICENSE_RISK.HIGH,
  'GPL-3.0-only':    LICENSE_RISK.HIGH,
  'GPL-3.0-or-later':LICENSE_RISK.HIGH,
  'AGPL-1.0':        LICENSE_RISK.HIGH,
  'AGPL-3.0':        LICENSE_RISK.HIGH,
  'AGPL-3.0-only':   LICENSE_RISK.HIGH,
  'AGPL-3.0-or-later':LICENSE_RISK.HIGH,
  'SSPL-1.0':        LICENSE_RISK.HIGH,
  'EUPL-1.1':        LICENSE_RISK.HIGH,
  'EUPL-1.2':        LICENSE_RISK.HIGH,
  'OSL-3.0':         LICENSE_RISK.HIGH,
  // MEDIUM risk – weak copyleft
  'LGPL-2.0':        LICENSE_RISK.MEDIUM,
  'LGPL-2.0-only':   LICENSE_RISK.MEDIUM,
  'LGPL-2.1':        LICENSE_RISK.MEDIUM,
  'LGPL-2.1-only':   LICENSE_RISK.MEDIUM,
  'LGPL-2.1-or-later':LICENSE_RISK.MEDIUM,
  'LGPL-3.0':        LICENSE_RISK.MEDIUM,
  'LGPL-3.0-only':   LICENSE_RISK.MEDIUM,
  'LGPL-3.0-or-later':LICENSE_RISK.MEDIUM,
  'MPL-2.0':         LICENSE_RISK.MEDIUM,
  'EPL-1.0':         LICENSE_RISK.MEDIUM,
  'EPL-2.0':         LICENSE_RISK.MEDIUM,
  'CDDL-1.0':        LICENSE_RISK.MEDIUM,
  'CDDL-1.1':        LICENSE_RISK.MEDIUM,
  'CPL-1.0':         LICENSE_RISK.MEDIUM,
  // LOW risk – permissive
  'MIT':             LICENSE_RISK.LOW,
  'ISC':             LICENSE_RISK.LOW,
  'BSD-2-Clause':    LICENSE_RISK.LOW,
  'BSD-3-Clause':    LICENSE_RISK.LOW,
  'Apache-2.0':      LICENSE_RISK.LOW,
  'Unlicense':       LICENSE_RISK.LOW,
  '0BSD':            LICENSE_RISK.LOW,
  'CC0-1.0':         LICENSE_RISK.LOW,
  'CC-BY-3.0':       LICENSE_RISK.LOW,
  'CC-BY-4.0':       LICENSE_RISK.LOW,
  'Zlib':            LICENSE_RISK.LOW,
  'Artistic-2.0':    LICENSE_RISK.LOW,
  'BlueOak-1.0.0':   LICENSE_RISK.LOW,
  'BSL-1.0':         LICENSE_RISK.LOW,
  'Python-2.0':      LICENSE_RISK.LOW,
  'PSF-2.0':         LICENSE_RISK.LOW,
};

/**
 * Classify a license SPDX identifier into a risk level.
 * Handles compound expressions like "MIT OR Apache-2.0" and "MIT AND BSD-2-Clause".
 *
 * @param {string} license - SPDX identifier
 * @returns {string} Risk level from LICENSE_RISK
 */
function classifyLicenseRisk(license) {
  if (!license || license === 'UNKNOWN' || license === 'NOASSERTION') return LICENSE_RISK.UNKNOWN;

  // Normalise
  const normalised = license.trim();

  // Direct lookup
  for (const [spdx, risk] of Object.entries(LICENSE_RISK_MAP)) {
    if (normalised.toLowerCase() === spdx.toLowerCase()) return risk;
  }

  // Handle compound expressions: "MIT OR Apache-2.0" → take the least restrictive
  if (normalised.includes(' OR ')) {
    const parts = normalised.split(/\s+OR\s+/i);
    const risks = parts.map(p => classifyLicenseRisk(p.replace(/[()]/g, '').trim()));
    // OR = disjunction, licensee can choose → return least restrictive
    if (risks.includes(LICENSE_RISK.LOW)) return LICENSE_RISK.LOW;
    if (risks.includes(LICENSE_RISK.MEDIUM)) return LICENSE_RISK.MEDIUM;
    if (risks.includes(LICENSE_RISK.HIGH)) return LICENSE_RISK.HIGH;
    return LICENSE_RISK.UNKNOWN;
  }

  // Handle AND expressions: "MIT AND BSD-2-Clause" → take the most restrictive
  if (normalised.includes(' AND ')) {
    const parts = normalised.split(/\s+AND\s+/i);
    const risks = parts.map(p => classifyLicenseRisk(p.replace(/[()]/g, '').trim()));
    if (risks.includes(LICENSE_RISK.HIGH)) return LICENSE_RISK.HIGH;
    if (risks.includes(LICENSE_RISK.MEDIUM)) return LICENSE_RISK.MEDIUM;
    if (risks.includes(LICENSE_RISK.LOW)) return LICENSE_RISK.LOW;
    return LICENSE_RISK.UNKNOWN;
  }

  // Fuzzy match: check if the license string contains a known identifier
  for (const [spdx, risk] of Object.entries(LICENSE_RISK_MAP)) {
    if (normalised.toLowerCase().includes(spdx.toLowerCase())) return risk;
  }

  return LICENSE_RISK.UNKNOWN;
}


class LicenseComplianceAdapter extends MCPAdapter {
  /**
   * @param {object} config
   * @param {string}  [config.projectRoot]  - Project root directory
   * @param {string}  [config.backend]      - 'clearlydefined' | 'local' (default: 'clearlydefined')
   * @param {number}  [config.timeout]      - HTTP timeout in ms (default: 15000)
   * @param {number}  [config.maxPackages]  - Max packages to check (default: 30)
   * @param {number}  [config.cacheTtlMs]   - Cache TTL in ms (default: 600000 = 10min)
   */
  constructor(config = {}) {
    super('license-compliance', config);
    this.projectRoot = config.projectRoot || process.cwd();
    this.backend = config.backend || 'clearlydefined';
    this.timeout = config.timeout || 15000;
    this.maxPackages = config.maxPackages || 30;
    this._cacheTtlMs = config.cacheTtlMs || 600000; // 10 min
    /** @type {Map<string, {data: object, ts: number}>} */
    this._cache = new Map();

    // P2: Tool Use Examples — help LLMs understand license compliance workflow
    this.addToolExample(
      'Check all project dependencies for license compliance',
      { method: 'checkLicenses' },
      { total: 15, highRisk: [{ name: 'gpl-lib', license: 'GPL-3.0', risk: 'HIGH' }], lowRisk: 12, unknown: 2 }
    );
    this.addToolExample(
      'Check a single package license via ClearlyDefined',
      { method: 'query', args: ['express', { type: 'npm' }] },
      { name: 'express', license: 'MIT', risk: 'LOW', source: 'clearlydefined' }
    );
  }

  async connect() {
    // ClearlyDefined and local both need no external connection setup
    this._connected = true;
    console.log(`[MCPAdapter:license-compliance] Connected (backend: ${this.backend}).`);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Checks all project dependencies for license compliance.
   * Auto-detects the package manager and extracts dependency list.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.noCache] - Skip cache
   * @returns {Promise<LicenseCheckResult>}
   */
  async checkLicenses(opts = {}) {
    this._assertConnected();

    const deps = this._extractDependencies();
    if (deps.length === 0) {
      return { packages: [], highRiskCount: 0, mediumRiskCount: 0, unknownCount: 0 };
    }

    const toCheck = deps.slice(0, this.maxPackages);
    console.log(`[MCPAdapter:license-compliance] Checking ${toCheck.length} package(s)...`);

    const results = [];
    for (const dep of toCheck) {
      const result = await this._checkSinglePackage(dep, opts);
      results.push(result);
    }

    const highRiskCount   = results.filter(r => r.risk === LICENSE_RISK.HIGH).length;
    const mediumRiskCount = results.filter(r => r.risk === LICENSE_RISK.MEDIUM).length;
    const unknownCount    = results.filter(r => r.risk === LICENSE_RISK.UNKNOWN).length;

    console.log(`[MCPAdapter:license-compliance] Done: ${highRiskCount} HIGH, ${mediumRiskCount} MEDIUM, ${unknownCount} UNKNOWN risk.`);

    return { packages: results, highRiskCount, mediumRiskCount, unknownCount };
  }

  /**
   * Formats license check results into a Markdown block for prompt injection.
   *
   * @param {LicenseCheckResult} result
   * @returns {string}
   */
  formatLicenseBlock(result) {
    if (!result || !result.packages || result.packages.length === 0) return '';

    const hasIssues = result.highRiskCount > 0 || result.mediumRiskCount > 0;
    const icon = result.highRiskCount > 0 ? '🔴' : result.mediumRiskCount > 0 ? '🟡' : '✅';

    const lines = [
      `## 📜 License Compliance Check`,
      `> Scanned ${result.packages.length} dependencies for license compatibility.`,
      result.highRiskCount > 0
        ? `> ⚠️ **${result.highRiskCount} HIGH-RISK** license(s) detected (GPL/AGPL/SSPL). These may **force your entire project to be open-sourced**.`
        : '',
      result.mediumRiskCount > 0
        ? `> ⚠️ ${result.mediumRiskCount} MEDIUM-RISK license(s) detected (LGPL/MPL/EPL). Modifications to these libs must be shared.`
        : '',
      ``,
    ].filter(Boolean);

    // Only show table if there are issues or unknowns
    if (hasIssues || result.unknownCount > 0) {
      lines.push(`| Package | Version | License | Risk |`);
      lines.push(`|---------|---------|---------|------|`);

      // Show HIGH risk first, then MEDIUM, then UNKNOWN
      const riskOrder = [LICENSE_RISK.HIGH, LICENSE_RISK.MEDIUM, LICENSE_RISK.UNKNOWN];
      for (const riskLevel of riskOrder) {
        const filtered = result.packages.filter(p => p.risk === riskLevel);
        for (const pkg of filtered) {
          const riskIcon = pkg.risk === LICENSE_RISK.HIGH ? '🔴 HIGH'
                        : pkg.risk === LICENSE_RISK.MEDIUM ? '🟡 MEDIUM'
                        : '⚪ UNKNOWN';
          lines.push(`| ${pkg.name} | ${pkg.version || 'N/A'} | ${pkg.license || 'N/A'} | ${riskIcon} |`);
        }
      }
      lines.push(``);
    }

    if (!hasIssues && result.unknownCount === 0) {
      lines.push(`${icon} **All ${result.packages.length} dependencies have permissive licenses.** No compliance issues detected.`);
    }

    // Guidance for the agent
    if (result.highRiskCount > 0) {
      lines.push(`> **⚠️ ACTION REQUIRED**: HIGH-risk licenses (GPL/AGPL) are **legally incompatible with proprietary/commercial software**.`);
      lines.push(`> Either:`);
      lines.push(`> 1. **Replace** the dependency with a permissive-licensed alternative.`);
      lines.push(`> 2. **Isolate** the GPL code via dynamic linking (LGPL only) or separate process.`);
      lines.push(`> 3. **Consult legal counsel** if the project must remain proprietary.`);
    }

    return lines.join('\n');
  }

  // ── MCPAdapter interface ──────────────────────────────────────────────────

  async query(queryStr, params = {}) {
    this._assertConnected();
    return this.checkLicenses(params);
  }

  async notify(event, payload) {
    // License compliance is read-only; no-op for notifications
  }

  // ── Private: Dependency extraction ────────────────────────────────────────

  _extractDependencies() {
    const deps = [];
    try {
      // npm (package.json)
      const pkgPath = path.join(this.projectRoot, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        for (const [name, ver] of Object.entries(allDeps)) {
          deps.push({ name, version: String(ver).replace(/^[^0-9]*/, ''), type: 'npm' });
        }
        return deps;
      }

      // Python (requirements.txt)
      const reqPath = path.join(this.projectRoot, 'requirements.txt');
      if (fs.existsSync(reqPath)) {
        const lines = fs.readFileSync(reqPath, 'utf-8').split('\n');
        for (const line of lines) {
          const match = line.trim().match(/^([a-zA-Z0-9_-]+)(?:[=><!~]+(.+))?$/);
          if (match) {
            deps.push({ name: match[1], version: match[2] || null, type: 'pypi' });
          }
        }
        return deps;
      }
    } catch (err) {
      console.warn(`[MCPAdapter:license-compliance] Dependency extraction failed: ${err.message}`);
    }
    return deps;
  }

  // ── Private: Single package check ─────────────────────────────────────────

  async _checkSinglePackage(dep, opts = {}) {
    const cacheKey = `${dep.type}:${dep.name}:${dep.version || 'any'}`;

    // Cache check
    if (!opts.noCache) {
      const cached = this._cache.get(cacheKey);
      if (cached && (Date.now() - cached.ts) < this._cacheTtlMs) {
        return cached.data;
      }
    }

    let license = 'UNKNOWN';
    let source = 'none';

    // Strategy 1: ClearlyDefined API
    if (this.backend === 'clearlydefined') {
      try {
        license = await this._queryClearlyDefined(dep);
        source = 'clearlydefined';
      } catch (err) {
        // Fall through to local
      }
    }

    // Strategy 2: Local fallback (npm only) – read from node_modules
    if (license === 'UNKNOWN' && dep.type === 'npm') {
      license = this._readLocalLicense(dep.name);
      if (license !== 'UNKNOWN') source = 'local';
    }

    const result = {
      name: dep.name,
      version: dep.version,
      type: dep.type,
      license,
      risk: classifyLicenseRisk(license),
      source,
    };

    this._cache.set(cacheKey, { data: result, ts: Date.now() });
    return result;
  }

  // ── Private: ClearlyDefined API query ─────────────────────────────────────

  async _queryClearlyDefined(dep) {
    // ClearlyDefined coordinate format: type/provider/namespace/name/version
    // npm: npm/npmjs/-/lodash/4.17.21
    // pypi: pypi/pypi/-/flask/2.3.0
    const providerMap = { npm: 'npmjs', pypi: 'pypi' };
    const typeMap = { npm: 'npm', pypi: 'pypi' };
    const provider = providerMap[dep.type] || dep.type;
    const type = typeMap[dep.type] || dep.type;
    const version = dep.version || '-';
    const coord = `${type}/${provider}/-/${dep.name}/${version}`;

    const url = `https://api.clearlydefined.io/definitions/${encodeURIComponent(coord)}`;
    const data = await this._httpGet(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'WorkFlowAgent/1.0 (LicenseCompliance)',
      },
    });
    const parsed = JSON.parse(data);

    // Extract license from ClearlyDefined response
    if (parsed.licensed && parsed.licensed.declared) {
      return parsed.licensed.declared;
    }
    if (parsed.licensed && parsed.licensed.facets && parsed.licensed.facets.core && parsed.licensed.facets.core.declared) {
      return parsed.licensed.facets.core.declared;
    }

    return 'UNKNOWN';
  }

  // ── Private: Local license read (npm only) ────────────────────────────────

  _readLocalLicense(packageName) {
    try {
      const pkgJsonPath = path.join(this.projectRoot, 'node_modules', packageName, 'package.json');
      if (!fs.existsSync(pkgJsonPath)) return 'UNKNOWN';
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      if (pkg.license) return typeof pkg.license === 'string' ? pkg.license : (pkg.license.type || 'UNKNOWN');
      if (pkg.licenses && Array.isArray(pkg.licenses) && pkg.licenses.length > 0) {
        return pkg.licenses.map(l => l.type || l).join(' OR ');
      }
      return 'UNKNOWN';
    } catch (_) {
      return 'UNKNOWN';
    }
  }
}

// Attach shared HTTP helpers
Object.assign(LicenseComplianceAdapter.prototype, HttpMixin);

module.exports = { LicenseComplianceAdapter, LICENSE_RISK, classifyLicenseRisk };
