/**
 * PackageRegistryAdapter – queries package registries (npm, PyPI, crates.io, etc.)
 * for latest versions, deprecation status, download stats, and metadata.
 *
 * Supported registries:
 *   - 'npm'      – npmjs.org REST API (default)
 *   - 'pypi'     – pypi.org JSON API
 *   - 'crates'   – crates.io API (Rust)
 *
 * Usage:
 *   const adapter = new PackageRegistryAdapter();
 *   await adapter.connect();
 *   const info = await adapter.getPackageInfo('express', 'npm');
 *   const batch = await adapter.batchCheck([{name:'express',registry:'npm'}]);
 */

'use strict';

const { MCPAdapter, HttpMixin } = require('./base');

class PackageRegistryAdapter extends MCPAdapter {
  constructor(config = {}) {
    super('package-registry', config);
    this.timeout = config.timeout || 10000;
    this.defaultRegistry = config.defaultRegistry || 'npm';
    /** @type {Map<string, object>} */
    this._cache = new Map();

    // P2: Tool Use Examples — help LLMs understand how to invoke this adapter
    this.addToolExample(
      'Get package info from npm',
      { method: 'getPackageInfo', args: ['express', 'npm'] },
      { name: 'express', registry: 'npm', latestVersion: '4.18.2', deprecated: false, license: 'MIT' }
    );
    this.addToolExample(
      'Batch check packages with outdated detection',
      { method: 'batchCheck', args: [[{ name: 'lodash', currentVersion: '4.17.15', registry: 'npm' }]] },
      [{ name: 'lodash', latestVersion: '4.17.21', outdated: true }]
    );
  }

  async connect() {
    this._connected = true;
    console.log(`[MCPAdapter:package-registry] Connected (default registry: ${this.defaultRegistry}).`);
  }

  /**
   * Get package information from a registry.
   * @param {string} packageName
   * @param {string} [registry]  - 'npm' | 'pypi' | 'crates'
   */
  async getPackageInfo(packageName, registry) {
    this._assertConnected();
    const reg = registry || this.defaultRegistry;
    const cacheKey = `${reg}:${packageName}`;

    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey);
    }

    let result;
    switch (reg) {
      case 'npm':    result = await this._queryNpm(packageName);    break;
      case 'pypi':   result = await this._queryPyPI(packageName);   break;
      case 'crates': result = await this._queryCrates(packageName); break;
      default:
        result = { name: packageName, registry: reg, error: `Unsupported registry: ${reg}` };
    }

    this._cache.set(cacheKey, result);
    return result;
  }

  /**
   * Batch check multiple packages across registries.
   * @param {Array<{name:string, registry?:string, currentVersion?:string}>} packages
   */
  async batchCheck(packages) {
    this._assertConnected();
    if (!Array.isArray(packages) || packages.length === 0) return [];

    const CONCURRENCY = 5;
    const results = [];
    for (let i = 0; i < packages.length; i += CONCURRENCY) {
      const batch = packages.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async (pkg) => {
          const info = await this.getPackageInfo(pkg.name, pkg.registry);
          return {
            ...info,
            currentVersion: pkg.currentVersion || null,
            outdated: pkg.currentVersion && info.latestVersion
              ? this._isOutdated(pkg.currentVersion, info.latestVersion)
              : null,
          };
        })
      );
      results.push(...batchResults);
    }
    return results;
  }

  async query(queryStr, params = {}) {
    this._assertConnected();
    if (params.packages) return this.batchCheck(params.packages);
    return this.getPackageInfo(queryStr, params.registry);
  }

  async notify(event, payload) { /* no-op */ }

  // ── Private: npm Registry ─────────────────────────────────────────────────

  async _queryNpm(packageName) {
    try {
      const data = await this._httpGet(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`, {
        headers: {
          'Accept': 'application/vnd.npm.install-v1+json',
          'User-Agent': 'WorkFlowAgent/1.0 (PackageRegistry)',
        },
      });
      const pkg = JSON.parse(data);
      const latestVersion = (pkg['dist-tags'] && pkg['dist-tags'].latest) || '';
      const latestMeta = (pkg.versions && pkg.versions[latestVersion]) || {};
      const deprecated = latestMeta.deprecated ? true : false;

      return {
        name: packageName, registry: 'npm', latestVersion, deprecated,
        deprecationMessage: latestMeta.deprecated || '',
        description: pkg.description || '',
        license: latestMeta.license || (typeof latestMeta.license === 'object' ? latestMeta.license.type : '') || '',
        homepage: latestMeta.homepage || '',
        lastPublish: pkg.modified || '',
        weeklyDownloads: null,
      };
    } catch (err) {
      try {
        const data = await this._httpGet(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
          headers: { 'User-Agent': 'WorkFlowAgent/1.0 (PackageRegistry)' },
        });
        const pkg = JSON.parse(data);
        return {
          name: packageName, registry: 'npm',
          latestVersion: pkg.version || '', deprecated: !!pkg.deprecated,
          deprecationMessage: pkg.deprecated || '',
          description: pkg.description || '',
          license: typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type || ''),
          homepage: pkg.homepage || '', lastPublish: '', weeklyDownloads: null,
        };
      } catch (err2) {
        return { name: packageName, registry: 'npm', error: err2.message };
      }
    }
  }

  // ── Private: PyPI Registry ────────────────────────────────────────────────

  async _queryPyPI(packageName) {
    try {
      const data = await this._httpGet(`https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`, {
        headers: { 'User-Agent': 'WorkFlowAgent/1.0 (PackageRegistry)' },
      });
      const pkg = JSON.parse(data);
      const info = pkg.info || {};
      const classifiers = info.classifiers || [];
      const isInactive = classifiers.some(c => c.includes('Inactive') || c.includes('Deprecated'));

      return {
        name: packageName, registry: 'pypi',
        latestVersion: info.version || '',
        deprecated: isInactive || (info.summary || '').toLowerCase().includes('deprecated'),
        deprecationMessage: isInactive ? 'Package classified as Inactive/Deprecated' : '',
        description: info.summary || '',
        license: info.license || '',
        homepage: info.home_page || info.project_url || '',
        lastPublish: '', weeklyDownloads: null,
      };
    } catch (err) {
      return { name: packageName, registry: 'pypi', error: err.message };
    }
  }

  // ── Private: crates.io Registry ───────────────────────────────────────────

  async _queryCrates(packageName) {
    try {
      const data = await this._httpGet(`https://crates.io/api/v1/crates/${encodeURIComponent(packageName)}`, {
        headers: { 'User-Agent': 'WorkFlowAgent/1.0 (PackageRegistry)' },
      });
      const parsed = JSON.parse(data);
      const crate = parsed.crate || {};
      const newest = (parsed.versions && parsed.versions[0]) || {};

      return {
        name: packageName, registry: 'crates',
        latestVersion: crate.newest_version || newest.num || '',
        deprecated: false, deprecationMessage: '',
        description: crate.description || '',
        license: newest.license || '',
        homepage: crate.homepage || crate.repository || '',
        lastPublish: crate.updated_at || '',
        weeklyDownloads: crate.recent_downloads || null,
      };
    } catch (err) {
      return { name: packageName, registry: 'crates', error: err.message };
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  _isOutdated(currentVersion, latestVersion) {
    const parse = (v) => {
      const clean = String(v).replace(/^[^0-9]*/, '').split('-')[0];
      const parts = clean.split('.').map(Number);
      return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0 };
    };
    const curr = parse(currentVersion);
    const latest = parse(latestVersion);
    if (curr.major < latest.major) return true;
    if (curr.major === latest.major && curr.minor < latest.minor) return true;
    if (curr.major === latest.major && curr.minor === latest.minor && curr.patch < latest.patch) return true;
    return false;
  }
}

// Attach shared HTTP helpers
Object.assign(PackageRegistryAdapter.prototype, HttpMixin);

module.exports = { PackageRegistryAdapter };
