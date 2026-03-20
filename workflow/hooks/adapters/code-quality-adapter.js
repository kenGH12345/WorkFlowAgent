/**
 * CodeQualityAdapter – queries code quality platforms for real metrics.
 *
 * Supported backends:
 *   - 'sonarqube' – Self-hosted SonarQube instance (requires baseUrl + token)
 *   - 'sonarcloud' – SonarCloud.io (requires organization + token)
 *   - 'local'      – Built-in heuristic analysis (zero config, always available)
 *
 * Metrics provided:
 *   - Cyclomatic complexity per file
 *   - Code duplication percentage
 *   - Code smells / bugs / vulnerabilities counts
 *   - Test coverage percentage (if available)
 *   - Technical debt estimate
 *   - Quality gate status (pass/fail)
 *
 * The 'local' backend performs lightweight static analysis using AST-free
 * heuristics (regex-based complexity, duplication detection via hash windows).
 * It provides useful signals even without SonarQube, covering:
 *   - Cyclomatic complexity (branch/loop counting)
 *   - Copy-paste detection (sliding hash window)
 *   - Common code smell patterns (long functions, deep nesting, magic numbers)
 *
 * Usage:
 *   const adapter = new CodeQualityAdapter({ backend: 'sonarqube', baseUrl: '...', token: '...' });
 *   await adapter.connect();
 *   const metrics = await adapter.getProjectMetrics('my-project-key');
 *   const fileMetrics = await adapter.getFileMetrics('src/index.js');
 *   const issues = await adapter.getIssues({ severity: 'CRITICAL' });
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { MCPAdapter, HttpMixin } = require('./base');

// ─── Constants ────────────────────────────────────────────────────────────────

const SONAR_METRICS = [
  'complexity', 'cognitive_complexity', 'duplicated_lines_density',
  'code_smells', 'bugs', 'vulnerabilities', 'coverage',
  'sqale_debt_ratio', 'sqale_index', 'reliability_rating',
  'security_rating', 'alert_status', 'ncloc',
].join(',');

const SEVERITY_ORDER = { BLOCKER: 0, CRITICAL: 1, MAJOR: 2, MINOR: 3, INFO: 4 };

// Patterns for local complexity analysis (language-agnostic heuristics)
const COMPLEXITY_PATTERNS = [
  /\bif\s*\(/g, /\belse\s+if\s*\(/g, /\bwhile\s*\(/g, /\bfor\s*\(/g,
  /\bswitch\s*\(/g, /\bcase\s+/g, /\bcatch\s*\(/g,
  /\?\?/g, /\?\./g, /&&/g, /\|\|/g, /\?\s*[^:]+\s*:/g,
];

const CODE_SMELL_PATTERNS = [
  { pattern: /function\s+\w+\s*\([^)]{80,}\)/g, id: 'TOO_MANY_PARAMS', desc: 'Function has too many parameters' },
  { pattern: /\b\d{4,}\b/g, id: 'MAGIC_NUMBER', desc: 'Magic number literal (consider named constant)' },
  { pattern: /console\.(log|debug|info)\(/g, id: 'CONSOLE_LOG', desc: 'Console log left in production code' },
  { pattern: /\/\/\s*(TODO|FIXME|HACK|XXX)\b/gi, id: 'TODO_COMMENT', desc: 'Unresolved TODO/FIXME comment' },
  { pattern: /catch\s*\([^)]*\)\s*\{\s*\}/g, id: 'EMPTY_CATCH', desc: 'Empty catch block (silent error swallowing)' },
];

// ─── CodeQualityAdapter ──────────────────────────────────────────────────────

class CodeQualityAdapter extends MCPAdapter {
  /**
   * @param {object} config
   * @param {string} [config.backend='local']  - 'sonarqube' | 'sonarcloud' | 'local'
   * @param {string} [config.baseUrl]          - SonarQube server URL (for 'sonarqube' backend)
   * @param {string} [config.organization]     - SonarCloud organization (for 'sonarcloud' backend)
   * @param {string} [config.token]            - Authentication token
   * @param {string} [config.projectKey]       - SonarQube/SonarCloud project key
   * @param {string} [config.projectRoot]      - Local project root (for 'local' backend)
   * @param {number} [config.timeout=15000]    - HTTP request timeout
   */
  constructor(config = {}) {
    super('code-quality', config);
    this.backend      = config.backend || 'local';
    this.baseUrl      = (config.baseUrl || '').replace(/\/$/, '');
    this.organization = config.organization || '';
    this.token        = config.token || process.env.SONAR_TOKEN || '';
    this.projectKey   = config.projectKey || '';
    this.projectRoot  = config.projectRoot || process.cwd();
    this.timeout      = config.timeout || 15000;
    /** @type {Map<string, object>} */
    this._cache       = new Map();
  }

  async connect() {
    if (this.backend === 'sonarqube' && !this.baseUrl) {
      console.warn(`[MCPAdapter:code-quality] SonarQube backend requires baseUrl. Falling back to 'local'.`);
      this.backend = 'local';
    }
    if (this.backend === 'sonarcloud' && !this.organization) {
      console.warn(`[MCPAdapter:code-quality] SonarCloud backend requires organization. Falling back to 'local'.`);
      this.backend = 'local';
    }
    this._connected = true;
    console.log(`[MCPAdapter:code-quality] Connected (backend: ${this.backend}).`);
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Get project-level quality metrics.
   * @param {string} [projectKey] - Override the configured project key
   * @returns {Promise<object>} - { metrics, qualityGate, issues }
   */
  async getProjectMetrics(projectKey) {
    this._assertConnected();
    const key = projectKey || this.projectKey;
    const cacheKey = `project:${key}:${this.backend}`;
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);

    let result;
    switch (this.backend) {
      case 'sonarqube':
      case 'sonarcloud':
        result = await this._querySonarMetrics(key);
        break;
      case 'local':
      default:
        result = await this._runLocalAnalysis();
        break;
    }

    this._cache.set(cacheKey, result);
    return result;
  }

  /**
   * Get file-level quality metrics.
   * @param {string} filePath - Relative file path
   * @returns {Promise<object>}
   */
  async getFileMetrics(filePath) {
    this._assertConnected();
    const cacheKey = `file:${filePath}:${this.backend}`;
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);

    let result;
    switch (this.backend) {
      case 'sonarqube':
      case 'sonarcloud':
        result = await this._querySonarFileMetrics(filePath);
        break;
      case 'local':
      default:
        result = this._analyseLocalFile(filePath);
        break;
    }

    this._cache.set(cacheKey, result);
    return result;
  }

  /**
   * Get quality issues (bugs, code smells, vulnerabilities).
   * @param {object} [filter] - { severity, type, maxResults }
   * @returns {Promise<object[]>}
   */
  async getIssues(filter = {}) {
    this._assertConnected();
    const { severity, type, maxResults = 20 } = filter;
    const cacheKey = `issues:${severity || 'all'}:${type || 'all'}:${maxResults}`;
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);

    let result;
    switch (this.backend) {
      case 'sonarqube':
      case 'sonarcloud':
        result = await this._querySonarIssues(filter);
        break;
      case 'local':
      default:
        result = await this._runLocalIssueDetection(filter);
        break;
    }

    this._cache.set(cacheKey, result);
    return result;
  }

  /**
   * Get quality gate status.
   * @returns {Promise<object>} - { status, conditions }
   */
  async getQualityGateStatus() {
    this._assertConnected();
    if (this.backend === 'local') {
      const analysis = await this._runLocalAnalysis();
      return analysis.qualityGate;
    }
    return this._querySonarQualityGate();
  }

  // ─── MCP Interface ────────────────────────────────────────────────────────

  async query(queryStr, params = {}) {
    this._assertConnected();
    if (params.file)   return this.getFileMetrics(params.file);
    if (params.issues) return this.getIssues(params.issues);
    if (params.gate)   return this.getQualityGateStatus();
    return this.getProjectMetrics(queryStr);
  }

  async notify(event, payload) { /* no-op */ }

  // ─── Private: SonarQube/SonarCloud API ────────────────────────────────────

  _getSonarBaseUrl() {
    return this.backend === 'sonarcloud'
      ? 'https://sonarcloud.io'
      : this.baseUrl;
  }

  _getSonarHeaders() {
    const headers = { 'User-Agent': 'WorkFlowAgent/1.0 (CodeQuality)' };
    if (this.token) {
      headers['Authorization'] = `Basic ${Buffer.from(this.token + ':').toString('base64')}`;
    }
    return headers;
  }

  async _querySonarMetrics(projectKey) {
    try {
      const base = this._getSonarBaseUrl();
      const orgParam = this.organization ? `&organization=${encodeURIComponent(this.organization)}` : '';
      const url = `${base}/api/measures/component?component=${encodeURIComponent(projectKey)}&metricKeys=${SONAR_METRICS}${orgParam}`;

      const data = await this._httpGet(url, { headers: this._getSonarHeaders() });
      const parsed = JSON.parse(data);
      const measures = parsed.component?.measures || [];

      const metrics = {};
      for (const m of measures) {
        metrics[m.metric] = m.value !== undefined ? m.value : m.periods?.[0]?.value;
      }

      // Fetch quality gate status
      const qualityGate = await this._querySonarQualityGate(projectKey);

      return {
        backend: this.backend,
        projectKey,
        metrics: {
          complexity:          parseInt(metrics.complexity || '0', 10),
          cognitiveComplexity: parseInt(metrics.cognitive_complexity || '0', 10),
          duplicatedLinesPct:  parseFloat(metrics.duplicated_lines_density || '0'),
          codeSmells:          parseInt(metrics.code_smells || '0', 10),
          bugs:                parseInt(metrics.bugs || '0', 10),
          vulnerabilities:     parseInt(metrics.vulnerabilities || '0', 10),
          coverage:            parseFloat(metrics.coverage || '0'),
          technicalDebtRatio:  parseFloat(metrics.sqale_debt_ratio || '0'),
          technicalDebtMinutes: parseInt(metrics.sqale_index || '0', 10),
          linesOfCode:         parseInt(metrics.ncloc || '0', 10),
          reliabilityRating:   metrics.reliability_rating || 'N/A',
          securityRating:      metrics.security_rating || 'N/A',
        },
        qualityGate,
      };
    } catch (err) {
      return { backend: this.backend, projectKey, error: err.message, metrics: {}, qualityGate: null };
    }
  }

  async _querySonarFileMetrics(filePath) {
    try {
      const base = this._getSonarBaseUrl();
      const component = this.projectKey ? `${this.projectKey}:${filePath}` : filePath;
      const url = `${base}/api/measures/component?component=${encodeURIComponent(component)}&metricKeys=complexity,cognitive_complexity,duplicated_lines_density,code_smells,coverage,ncloc`;

      const data = await this._httpGet(url, { headers: this._getSonarHeaders() });
      const parsed = JSON.parse(data);
      const measures = parsed.component?.measures || [];

      const metrics = {};
      for (const m of measures) {
        metrics[m.metric] = m.value;
      }

      return {
        file: filePath,
        complexity:          parseInt(metrics.complexity || '0', 10),
        cognitiveComplexity: parseInt(metrics.cognitive_complexity || '0', 10),
        duplicatedLinesPct:  parseFloat(metrics.duplicated_lines_density || '0'),
        codeSmells:          parseInt(metrics.code_smells || '0', 10),
        coverage:            parseFloat(metrics.coverage || '0'),
        linesOfCode:         parseInt(metrics.ncloc || '0', 10),
      };
    } catch (err) {
      return { file: filePath, error: err.message };
    }
  }

  async _querySonarIssues(filter = {}) {
    try {
      const base = this._getSonarBaseUrl();
      const params = new URLSearchParams();
      if (this.projectKey) params.set('componentKeys', this.projectKey);
      if (this.organization) params.set('organization', this.organization);
      if (filter.severity) params.set('severities', filter.severity);
      if (filter.type) params.set('types', filter.type);
      params.set('ps', String(filter.maxResults || 20));
      params.set('s', 'SEVERITY');
      params.set('asc', 'false');
      params.set('statuses', 'OPEN,CONFIRMED,REOPENED');

      const url = `${base}/api/issues/search?${params.toString()}`;
      const data = await this._httpGet(url, { headers: this._getSonarHeaders() });
      const parsed = JSON.parse(data);

      return {
        total: parsed.total || 0,
        issues: (parsed.issues || []).map(issue => ({
          key:       issue.key,
          rule:      issue.rule,
          severity:  issue.severity,
          type:      issue.type,
          message:   issue.message,
          component: issue.component?.replace(`${this.projectKey}:`, '') || '',
          line:      issue.line || null,
          effort:    issue.effort || '',
          tags:      issue.tags || [],
        })),
      };
    } catch (err) {
      return { total: 0, issues: [], error: err.message };
    }
  }

  async _querySonarQualityGate(projectKey) {
    try {
      const base = this._getSonarBaseUrl();
      const key = projectKey || this.projectKey;
      const orgParam = this.organization ? `&organization=${encodeURIComponent(this.organization)}` : '';
      const url = `${base}/api/qualitygates/project_status?projectKey=${encodeURIComponent(key)}${orgParam}`;

      const data = await this._httpGet(url, { headers: this._getSonarHeaders() });
      const parsed = JSON.parse(data);
      const status = parsed.projectStatus || {};

      return {
        status: status.status || 'UNKNOWN',
        conditions: (status.conditions || []).map(c => ({
          metric:       c.metricKey,
          operator:     c.comparator,
          threshold:    c.errorThreshold,
          actual:       c.actualValue,
          status:       c.status,
        })),
      };
    } catch (err) {
      return { status: 'ERROR', conditions: [], error: err.message };
    }
  }

  // ─── Private: Local Analysis (zero-config fallback) ───────────────────────

  async _runLocalAnalysis() {
    const sourceFiles = this._collectSourceFiles(this.projectRoot);
    if (sourceFiles.length === 0) {
      return {
        backend: 'local',
        metrics: {},
        qualityGate: { status: 'OK', conditions: [] },
        issues: [],
      };
    }

    let totalComplexity    = 0;
    let totalLines         = 0;
    let totalSmells        = 0;
    let highComplexityFiles = [];
    const allIssues        = [];
    const fileHashes       = new Map(); // For duplication detection

    for (const filePath of sourceFiles) {
      const analysis = this._analyseLocalFile(filePath);
      totalComplexity += analysis.complexity;
      totalLines      += analysis.linesOfCode;
      totalSmells     += analysis.codeSmells;

      if (analysis.complexity > 20) {
        highComplexityFiles.push({
          file:       path.relative(this.projectRoot, filePath),
          complexity: analysis.complexity,
        });
      }

      // Collect file-level issues
      for (const issue of (analysis.issues || [])) {
        allIssues.push({ ...issue, file: path.relative(this.projectRoot, filePath) });
      }

      // Collect line hashes for duplication detection
      if (analysis._lineHashes) {
        fileHashes.set(filePath, analysis._lineHashes);
      }
    }

    // Detect cross-file duplication
    const duplicationPct = this._detectDuplication(fileHashes, totalLines);

    // Sort high-complexity files
    highComplexityFiles.sort((a, b) => b.complexity - a.complexity);

    // Build quality gate
    const conditions = [];
    if (totalSmells > 50) {
      conditions.push({ metric: 'code_smells', threshold: 50, actual: totalSmells, status: 'ERROR' });
    }
    if (duplicationPct > 10) {
      conditions.push({ metric: 'duplicated_lines_density', threshold: '10%', actual: `${duplicationPct.toFixed(1)}%`, status: 'ERROR' });
    }
    if (highComplexityFiles.length > 5) {
      conditions.push({ metric: 'high_complexity_files', threshold: 5, actual: highComplexityFiles.length, status: 'WARN' });
    }

    const gateStatus = conditions.some(c => c.status === 'ERROR') ? 'ERROR'
      : conditions.some(c => c.status === 'WARN') ? 'WARN' : 'OK';

    return {
      backend: 'local',
      metrics: {
        complexity:          totalComplexity,
        duplicatedLinesPct:  duplicationPct,
        codeSmells:          totalSmells,
        linesOfCode:         totalLines,
        filesAnalysed:       sourceFiles.length,
        highComplexityFiles: highComplexityFiles.slice(0, 10),
      },
      qualityGate: { status: gateStatus, conditions },
      issues: allIssues.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 5) - (SEVERITY_ORDER[b.severity] ?? 5)).slice(0, 50),
    };
  }

  /**
   * Analyse a single file for code quality metrics.
   * @param {string} filePath - Absolute or relative file path
   * @returns {object}
   */
  _analyseLocalFile(filePath) {
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(this.projectRoot, filePath);
    let content;
    try {
      content = fs.readFileSync(absPath, 'utf-8');
    } catch (_) {
      return { file: filePath, complexity: 0, codeSmells: 0, linesOfCode: 0, issues: [] };
    }

    const lines = content.split('\n');
    const linesOfCode = lines.filter(l => l.trim() && !l.trim().startsWith('//')).length;

    // Cyclomatic complexity (branch/loop counting)
    let complexity = 1; // Base complexity
    for (const pattern of COMPLEXITY_PATTERNS) {
      const matches = content.match(pattern);
      if (matches) complexity += matches.length;
    }

    // Cognitive complexity (nesting depth penalty)
    let maxNesting = 0;
    let currentNesting = 0;
    for (const line of lines) {
      const opens  = (line.match(/\{/g) || []).length;
      const closes = (line.match(/\}/g) || []).length;
      currentNesting += opens - closes;
      if (currentNesting > maxNesting) maxNesting = currentNesting;
    }
    const cognitiveComplexity = complexity + Math.max(0, maxNesting - 3) * 2;

    // Code smell detection
    const issues = [];
    let codeSmells = 0;

    for (const smell of CODE_SMELL_PATTERNS) {
      const matches = content.match(smell.pattern);
      if (matches && matches.length > 0) {
        codeSmells += matches.length;
        // Find line numbers for first few occurrences
        for (let i = 0; i < lines.length && issues.length < 10; i++) {
          if (smell.pattern.test(lines[i])) {
            issues.push({
              rule:     smell.id,
              severity: smell.id === 'EMPTY_CATCH' ? 'MAJOR' : 'MINOR',
              type:     'CODE_SMELL',
              message:  smell.desc,
              line:     i + 1,
            });
            smell.pattern.lastIndex = 0; // Reset regex
          }
        }
      }
    }

    // Long function detection (heuristic: >50 lines between function keyword and closing brace)
    const funcMatches = content.matchAll(/(?:function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>))/g);
    for (const match of funcMatches) {
      const startLine = content.slice(0, match.index).split('\n').length;
      // Simple heuristic: find next function or end of file
      const restContent = content.slice(match.index);
      const nextFunc = restContent.slice(1).search(/(?:function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>))/);
      const funcLength = nextFunc > 0 ? restContent.slice(0, nextFunc + 1).split('\n').length : 50;
      if (funcLength > 50) {
        codeSmells++;
        issues.push({
          rule:     'LONG_FUNCTION',
          severity: funcLength > 100 ? 'MAJOR' : 'MINOR',
          type:     'CODE_SMELL',
          message:  `Function at line ${startLine} is ~${funcLength} lines long (consider splitting)`,
          line:     startLine,
        });
      }
    }

    // Deep nesting detection
    if (maxNesting > 5) {
      codeSmells++;
      issues.push({
        rule:     'DEEP_NESTING',
        severity: maxNesting > 8 ? 'MAJOR' : 'MINOR',
        type:     'CODE_SMELL',
        message:  `Max nesting depth: ${maxNesting} (consider early returns or extraction)`,
        line:     null,
      });
    }

    // Line hashes for duplication detection (sliding window of 6 lines)
    const _lineHashes = [];
    const WINDOW = 6;
    for (let i = 0; i <= lines.length - WINDOW; i++) {
      const window = lines.slice(i, i + WINDOW).map(l => l.trim()).filter(Boolean).join('\n');
      if (window.length > 30) { // Skip trivially short windows
        _lineHashes.push(this._simpleHash(window));
      }
    }

    return {
      file: filePath,
      complexity,
      cognitiveComplexity,
      maxNesting,
      codeSmells,
      linesOfCode,
      issues,
      _lineHashes,
    };
  }

  /**
   * Detect cross-file code duplication using sliding hash windows.
   * @param {Map<string, number[]>} fileHashes
   * @param {number} totalLines
   * @returns {number} - Duplication percentage (0-100)
   */
  _detectDuplication(fileHashes, totalLines) {
    if (totalLines === 0) return 0;
    const seen = new Set();
    let duplicatedWindows = 0;
    let totalWindows = 0;

    for (const [, hashes] of fileHashes) {
      for (const h of hashes) {
        totalWindows++;
        if (seen.has(h)) {
          duplicatedWindows++;
        } else {
          seen.add(h);
        }
      }
    }

    if (totalWindows === 0) return 0;
    return (duplicatedWindows / totalWindows) * 100;
  }

  async _runLocalIssueDetection(filter = {}) {
    const analysis = await this._runLocalAnalysis();
    let issues = analysis.issues || [];

    if (filter.severity) {
      const severities = filter.severity.split(',').map(s => s.trim().toUpperCase());
      issues = issues.filter(i => severities.includes(i.severity));
    }
    if (filter.type) {
      issues = issues.filter(i => i.type === filter.type);
    }

    const maxResults = filter.maxResults || 20;
    return {
      total: issues.length,
      issues: issues.slice(0, maxResults),
    };
  }

  // ─── Private: File Collection ─────────────────────────────────────────────

  _collectSourceFiles(dir, depth = 0) {
    if (depth > 8) return [];
    const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'output', '.dart_tool', 'coverage', '__pycache__', '.next']);
    const EXTENSIONS = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.py', '.go', '.rs', '.java', '.cs', '.rb', '.php', '.dart']);
    const results = [];

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.') continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORE.has(entry.name)) {
            results.push(...this._collectSourceFiles(fullPath, depth + 1));
          }
        } else if (EXTENSIONS.has(path.extname(entry.name))) {
          results.push(fullPath);
        }
        // Cap at 500 files for performance
        if (results.length >= 500) break;
      }
    } catch (_) { /* ignore permission errors */ }

    return results;
  }

  /**
   * Simple string hash for duplication detection (DJB2 algorithm).
   * @param {string} str
   * @returns {number}
   */
  _simpleHash(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
    }
    return hash;
  }
}

// Attach shared HTTP helpers
Object.assign(CodeQualityAdapter.prototype, HttpMixin);

module.exports = { CodeQualityAdapter };
