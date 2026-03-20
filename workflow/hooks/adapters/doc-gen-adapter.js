/**
 * DocGenAdapter – API documentation skeleton & CHANGELOG auto-generation.
 *
 * Capabilities:
 *   1. Parse source files for exported functions/classes/types using tree-sitter
 *      style regex parsing (zero native deps) and generate JSDoc/TSDoc skeletons.
 *   2. Diff-based CHANGELOG.md generation: reads git log since last tag/commit
 *      and produces a conventional-commits CHANGELOG entry.
 *   3. Prompt injection: formats undocumented exports as a Markdown block for
 *      the DEVELOPER agent to generate inline documentation.
 *
 * Supported languages:
 *   - JavaScript / TypeScript (JSDoc / TSDoc)
 *   - Python (docstrings)
 *
 * Usage:
 *   const adapter = new DocGenAdapter({ projectRoot: '/path/to/project' });
 *   await adapter.connect();
 *   const undocumented = await adapter.findUndocumentedExports();
 *   const changelog = await adapter.generateChangelog();
 */

'use strict';

const { MCPAdapter } = require('./base');
const fs   = require('fs');
const path = require('path');

class DocGenAdapter extends MCPAdapter {
  /**
   * @param {object} config
   * @param {string}  [config.projectRoot]  - Project root directory
   * @param {string}  [config.outputDir]    - Output directory for generated docs
   * @param {number}  [config.maxFiles]     - Max source files to scan (default: 50)
   * @param {string[]} [config.sourceExts]  - Source file extensions to scan
   * @param {string[]} [config.ignoreDirs]  - Directories to ignore
   */
  constructor(config = {}) {
    super('doc-gen', config);
    this.projectRoot = config.projectRoot || process.cwd();
    this.outputDir = config.outputDir || path.join(this.projectRoot, 'output');
    this.maxFiles = config.maxFiles || 50;
    this.sourceExts = config.sourceExts || ['.js', '.ts', '.mjs', '.py'];
    this.ignoreDirs = config.ignoreDirs || ['node_modules', '.git', 'dist', 'build', 'output', '__pycache__', '.next'];
  }

  async connect() {
    this._connected = true;
    console.log(`[MCPAdapter:doc-gen] Connected (projectRoot: ${this.projectRoot}).`);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Scans source files and finds exported functions/classes that lack documentation.
   * Returns a structured list of undocumented exports.
   *
   * @param {object} [opts]
   * @param {number} [opts.maxFiles] - Override maxFiles
   * @returns {Promise<UndocumentedExportsResult>}
   */
  async findUndocumentedExports(opts = {}) {
    this._assertConnected();
    const maxFiles = opts.maxFiles || this.maxFiles;

    const sourceFiles = this._collectSourceFiles(this.projectRoot, maxFiles);
    console.log(`[MCPAdapter:doc-gen] Scanning ${sourceFiles.length} source file(s) for undocumented exports...`);

    const results = [];

    for (const filePath of sourceFiles) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const ext = path.extname(filePath);
        const relPath = path.relative(this.projectRoot, filePath);

        let exports;
        if (['.js', '.ts', '.mjs'].includes(ext)) {
          exports = this._parseJSExports(content, relPath);
        } else if (ext === '.py') {
          exports = this._parsePythonExports(content, relPath);
        }

        if (exports && exports.length > 0) {
          results.push(...exports);
        }
      } catch (err) {
        // Non-fatal: skip files that can't be parsed
      }
    }

    const total = results.length;
    const undocumented = results.filter(r => !r.hasDoc);
    console.log(`[MCPAdapter:doc-gen] Found ${undocumented.length}/${total} undocumented export(s).`);

    return {
      total,
      undocumentedCount: undocumented.length,
      exports: results,
      undocumented,
    };
  }

  /**
   * Generates a CHANGELOG entry based on git log since the last tag.
   * Follows conventional commits format.
   *
   * @param {object} [opts]
   * @param {string} [opts.since] - Git ref to start from (default: last tag or first commit)
   * @param {string} [opts.version] - Version string for the entry header
   * @returns {Promise<ChangelogResult>}
   */
  async generateChangelog(opts = {}) {
    this._assertConnected();

    const since = opts.since || this._getLastTag();
    const version = opts.version || this._getNextVersion();
    const today = new Date().toISOString().slice(0, 10);

    try {
      const { execSync } = require('child_process');
      const logCmd = since
        ? `git log ${since}..HEAD --pretty=format:"%s|||%an|||%h" --no-merges`
        : `git log --pretty=format:"%s|||%an|||%h" --no-merges -50`;

      const rawLog = execSync(logCmd, {
        cwd: this.projectRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      if (!rawLog) {
        return { version, date: today, entries: [], markdown: '' };
      }

      const commits = rawLog.split('\n').map(line => {
        const [subject, author, hash] = line.split('|||');
        return { subject: subject || '', author: author || '', hash: hash || '' };
      });

      // Categorise commits using conventional commit prefixes
      const categories = {
        feat: [],
        fix: [],
        perf: [],
        refactor: [],
        docs: [],
        test: [],
        chore: [],
        other: [],
      };

      for (const commit of commits) {
        const match = commit.subject.match(/^(\w+)(?:\([\w-]+\))?:\s*(.+)$/);
        if (match) {
          const type = match[1].toLowerCase();
          const msg = match[2];
          const cat = categories[type] ? type : 'other';
          categories[cat].push({ ...commit, message: msg });
        } else {
          categories.other.push({ ...commit, message: commit.subject });
        }
      }

      // Build Markdown
      const lines = [
        `## [${version}] - ${today}`,
        ``,
      ];

      const categoryLabels = {
        feat:     '### ✨ Features',
        fix:      '### 🐛 Bug Fixes',
        perf:     '### ⚡ Performance',
        refactor: '### ♻️ Refactoring',
        docs:     '### 📚 Documentation',
        test:     '### 🧪 Tests',
        chore:    '### 🔧 Chores',
        other:    '### 📝 Other Changes',
      };

      for (const [cat, label] of Object.entries(categoryLabels)) {
        if (categories[cat].length > 0) {
          lines.push(label);
          for (const entry of categories[cat]) {
            lines.push(`- ${entry.message} (\`${entry.hash}\`)`);
          }
          lines.push(``);
        }
      }

      const markdown = lines.join('\n');
      console.log(`[MCPAdapter:doc-gen] Generated CHANGELOG for ${version}: ${commits.length} commit(s).`);

      return {
        version,
        date: today,
        entries: commits,
        markdown,
        since,
      };
    } catch (err) {
      console.warn(`[MCPAdapter:doc-gen] CHANGELOG generation failed: ${err.message}`);
      return { version, date: today, entries: [], markdown: '', error: err.message };
    }
  }

  /**
   * Appends a CHANGELOG entry to CHANGELOG.md (creates if not exists).
   *
   * @param {string} changelogMd - Markdown content to prepend
   * @returns {string} Path to the CHANGELOG.md file
   */
  appendChangelog(changelogMd) {
    if (!changelogMd) return null;

    const changelogPath = path.join(this.projectRoot, 'CHANGELOG.md');
    let existing = '';

    if (fs.existsSync(changelogPath)) {
      existing = fs.readFileSync(changelogPath, 'utf-8');
    }

    // Prepend new entry after the main title (if exists) or at the top
    let newContent;
    if (existing.startsWith('# ')) {
      const firstNewline = existing.indexOf('\n');
      const header = existing.slice(0, firstNewline + 1);
      const rest = existing.slice(firstNewline + 1);
      newContent = `${header}\n${changelogMd}\n${rest}`;
    } else {
      newContent = `# Changelog\n\n${changelogMd}\n${existing}`;
    }

    fs.writeFileSync(changelogPath, newContent, 'utf-8');
    console.log(`[MCPAdapter:doc-gen] CHANGELOG.md updated at: ${changelogPath}`);
    return changelogPath;
  }

  /**
   * Formats undocumented exports into a Markdown block for prompt injection.
   * This block tells the DEVELOPER agent which functions/classes need documentation.
   *
   * @param {UndocumentedExportsResult} result
   * @returns {string}
   */
  formatUndocumentedBlock(result) {
    if (!result || result.undocumentedCount === 0) return '';

    const lines = [
      `## 📚 Undocumented API Exports`,
      `> The following ${result.undocumentedCount} exported function(s)/class(es) lack documentation.`,
      `> **Please add JSDoc/TSDoc/docstring comments** to these exports as part of your implementation.`,
      ``,
      `| File | Export | Type | Line |`,
      `|------|--------|------|------|`,
    ];

    for (const exp of result.undocumented.slice(0, 20)) {
      lines.push(`| \`${exp.file}\` | \`${exp.name}\` | ${exp.kind} | ${exp.line || '?'} |`);
    }

    if (result.undocumentedCount > 20) {
      lines.push(`| ... | ... | ... | ... |`);
      lines.push(`> ℹ️ Showing 20 of ${result.undocumentedCount} undocumented exports.`);
    }

    lines.push(``);
    lines.push(`> **Guidance**: Each exported function should have a JSDoc block describing parameters, return type, and purpose. Each exported class should document its constructor and public methods.`);

    return lines.join('\n');
  }

  // ── MCPAdapter interface ──────────────────────────────────────────────────

  async query(queryStr, params = {}) {
    this._assertConnected();
    if (queryStr === 'changelog') return this.generateChangelog(params);
    return this.findUndocumentedExports(params);
  }

  async notify(event, payload) {
    // DocGen generates on demand; no-op for notifications
  }

  // ── Private: Source file collection ───────────────────────────────────────

  _collectSourceFiles(dir, maxFiles, collected = []) {
    if (collected.length >= maxFiles) return collected;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (collected.length >= maxFiles) break;

        if (entry.isDirectory()) {
          if (this.ignoreDirs.includes(entry.name)) continue;
          this._collectSourceFiles(path.join(dir, entry.name), maxFiles, collected);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          if (this.sourceExts.includes(ext)) {
            collected.push(path.join(dir, entry.name));
          }
        }
      }
    } catch (_) { /* non-fatal */ }

    return collected;
  }

  // ── Private: JavaScript/TypeScript export parsing ─────────────────────────

  /**
   * Parses JS/TS source for exported functions, classes, and constants.
   * Checks if each has a preceding JSDoc comment block.
   *
   * @param {string} content - File content
   * @param {string} relPath - Relative file path
   * @returns {Array<{name: string, kind: string, file: string, line: number, hasDoc: boolean}>}
   */
  _parseJSExports(content, relPath) {
    const results = [];
    const lines = content.split('\n');

    // Patterns for exported declarations
    const exportPatterns = [
      // export function foo()
      { regex: /^\s*export\s+(?:async\s+)?function\s+(\w+)/,    kind: 'function' },
      // export class Foo
      { regex: /^\s*export\s+class\s+(\w+)/,                    kind: 'class' },
      // export const foo = ...
      { regex: /^\s*export\s+const\s+(\w+)/,                    kind: 'const' },
      // export default function foo / class Foo
      { regex: /^\s*export\s+default\s+(?:async\s+)?function\s+(\w+)/, kind: 'function' },
      { regex: /^\s*export\s+default\s+class\s+(\w+)/,          kind: 'class' },
    ];

    // module.exports pattern: module.exports = { Foo, bar }
    const moduleExportsMatch = content.match(/module\.exports\s*=\s*\{([^}]+)\}/);
    const moduleExportNames = moduleExportsMatch
      ? moduleExportsMatch[1].split(',').map(s => s.trim().split(':')[0].trim()).filter(Boolean)
      : [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check explicit export statements
      for (const { regex, kind } of exportPatterns) {
        const match = line.match(regex);
        if (match) {
          const name = match[1];
          const hasDoc = this._hasPrecedingJSDoc(lines, i);
          results.push({ name, kind, file: relPath, line: i + 1, hasDoc });
        }
      }

      // Check module.exports members: find their definitions and check for JSDoc
      if (moduleExportNames.length > 0) {
        for (const expName of moduleExportNames) {
          const funcMatch = line.match(new RegExp(`^\\s*(?:async\\s+)?function\\s+${expName}\\b`));
          const classMatch = line.match(new RegExp(`^\\s*class\\s+${expName}\\b`));

          if (funcMatch) {
            const hasDoc = this._hasPrecedingJSDoc(lines, i);
            results.push({ name: expName, kind: 'function', file: relPath, line: i + 1, hasDoc });
          } else if (classMatch) {
            const hasDoc = this._hasPrecedingJSDoc(lines, i);
            results.push({ name: expName, kind: 'class', file: relPath, line: i + 1, hasDoc });
          }
        }
      }
    }

    // Deduplicate by name
    const seen = new Set();
    return results.filter(r => {
      if (seen.has(r.name)) return false;
      seen.add(r.name);
      return true;
    });
  }

  /**
   * Checks if the lines preceding the given line index contain a JSDoc block.
   */
  _hasPrecedingJSDoc(lines, lineIndex) {
    // Look back up to 15 lines for a closing JSDoc comment
    for (let i = lineIndex - 1; i >= Math.max(0, lineIndex - 15); i--) {
      const trimmed = lines[i].trim();
      if (trimmed === '') continue;  // Skip blank lines
      if (trimmed.endsWith('*/')) return true;  // Found JSDoc end
      if (trimmed.startsWith('//')) continue;   // Single-line comments
      break;  // Hit non-comment code → no JSDoc
    }
    return false;
  }

  // ── Private: Python export parsing ────────────────────────────────────────

  /**
   * Parses Python source for top-level function/class definitions.
   * Checks if each has a docstring.
   */
  _parsePythonExports(content, relPath) {
    const results = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Top-level def (no indentation)
      const funcMatch = line.match(/^def\s+(\w+)\s*\(/);
      if (funcMatch) {
        const name = funcMatch[1];
        if (name.startsWith('_')) continue; // Skip private
        const hasDoc = this._hasFollowingDocstring(lines, i);
        results.push({ name, kind: 'function', file: relPath, line: i + 1, hasDoc });
      }

      // Top-level class
      const classMatch = line.match(/^class\s+(\w+)/);
      if (classMatch) {
        const name = classMatch[1];
        const hasDoc = this._hasFollowingDocstring(lines, i);
        results.push({ name, kind: 'class', file: relPath, line: i + 1, hasDoc });
      }
    }

    return results;
  }

  /**
   * Checks if the lines following a def/class contain a docstring.
   */
  _hasFollowingDocstring(lines, lineIndex) {
    for (let i = lineIndex + 1; i < Math.min(lines.length, lineIndex + 5); i++) {
      const trimmed = lines[i].trim();
      if (trimmed === '') continue;
      if (trimmed.startsWith('"""') || trimmed.startsWith("'''") || trimmed.startsWith('r"""')) return true;
      break;
    }
    return false;
  }

  // ── Private: Git helpers ──────────────────────────────────────────────────

  _getLastTag() {
    try {
      const { execSync } = require('child_process');
      return execSync('git describe --tags --abbrev=0', {
        cwd: this.projectRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch (_) {
      return null;
    }
  }

  _getNextVersion() {
    try {
      const pkgPath = path.join(this.projectRoot, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        return pkg.version || '0.0.1';
      }
    } catch (_) {}
    return '0.0.1';
  }

  _assertConnected() {
    if (!this._connected) throw new Error(`[MCPAdapter:doc-gen] Not connected. Call connect() first.`);
  }
}

module.exports = { DocGenAdapter };
