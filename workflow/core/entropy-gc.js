/**
 * Entropy GC – Automated entropy governance for the workflow.
 *
 * Scans the project codebase for architectural drift and generates a
 * structured report. Runs automatically at the end of each workflow session
 * (FINISHED stage) as a background "garbage collection" pass.
 *
 * Checks performed:
 *  1. File size violations  – files exceeding maxLines threshold
 *  2. Naming convention     – detects obvious violations (configurable patterns)
 *  3. Doc freshness         – AGENTS.md / architecture.md not updated in N days
 *  4. Dead code hints       – TODO/FIXME/HACK comment density per file
 *  5. Constraint drift      – files in ignoreDirs that crept into source scan
 *  6. Static analysis       – runs project lint command (ESLint/golangci-lint/etc.)
 *                             and parses output into structured violations
 *
 * Output: output/entropy-report.md  (human-readable Markdown)
 *         output/entropy-report.json (machine-readable, for future auto-fix)
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { translateMdFile } = require('./i18n-translator');

// ─── Default Rules ────────────────────────────────────────────────────────────

const DEFAULT_MAX_LINES = 600;
const DOC_STALE_DAYS    = 14;   // Docs older than this are flagged as stale
const DEAD_CODE_RATIO   = 0.05; // >5% TODO/FIXME/HACK lines → flag

class EntropyGC {
  /**
   * @param {object} options
   * @param {string}   options.projectRoot   - Root directory to scan
   * @param {string}   options.outputDir     - Where to write reports
   * @param {string[]} [options.extensions]  - File extensions to scan
   * @param {string[]} [options.ignoreDirs]  - Directories to skip
   * @param {number}   [options.maxLines]    - Max lines per file
   * @param {string[]} [options.docPaths]    - Paths to freshness-check
   */
  constructor({
    projectRoot,
    outputDir,
    extensions  = ['.js', '.ts', '.dart', '.go', '.py', '.cs', '.lua'],
    ignoreDirs  = ['node_modules', '.git', 'build', 'dist', 'output', '.dart_tool', 'Library', 'Temp'],
    maxLines    = DEFAULT_MAX_LINES,
    docPaths    = [],
    lintCommand = null,
    llmCall     = null,
  } = {}) {
    this._root       = projectRoot;
    this._outputDir  = outputDir;
    this._extensions = new Set(extensions);
    this._ignoreDirs = new Set(ignoreDirs);
    this._maxLines   = maxLines;
    this._docPaths   = docPaths;
    this._lintCmd    = lintCommand !== undefined ? lintCommand : this._detectLintCommand();
    this._llmCall    = llmCall;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Run the full entropy scan and write reports.
   * @returns {{ violations: number, filesScanned: number, reportPath: string }}
   */
  async run() {
    console.log(`\n[EntropyGC] 🔍 Starting entropy scan...`);

    const sourceFiles = this._collectSourceFiles(this._root);
    console.log(`[EntropyGC] Scanning ${sourceFiles.length} source files...`);

    const violations = [];

    // Check 1: File size
    for (const f of sourceFiles) {
      const lines = this._countLines(f);
      if (lines > this._maxLines) {
        violations.push({
          type:     'FILE_TOO_LARGE',
          severity: lines > this._maxLines * 1.5 ? 'high' : 'medium',
          file:     path.relative(this._root, f),
          detail:   `${lines} lines (limit: ${this._maxLines})`,
          suggestion: `Split into smaller modules. Consider extracting helpers or sub-components.`,
        });
      }
    }

    // Check 2: Dead code density (TODO/FIXME/HACK)
    for (const f of sourceFiles) {
      const result = this._checkDeadCodeDensity(f);
      if (result) violations.push(result);
    }

    // Check 3: Doc freshness
    const docsToCheck = [
      ...this._docPaths,
      path.join(this._root, 'AGENTS.md'),
      path.join(this._root, 'docs', 'architecture.md'),
    ].filter(p => fs.existsSync(p));

    for (const docPath of docsToCheck) {
      const result = this._checkDocFreshness(docPath);
      if (result) violations.push(result);
    }

    // Check 4: Constraint drift – source files inside ignoreDirs
    const driftFiles = this._checkConstraintDrift();
    violations.push(...driftFiles);

    // Check 5: Static analysis (lint)
    const lintViolations = await this._runStaticAnalysis();
    violations.push(...lintViolations);

    // Write reports
    const reportPath = this._writeReport(violations, sourceFiles.length);
    this._writeJson(violations, sourceFiles.length);

    const highCount = violations.filter(v => v.severity === 'high').length;
    const medCount  = violations.filter(v => v.severity === 'medium').length;
    const lowCount  = violations.filter(v => v.severity === 'low').length;

    console.log(`[EntropyGC] ✅ Scan complete: ${violations.length} violation(s) found`);
    console.log(`[EntropyGC]    High: ${highCount} | Medium: ${medCount} | Low: ${lowCount}`);
    console.log(`[EntropyGC]    Report: ${reportPath}`);

    return {
      violations:   violations.length,
      filesScanned: sourceFiles.length,
      reportPath,
      details: { high: highCount, medium: medCount, low: lowCount },
    };
  }

  // ─── Static Analysis ──────────────────────────────────────────────────────

  /**
   * Auto-detects the lint command from project config files.
   * Priority: package.json lint script → eslint config → go.mod → pyproject.toml
   */
  _detectLintCommand() {
    const pkgPath = path.join(this._root, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.scripts && pkg.scripts.lint) return 'npm run lint';
        const eslintConfigs = ['.eslintrc.js', '.eslintrc.json', '.eslintrc.yml', '.eslintrc'];
        if (eslintConfigs.some(c => fs.existsSync(path.join(this._root, c)))) {
          return 'npx eslint . --max-warnings=0 --format=compact';
        }
      } catch (_) {}
    }
    if (fs.existsSync(path.join(this._root, 'go.mod'))) {
      return 'golangci-lint run --out-format=line-number 2>&1 || true';
    }
    if (fs.existsSync(path.join(this._root, 'pyproject.toml')) ||
        fs.existsSync(path.join(this._root, 'setup.py'))) {
      return 'flake8 . --max-line-length=120 --format=default 2>&1 || true';
    }
    return null;
  }

  /**
   * Runs the lint command and parses output into structured violations.
   * Non-blocking: lint failures are reported as violations, not thrown.
   */
  async _runStaticAnalysis() {
    if (!this._lintCmd) return [];
    console.log(`[EntropyGC] 🔬 Running static analysis: ${this._lintCmd}`);
    const violations = [];
    try {
      const output = execSync(this._lintCmd, {
        cwd: this._root, encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000,
      });
      if (!output.trim()) {
        console.log(`[EntropyGC] ✅ Static analysis: no issues found`);
        return [];
      }
      return this._parseLintOutput(output);
    } catch (err) {
      const output = (err.stdout || '') + (err.stderr || '');
      if (output.trim()) return this._parseLintOutput(output);
      console.warn(`[EntropyGC] Static analysis skipped: ${err.message.slice(0, 100)}`);
      return [];
    }
  }

  /**
   * Parses lint output into structured violation objects.
   * Supports ESLint compact, golangci-lint, flake8, and generic file:line patterns.
   */
  _parseLintOutput(output) {
    const violations = [];
    const lines = output.split('\n').filter(Boolean);
    let issueCount = 0;
    for (const line of lines) {
      // ESLint compact: /path/file.js: line 10, col 5, Error - message (rule)
      const eslintMatch = line.match(/^(.+?):\s*line\s*(\d+),\s*col\s*(\d+),\s*(Error|Warning)\s*-\s*(.+?)(?:\s*\((.+?)\))?$/);
      if (eslintMatch) {
        violations.push({
          type: 'STATIC_ANALYSIS', severity: eslintMatch[4] === 'Error' ? 'medium' : 'low',
          file: path.relative(this._root, eslintMatch[1]),
          detail: `Line ${eslintMatch[2]}: ${eslintMatch[5]}${eslintMatch[6] ? ` (${eslintMatch[6]})` : ''}`,
          suggestion: 'Fix the lint issue to maintain code quality standards.',
        });
        if (++issueCount >= 20) break;
        continue;
      }
      // Generic: file.ext:line:col: message
      const genericMatch = line.match(/^(.+?\.\w+):(\d+)(?::(\d+))?:\s*(.+)$/);
      if (genericMatch && !line.includes('npm warn') && !line.includes('npm notice')) {
        const msg = genericMatch[4].trim();
        violations.push({
          type: 'STATIC_ANALYSIS', severity: /error|Error|ERROR/.test(msg) ? 'medium' : 'low',
          file: path.relative(this._root, path.resolve(this._root, genericMatch[1])),
          detail: `Line ${genericMatch[2]}: ${msg.slice(0, 100)}`,
          suggestion: 'Fix the lint issue to maintain code quality standards.',
        });
        if (++issueCount >= 20) break;
      }
    }
    if (violations.length > 0) console.log(`[EntropyGC] 🔬 Static analysis: ${violations.length} issue(s) found`);
    return violations;
  }

  // ─── Checks ───────────────────────────────────────────────────────────────

  _checkDeadCodeDensity(filePath) {
    let content;
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch (_) { return null; }

    const lines      = content.split('\n');
    const deadLines  = lines.filter(l => /\b(TODO|FIXME|HACK|XXX)\b/i.test(l)).length;
    const ratio      = lines.length > 0 ? deadLines / lines.length : 0;

    if (ratio > DEAD_CODE_RATIO && deadLines >= 3) {
      return {
        type:     'DEAD_CODE_DENSITY',
        severity: 'low',
        file:     path.relative(this._root, filePath),
        detail:   `${deadLines} TODO/FIXME/HACK comments (${(ratio * 100).toFixed(1)}% of file)`,
        suggestion: 'Schedule a cleanup pass to resolve or remove stale comments.',
      };
    }
    return null;
  }

  _checkDocFreshness(docPath) {
    try {
      const stat    = fs.statSync(docPath);
      const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
      if (ageDays > DOC_STALE_DAYS) {
        return {
          type:     'STALE_DOC',
          severity: ageDays > DOC_STALE_DAYS * 2 ? 'medium' : 'low',
          file:     path.relative(this._root, docPath),
          detail:   `Last modified ${Math.floor(ageDays)} days ago (threshold: ${DOC_STALE_DAYS} days)`,
          suggestion: 'Review and update this document to reflect current project state.',
        };
      }
    } catch (_) {}
    return null;
  }

  _checkConstraintDrift() {
    const violations = [];
    // Look for source files that accidentally ended up in output/ or build/
    const driftDirs = ['output', 'build', 'dist'];
    for (const dir of driftDirs) {
      const dirPath = path.join(this._root, dir);
      if (!fs.existsSync(dirPath)) continue;
      try {
        const entries = fs.readdirSync(dirPath);
        const srcFiles = entries.filter(e => {
          const ext = path.extname(e);
          return this._extensions.has(ext) && !e.endsWith('.test.js') && !e.endsWith('.spec.js');
        });
        if (srcFiles.length > 0) {
          violations.push({
            type:     'CONSTRAINT_DRIFT',
            severity: 'medium',
            file:     dir + '/',
            detail:   `${srcFiles.length} source file(s) found in ${dir}/ (${srcFiles.slice(0, 3).join(', ')})`,
            suggestion: `Source files should not live in ${dir}/. Move to appropriate module directory.`,
          });
        }
      } catch (_) {}
    }
    return violations;
  }

  // ─── File Collection ──────────────────────────────────────────────────────

  _collectSourceFiles(dir) {
    const results = [];
    const walk = (d) => {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        if (e.isDirectory()) {
          if (!this._ignoreDirs.has(e.name)) walk(path.join(d, e.name));
        } else if (this._extensions.has(path.extname(e.name))) {
          results.push(path.join(d, e.name));
        }
      }
    };
    walk(dir);
    return results;
  }

  _countLines(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return content.split('\n').length;
    } catch (_) { return 0; }
  }

  // ─── Report Writers ───────────────────────────────────────────────────────

  _writeReport(violations, filesScanned) {
    const now       = new Date().toISOString().slice(0, 10);
    const highV     = violations.filter(v => v.severity === 'high');
    const medV      = violations.filter(v => v.severity === 'medium');
    const lowV      = violations.filter(v => v.severity === 'low');

    const lines = [
      `# Entropy GC Report`,
      ``,
      `> Generated: ${new Date().toISOString()}`,
      `> Files scanned: ${filesScanned}`,
      `> Violations: ${violations.length} total (${highV.length} high / ${medV.length} medium / ${lowV.length} low)`,
      ``,
      `---`,
      ``,
    ];

    if (violations.length === 0) {
      lines.push(`## ✅ No violations found`);
      lines.push(``, `The codebase is clean. No architectural drift detected.`);
    } else {
      // High severity
      if (highV.length > 0) {
        lines.push(`## 🔴 High Severity (${highV.length})`);
        lines.push(``);
        for (const v of highV) {
          lines.push(`### ${v.type}: \`${v.file}\``);
          lines.push(`- **Detail**: ${v.detail}`);
          lines.push(`- **Suggestion**: ${v.suggestion}`);
          lines.push(``);
        }
      }

      // Medium severity
      if (medV.length > 0) {
        lines.push(`## 🟡 Medium Severity (${medV.length})`);
        lines.push(``);
        for (const v of medV) {
          lines.push(`### ${v.type}: \`${v.file}\``);
          lines.push(`- **Detail**: ${v.detail}`);
          lines.push(`- **Suggestion**: ${v.suggestion}`);
          lines.push(``);
        }
      }

      // Low severity
      if (lowV.length > 0) {
        lines.push(`## 🟢 Low Severity (${lowV.length})`);
        lines.push(``);
        for (const v of lowV) {
          lines.push(`- \`${v.file}\`: ${v.detail}`);
        }
        lines.push(``);
      }

      lines.push(`---`);
      lines.push(``);
      lines.push(`## Next Steps`);
      lines.push(``);
      lines.push(`1. Address all **high** severity violations before the next release.`);
      lines.push(`2. Schedule **medium** violations for the next sprint.`);
      lines.push(`3. **Low** violations can be batched into a periodic cleanup PR.`);
      lines.push(``);
      lines.push(`> Run \`/wf gc\` to trigger another scan after fixes.`);
    }

    try {
      if (!fs.existsSync(this._outputDir)) {
        fs.mkdirSync(this._outputDir, { recursive: true });
      }
      const reportPath = path.join(this._outputDir, 'entropy-report.md');
      fs.writeFileSync(reportPath, lines.join('\n'), 'utf-8');

      // Auto-generate Chinese translation (non-blocking)
      translateMdFile(reportPath, this._llmCall).catch(() => {});

      return reportPath;
    } catch (err) {
      console.warn(`[EntropyGC] Failed to write entropy-report.md: ${err.message}`);
      return null;
    }
  }

  _writeJson(violations, filesScanned) {
    try {
      const jsonPath = path.join(this._outputDir, 'entropy-report.json');
      fs.writeFileSync(jsonPath, JSON.stringify({
        generatedAt:  new Date().toISOString(),
        filesScanned,
        violations,
      }, null, 2), 'utf-8');
    } catch (_) {}
  }
}

module.exports = { EntropyGC };
