/**
 * Workflow Doctor Command (P1-3, Hightower)
 *
 * Similar to `flutter doctor` — checks all external dependencies, environment
 * prerequisites, and system health before starting a workflow.
 *
 * Checks:
 *   1. Node.js version (≥16 required)
 *   2. npm / package.json dependencies installed
 *   3. workflow.config.js existence and validity
 *   4. AGENTS.md existence
 *   5. Output directory writable
 *   6. Git availability
 *   7. LLM API connectivity (optional, requires orchestrator context)
 *   8. MCP adapter connectivity
 *   9. CLI tools for detected tech stack (flutter, cargo, go, etc.)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { PATHS } = require('../core/constants');

/**
 * Registers the /workflow-doctor command.
 *
 * @param {Function} registerCommand - The registerCommand function from command-router.js
 */
function registerDoctorCommands(registerCommand) {

  registerCommand(
    'workflow-doctor',
    'Check environment prerequisites, dependencies, and system health. Usage: /workflow-doctor [--verbose]',
    async (args, context) => {
      const verbose = (args || '').includes('--verbose');
      const checks = [];
      const startTime = Date.now();

      // ── Helper ────────────────────────────────────────────────────────
      function check(name, fn) {
        try {
          const result = fn();
          checks.push({ name, ...result });
        } catch (err) {
          checks.push({ name, status: '❌', message: err.message });
        }
      }

      // ── 1. Node.js Version ────────────────────────────────────────────
      check('Node.js version', () => {
        const version = process.version;
        const major = parseInt(version.slice(1).split('.')[0], 10);
        if (major >= 16) {
          return { status: '✅', message: `${version} (≥16 required)` };
        }
        return { status: '❌', message: `${version} — Node.js ≥16 is required. Please upgrade.` };
      });

      // ── 2. Dependencies installed ─────────────────────────────────────
      check('npm dependencies', () => {
        const pkgPath = path.join(__dirname, '..', 'package.json');
        const nodeModules = path.join(__dirname, '..', 'node_modules');
        if (!fs.existsSync(pkgPath)) {
          return { status: '⚠️', message: 'package.json not found' };
        }
        if (!fs.existsSync(nodeModules)) {
          return { status: '❌', message: 'node_modules/ not found. Run: npm install' };
        }
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const deps = Object.keys(pkg.dependencies || {});
        const missing = deps.filter(d => !fs.existsSync(path.join(nodeModules, d)));
        if (missing.length > 0) {
          return { status: '❌', message: `Missing: ${missing.join(', ')}. Run: npm install` };
        }
        return { status: '✅', message: `${deps.length} dependencies installed` };
      });

      // ── 3. workflow.config.js ─────────────────────────────────────────
      check('workflow.config.js', () => {
        const configPath = path.join(__dirname, '..', 'workflow.config.js');
        if (!fs.existsSync(configPath)) {
          return { status: '⚠️', message: 'Not found. Run: /wf init to generate.' };
        }
        try {
          const config = require(configPath);
          const hasStack = config.techStack || config.sourceExtensions;
          return { status: '✅', message: `Found (techStack: ${config.techStack || 'auto-detect'})` };
        } catch (err) {
          return { status: '❌', message: `Parse error: ${err.message}` };
        }
      });

      // ── 4. AGENTS.md ──────────────────────────────────────────────────
      check('AGENTS.md', () => {
        if (fs.existsSync(PATHS.AGENTS_MD)) {
          const size = fs.statSync(PATHS.AGENTS_MD).size;
          return { status: '✅', message: `Found (${(size / 1024).toFixed(1)} KB)` };
        }
        return { status: '⚠️', message: 'Not found. Run: /wf init to generate.' };
      });

      // ── 5. Output directory ───────────────────────────────────────────
      check('Output directory', () => {
        const dir = PATHS.OUTPUT_DIR;
        if (fs.existsSync(dir)) {
          // Test write access
          const testFile = path.join(dir, '.doctor-test');
          try {
            fs.writeFileSync(testFile, 'test', 'utf-8');
            fs.unlinkSync(testFile);
            return { status: '✅', message: `${dir} (writable)` };
          } catch (err) {
            return { status: '❌', message: `${dir} exists but NOT writable: ${err.message}` };
          }
        }
        return { status: '⚠️', message: `${dir} does not exist (will be created on first run)` };
      });

      // ── 6. Git ────────────────────────────────────────────────────────
      check('Git', () => {
        try {
          const version = execSync('git --version', { timeout: 5000 }).toString().trim();
          return { status: '✅', message: version };
        } catch {
          return { status: '⚠️', message: 'Not found. Git is optional but needed for PR workflow.' };
        }
      });

      // ── 7. Skills directory ───────────────────────────────────────────
      check('Skills directory', () => {
        if (fs.existsSync(PATHS.SKILLS_DIR)) {
          const skills = fs.readdirSync(PATHS.SKILLS_DIR).filter(f => f.endsWith('.md'));
          return { status: '✅', message: `${skills.length} skill file(s) found` };
        }
        return { status: '⚠️', message: 'skills/ directory not found' };
      });

      // ── 8. Tech stack CLI tools ───────────────────────────────────────
      check('Tech stack CLI tools', () => {
        const toolChecks = [
          { cmd: 'flutter --version', name: 'Flutter', timeout: 10000 },
          { cmd: 'cargo --version', name: 'Cargo (Rust)', timeout: 5000 },
          { cmd: 'go version', name: 'Go', timeout: 5000 },
          { cmd: 'dotnet --version', name: '.NET', timeout: 5000 },
          { cmd: 'python --version', name: 'Python', timeout: 5000 },
          { cmd: 'java -version', name: 'Java', timeout: 5000 },
        ];
        const found = [];
        const notFound = [];
        for (const t of toolChecks) {
          try {
            execSync(t.cmd, { timeout: t.timeout, stdio: 'pipe' });
            found.push(t.name);
          } catch {
            notFound.push(t.name);
          }
        }
        if (found.length > 0) {
          return { status: '✅', message: `Found: ${found.join(', ')}` };
        }
        return { status: 'ℹ️', message: `No tech stack CLI tools detected (checked: ${toolChecks.map(t => t.name).join(', ')})` };
      });

      // ── 9. MCP adapters ───────────────────────────────────────────────
      if (context.orchestrator && context.orchestrator.mcpRegistry) {
        check('MCP adapters', () => {
          const registry = context.orchestrator.mcpRegistry;
          const adapters = registry.getAll ? registry.getAll() : [];
          const connected = adapters.filter(a => a.isConnected);
          if (adapters.length === 0) {
            return { status: 'ℹ️', message: 'No MCP adapters configured' };
          }
          return {
            status: connected.length === adapters.length ? '✅' : '⚠️',
            message: `${connected.length}/${adapters.length} connected`,
          };
        });
      }

      // ── Format report ─────────────────────────────────────────────────
      const elapsed = Date.now() - startTime;
      const passed = checks.filter(c => c.status === '✅').length;
      const warnings = checks.filter(c => c.status === '⚠️' || c.status === 'ℹ️').length;
      const errors = checks.filter(c => c.status === '❌').length;

      const lines = [
        `## 🩺 Workflow Doctor`,
        ``,
        ...checks.map(c => `${c.status} **${c.name}** — ${c.message}`),
        ``,
        `---`,
        ``,
        `**Summary**: ${passed} passed, ${warnings} warning(s), ${errors} error(s) | ${elapsed}ms`,
        ``,
      ];

      if (errors > 0) {
        lines.push(`> ❌ **${errors} issue(s) must be fixed** before running a workflow.`);
      } else if (warnings > 0) {
        lines.push(`> ⚠️ All critical checks passed. ${warnings} warning(s) can be addressed for optimal experience.`);
      } else {
        lines.push(`> ✅ **All checks passed!** Your environment is ready for CodexForge.`);
      }

      return lines.join('\n');
    }
  );

}

module.exports = { registerDoctorCommands };
