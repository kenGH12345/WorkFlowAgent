/**
 * Memory Manager – Deep Context Memory Builder & Maintainer
 *
 * Responsibilities (Requirement 5):
 *  - Generate AGENTS.md: global context overview for the entire project
 *  - Maintain per-package context files for Monorepo sub-packages
 *  - Watch for code changes and auto-sync memory files
 *  - Apply differentiated strategy based on project scale
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS, PROJECT_SCALE } = require('../core/constants');
const { getProjectStructure, selectToolStrategy, scanCodeSymbols } = require('../tools/thick-tools');
const { getConfig } = require('../core/config-loader');
const { buildSessionStartChecklist } = require('../core/prompt-builder');
const { renderCompactProfileSummary } = require('../core/project-profiler');

class MemoryManager {
  /**
   * @param {string} projectRoot - Root directory of the project to analyse
   */
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.agentsMdPath = path.join(projectRoot, 'AGENTS.md');
    this._watchHandles = [];
    // Load project config (workflow.config.js) for this projectRoot.
    // N46 fix: do NOT call clearConfigCache() here. N43 fix made getConfig(projectRoot)
    // bypass the module-level cache when projectRoot is provided, so clearConfigCache()
    // is redundant and harmful – it would wipe the cache entry written by Orchestrator
    // (or vice versa), breaking the "first caller writes, others reuse" invariant.
    this._config = getConfig(projectRoot);
  }

  // ─── Public API ───────────────────────────────────────────────────────────────

  /**
   * Builds or refreshes the global AGENTS.md context file.
   * Strategy is chosen automatically based on project scale.
   *
   * @returns {string} Path to the written AGENTS.md
   */
  async buildGlobalContext() {
    const { strategy } = selectToolStrategy(this.projectRoot);
    console.log(`[MemoryManager] Building global context (strategy: ${strategy})...`);

    const { summary: structureSummary } = getProjectStructure(this.projectRoot, strategy === 'thick' ? 2 : 4);
    const packageList = this._detectPackages();

    const extensions = this._config.sourceExtensions || ['.js', '.ts', '.py', '.go', '.java', '.cs', '.lua', '.dart'];
    const ignoreDirs  = this._config.ignoreDirs
      || ['node_modules', '.git', 'dist', 'build', 'output'];

    const extLabel = extensions.join(', ');
    console.log(`[MemoryManager] Scanning ${extLabel} code symbols...`);
    const { summary: symbolsSummary } = scanCodeSymbols(this.projectRoot, {
      extensions,
      ignoreDirs,
      maxFiles: 80,
    });

    const content = this._renderAgentsMd(structureSummary, packageList, strategy, symbolsSummary);

    fs.writeFileSync(this.agentsMdPath, content, 'utf-8');
    console.log(`[MemoryManager] AGENTS.md written: ${this.agentsMdPath}`);
    return this.agentsMdPath;
  }

  /**
   * Builds per-package context files for each detected sub-package.
   * Used in Monorepo scenarios (Requirement 5.2).
   *
   * @returns {string[]} Paths to all written package context files
   */
  async buildPackageContexts() {
    const packages = this._detectPackages();
    if (packages.length === 0) {
      console.log(`[MemoryManager] No sub-packages detected. Skipping package context build.`);
      return [];
    }

    const writtenPaths = [];
    for (const pkg of packages) {
      const contextPath = await this._buildPackageContext(pkg);
      writtenPaths.push(contextPath);
    }
    console.log(`[MemoryManager] Built ${writtenPaths.length} package context files.`);
    return writtenPaths;
  }

  /**
   * Watches the project for file changes and auto-updates the relevant
   * memory files when changes are detected (Requirement 5.3).
   *
   * @param {number} [debounceMs=2000] - Debounce delay in milliseconds
   */
  startWatching(debounceMs = 2000) {
    console.log(`[MemoryManager] Starting file watcher on: ${this.projectRoot}`);
    let debounceTimer = null;

    const watcher = fs.watch(this.projectRoot, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      // Ignore memory files themselves and common noise
      if (filename.includes('AGENTS.md') || filename.includes('node_modules') ||
          filename.includes('.git') || filename.includes('manifest.json')) return;

      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        console.log(`[MemoryManager] Change detected: ${filename}. Refreshing memory...`);
        await this._onFileChanged(filename);
      }, debounceMs);
    });

    // N69 fix: store debounceTimer reference alongside the watcher handle so
    // stopWatching() can clear it and prevent a pending timer from firing after
    // the watcher has been closed.
    this._watchHandles.push({ watcher, getTimer: () => debounceTimer, clearTimer: () => { clearTimeout(debounceTimer); debounceTimer = null; } });
    console.log(`[MemoryManager] Watcher active. Memory will auto-sync on changes.`);
  }

  /** Stops all active file watchers */
  stopWatching() {
    for (const handle of this._watchHandles) {
      // N69 fix: clear the debounce timer before closing the watcher so a pending
      // timer cannot fire _onFileChanged() after the watcher has been stopped.
      if (typeof handle.clearTimer === 'function') {
        handle.clearTimer();
        handle.watcher.close();
      } else {
        // Backward-compatible: plain watcher handle (no timer wrapper)
        handle.close();
      }
    }
    this._watchHandles = [];
    console.log(`[MemoryManager] File watchers stopped.`);
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────────

  /**
   * Detects sub-packages in the project.
   * Looks for directories containing a package.json (Monorepo pattern).
   *
   * @returns {Array<{name, dir, packageJsonPath}>}
   */
  _detectPackages() {
    const packages = [];
    const ignore = ['node_modules', '.git', 'dist', 'build'];

    try {
      const entries = fs.readdirSync(this.projectRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || ignore.includes(entry.name)) continue;
        const pkgJsonPath = path.join(this.projectRoot, entry.name, 'package.json');
        if (fs.existsSync(pkgJsonPath)) {
          const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
          packages.push({
            name: pkgJson.name || entry.name,
            dir: path.join(this.projectRoot, entry.name),
            packageJsonPath: pkgJsonPath,
          });
        }
      }
    } catch (err) {
      console.warn(`[MemoryManager] Could not detect packages: ${err.message}`);
    }

    return packages;
  }

  /**
   * Builds a context file for a single sub-package.
   *
   * @param {{ name, dir, packageJsonPath }} pkg
   * @returns {string} Path to the written context file
   */
  async _buildPackageContext(pkg) {
    const { summary } = getProjectStructure(pkg.dir, 3);
    const pkgJson = JSON.parse(fs.readFileSync(pkg.packageJsonPath, 'utf-8'));

    const content = [
      `# Package Context: ${pkg.name}`,
      ``,
      `> Auto-generated by MemoryManager. Last updated: ${new Date().toISOString()}`,
      ``,
      `## Package Info`,
      `- **Name**: ${pkgJson.name || 'unknown'}`,
      `- **Version**: ${pkgJson.version || 'unknown'}`,
      `- **Description**: ${pkgJson.description || 'N/A'}`,
      `- **Main**: ${pkgJson.main || 'N/A'}`,
      ``,
      `## Directory Structure`,
      '```',
      summary,
      '```',
      ``,
      `## Dependencies`,
      _renderDeps(pkgJson.dependencies),
      ``,
      `## Dev Dependencies`,
      _renderDeps(pkgJson.devDependencies),
    ].join('\n');

    const contextPath = path.join(pkg.dir, 'AGENTS.md');
    fs.writeFileSync(contextPath, content, 'utf-8');
    console.log(`[MemoryManager] Package context written: ${contextPath}`);
    return contextPath;
  }

  /**
   * Renders the global AGENTS.md content.
   */
  _renderAgentsMd(structureSummary, packages, strategy, symbolsSummary = '') {
    // N45 fix: use ### (h3) for the sub-package list heading so it sits correctly
    // under the ## (h2) section in AGENTS.md. The per-package AGENTS.md files
    // generated by _buildPackageContext() use # (h1) as their own document root,
    // which is correct for standalone files – no conflict with the global AGENTS.md.
    const pkgSection = packages.length > 0
      ? `## Sub-Packages (Monorepo)\n\n${packages.map(p => `- **${p.name}**: \`${path.relative(this.projectRoot, p.dir).replace(/\\/g, '/')}/\``).join('\n')}\n\nEach sub-package has its own \`AGENTS.md\` with detailed context.`
      : `## Project Type\n\nSingle repository (no sub-packages detected). Simplified memory structure applied.`;

    return [
      `# AGENTS.md – Global Project Context`,
      ``,
      `> Auto-generated by MemoryManager. Last updated: ${new Date().toISOString()}`,
      `> Strategy: **${strategy}** (${strategy === 'thick' ? 'large Monorepo' : 'small single repo'})`,
      ``,
      `## Purpose`,
      `This file provides global context for all AI agents operating in this project.`,
      `Agents should read this file at the start of each session to understand the project structure.`,
      ``,
      pkgSection,
      ``,
      `## Project Structure`,
      '```',
      structureSummary,
      '```',
      ``,
      `## Agent Guidelines`,
      `- Always read this file before starting a task`,
      `- For sub-packages, also read the package-specific \`AGENTS.md\``,
      `- Do not modify this file manually – it is auto-generated`,
      `- Report any inconsistencies to the workflow orchestrator`,
      `- **Output format**: Always begin your response with the indicator line \`> 🔄 启用wf工作流\` as the very first line, before any other content. During the working process, output brief phase results (e.g., "✅ Phase 1 done: ...", "🔍 Analyzing...", "📝 Writing...") to keep the user informed of progress.`,
      ``,
      `## \`/wf init\` Command Protocol`,
      ``,
      `When the user sends \`/wf init\` or \`/wf init --path <dir>\`, you **MUST** execute the initialisation script via **terminal**:`,
      ``,
      '```bash',
      `node workflow/init-project.js --path <project-root>`,
      '```',
      ``,
      `> ⚠️ **CRITICAL**: You MUST run this command in the terminal. Do NOT manually read files and generate a report yourself.`,
      `> Do NOT substitute a subdirectory for <project-root>. Always use the exact root directory the user specified.`,
      `> The script handles tech detection, config generation, AGENTS.md, experience store, skill registration, and **code-graph construction** automatically.`,
      ``,
      `### /wf <requirement> Workflow Execution`,
      ``,
      `When the user sends \`/wf <requirement>\` (not "init"), this triggers the **full workflow pipeline**:`,
      `ANALYSE → ARCHITECT → PLAN → CODE → TEST. You must respond with \`> 🔄 启用wf工作流\` and execute the pipeline.`,
      `Do NOT just read code and give analysis — you must run the actual multi-agent orchestration workflow.`,
      ``,
      buildSessionStartChecklist({
        progressFile: 'manifest.json',
        taskFile: 'output/tasks.json',
        featureListFile: 'output/feature-list.json',
        initScript: 'init.sh',
        requireSmokeTest: true,
      }),
      ``,
      // Inject Project Architecture Profile from ProjectProfiler analysis
      (() => {
        const profile = this._config.projectProfile;
        const summary = renderCompactProfileSummary(profile);
        return summary || '';
      })(),
      symbolsSummary ? `## Code Symbols\n\n${symbolsSummary}` : '',
    ].filter(Boolean).join('\n');
  }

  /**
   * Called when a file change is detected.
   * Determines which memory files need updating.
   */
  async _onFileChanged(filename) {
    // Determine if the changed file belongs to a sub-package
    const packages = this._detectPackages();
    // N36 fix: normalise both sides to forward-slashes before comparing.
    // On Windows, fs.watch may return filenames with forward-slashes while
    // path.relative() returns back-slashes (or vice versa depending on Node version),
    // causing startsWith() to silently fail and package context to never update.
    const normFilename = filename.replace(/\\/g, '/');
    const affectedPkg = packages.find(pkg => {
      const relDir = path.relative(this.projectRoot, pkg.dir).replace(/\\/g, '/');
      return normFilename.startsWith(relDir + '/') || normFilename === relDir;
    });

    if (affectedPkg) {
      await this._buildPackageContext(affectedPkg);
    }
    // Always refresh global context
    await this.buildGlobalContext();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _renderDeps(deps) {
  if (!deps || Object.keys(deps).length === 0) return '_None_';
  return Object.entries(deps).map(([k, v]) => `- \`${k}\`: ${v}`).join('\n');
}

module.exports = { MemoryManager };
