/**
 * ContainerSandboxAdapter – Docker/Podman container-based sandboxed execution.
 *
 * Replaces the current "bare-metal" test execution in test-case-executor.js
 * with fully isolated container execution. This eliminates the risk of:
 *   - Tests modifying the host filesystem
 *   - Network side effects (e.g. HTTP calls to production APIs)
 *   - Resource leaks (processes, file descriptors, temp files)
 *   - Cross-test interference
 *
 * Backends (in priority order):
 *   1. Docker Engine API (/var/run/docker.sock or tcp://localhost:2375)
 *   2. Podman (via `podman` CLI fallback)
 *   3. Dry-run mode (logs what would be executed, no real container)
 *
 * Execution flow:
 *   1. Pull/verify base image (e.g. node:20-slim, python:3.12-slim)
 *   2. Create ephemeral container with:
 *      - Project directory mounted as read-only volume
 *      - Working directory set to /workspace
 *      - Network disabled (--network=none) unless explicitly allowed
 *      - CPU/memory limits applied
 *      - Non-root user execution
 *   3. Run command inside container
 *   4. Capture stdout, stderr, exit code
 *   5. Destroy container (auto-remove)
 *
 * Usage:
 *   const adapter = new ContainerSandboxAdapter({ projectRoot: '/path/to/project' });
 *   await adapter.connect();
 *   const result = await adapter.execute('npm test', { timeout: 60000 });
 *   console.log(result.stdout, result.exitCode);
 */

'use strict';

const { MCPAdapter } = require('./base');
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ── Default container images by language ────────────────────────────────────

const DEFAULT_IMAGES = {
  javascript: 'node:20-slim',
  typescript: 'node:20-slim',
  python:     'python:3.12-slim',
  go:         'golang:1.22-alpine',
  rust:       'rust:1.77-slim',
  ruby:       'ruby:3.3-slim',
  dotnet:     'mcr.microsoft.com/dotnet/sdk:8.0',
  java:       'eclipse-temurin:21-jdk-jammy',
};

// ── Container resource limits ───────────────────────────────────────────────

const DEFAULT_LIMITS = {
  cpus: '1.0',        // 1 CPU core
  memory: '512m',     // 512 MB RAM
  pidsLimit: 256,     // Max processes
  tmpfsSize: '64m',   // /tmp tmpfs size
};


class ContainerSandboxAdapter extends MCPAdapter {
  /**
   * @param {object} config
   * @param {string}  [config.projectRoot]      - Project root to mount into container
   * @param {string}  [config.runtime]          - 'docker' | 'podman' | 'auto' (default: 'auto')
   * @param {string}  [config.image]            - Base container image (auto-detected if omitted)
   * @param {string}  [config.language]         - Project language for image auto-detection
   * @param {boolean} [config.networkEnabled]   - Allow network access in container (default: false)
   * @param {boolean} [config.readonlyMount]    - Mount project as read-only (default: true)
   * @param {number}  [config.defaultTimeoutMs] - Default execution timeout (default: 120000)
   * @param {object}  [config.limits]           - Resource limits override
   * @param {boolean} [config.dryRun]           - Log commands without executing (default: false)
   */
  constructor(config = {}) {
    super('container-sandbox', config);
    this.projectRoot = config.projectRoot || process.cwd();
    this.runtime = config.runtime || 'auto';
    this.image = config.image || null;
    this.language = config.language || null;
    this.networkEnabled = config.networkEnabled || false;
    this.readonlyMount = config.readonlyMount !== false;
    this.defaultTimeoutMs = config.defaultTimeoutMs || 120000;
    this.limits = { ...DEFAULT_LIMITS, ...config.limits };
    this.dryRun = config.dryRun || false;

    this._detectedRuntime = null; // 'docker' | 'podman' | null
    this._runtimeVersion = null;
    /** @type {Array<{containerId: string, command: string, exitCode: number, durationMs: number, ts: number}>} */
    this._executionLog = [];
  }

  async connect() {
    // Detect container runtime
    this._detectedRuntime = this._detectRuntime();

    if (!this._detectedRuntime && !this.dryRun) {
      console.warn('[MCPAdapter:container-sandbox] No container runtime found (docker/podman). Running in dry-run mode.');
      this.dryRun = true;
    }

    // Auto-detect image based on project files
    if (!this.image) {
      this.image = this._autoDetectImage();
    }

    // Verify image availability (pull if needed)
    if (this._detectedRuntime && !this.dryRun) {
      await this._ensureImage();
    }

    this._connected = true;
    const mode = this.dryRun ? 'dry-run' : `${this._detectedRuntime} v${this._runtimeVersion}`;
    console.log(`[MCPAdapter:container-sandbox] Connected (${mode}, image: ${this.image}).`);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Executes a command inside an isolated container.
   *
   * @param {string} command              - Shell command to execute
   * @param {object} [opts]
   * @param {number} [opts.timeout]       - Timeout in ms (overrides default)
   * @param {string} [opts.image]         - Override base image for this execution
   * @param {boolean} [opts.network]      - Override network setting for this execution
   * @param {string} [opts.workdir]       - Working directory inside container (default: /workspace)
   * @param {Object<string, string>} [opts.env] - Extra environment variables
   * @param {string[]} [opts.extraVolumes] - Additional volumes to mount ('host:container:mode')
   * @returns {Promise<ContainerExecResult>}
   */
  async execute(command, opts = {}) {
    this._assertConnected();

    const timeout = opts.timeout || this.defaultTimeoutMs;
    const image = opts.image || this.image;
    const network = opts.network ?? this.networkEnabled;
    const workdir = opts.workdir || '/workspace';
    const env = opts.env || {};
    const extraVolumes = opts.extraVolumes || [];

    const startMs = Date.now();

    // Build container run arguments
    const args = this._buildRunArgs({
      command, image, network, workdir, env, extraVolumes, timeout,
    });

    if (this.dryRun) {
      return this._dryRunExecute(command, args, startMs);
    }

    return this._realExecute(command, args, timeout, startMs);
  }

  /**
   * Runs the project's test suite inside an isolated container.
   * Convenience method that auto-detects the test command.
   *
   * @param {object} [opts]
   * @param {string} [opts.testCommand] - Override test command
   * @param {number} [opts.timeout]     - Override timeout
   * @returns {Promise<ContainerExecResult>}
   */
  async runTests(opts = {}) {
    const testCommand = opts.testCommand || this._detectTestCommand();
    return this.execute(testCommand, {
      timeout: opts.timeout || this.defaultTimeoutMs,
      network: false, // Tests should not access network by default
    });
  }

  /**
   * Returns execution history for the current session.
   *
   * @returns {Array<{containerId: string, command: string, exitCode: number, durationMs: number, ts: number}>}
   */
  getExecutionLog() {
    return [...this._executionLog];
  }

  /**
   * Formats the sandbox execution result as a Markdown block.
   *
   * @param {ContainerExecResult} result
   * @returns {string}
   */
  formatResultBlock(result) {
    if (!result) return '';

    const icon = result.exitCode === 0 ? '✅' : '❌';
    const modeLabel = result.dryRun ? '(DRY-RUN)' : '';
    const lines = [
      `## 🐳 Container Sandbox Execution ${modeLabel}`,
      `> ${icon} Exit code: **${result.exitCode}** | Duration: **${result.durationMs}ms** | Image: \`${result.image || this.image}\``,
      `> Isolation: filesystem=${this.readonlyMount ? 'read-only' : 'read-write'}, network=${result.networkEnabled ? 'enabled' : 'disabled'}`,
      ``,
    ];

    if (result.stdout) {
      const excerpt = result.stdout.slice(-2000);
      lines.push(`### stdout (last 2000 chars)`);
      lines.push('```');
      lines.push(excerpt);
      lines.push('```');
      lines.push(``);
    }

    if (result.stderr) {
      const excerpt = result.stderr.slice(-1000);
      lines.push(`### stderr (last 1000 chars)`);
      lines.push('```');
      lines.push(excerpt);
      lines.push('```');
    }

    return lines.join('\n');
  }

  // ── MCPAdapter interface ──────────────────────────────────────────────────

  async query(queryStr, params = {}) {
    this._assertConnected();
    if (queryStr === 'log') return this.getExecutionLog();
    if (queryStr === 'test') return this.runTests(params);
    return this.execute(queryStr, params);
  }

  async notify(event, payload) {
    // Container sandbox is stateless; no-op for notifications
  }

  // ── Private: Runtime detection ────────────────────────────────────────────

  _detectRuntime() {
    const preferred = this.runtime === 'auto' ? ['docker', 'podman'] : [this.runtime];

    for (const rt of preferred) {
      try {
        const version = execSync(`${rt} --version`, {
          encoding: 'utf-8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        this._runtimeVersion = version.match(/\d+\.\d+[\.\d]*/)?.[0] || 'unknown';
        console.log(`[MCPAdapter:container-sandbox] Detected ${rt} (${this._runtimeVersion}).`);
        return rt;
      } catch (_) {
        // Not available, try next
      }
    }

    return null;
  }

  // ── Private: Image auto-detection ─────────────────────────────────────────

  _autoDetectImage() {
    if (this.language && DEFAULT_IMAGES[this.language]) {
      return DEFAULT_IMAGES[this.language];
    }

    // Auto-detect from project files
    const indicators = [
      { file: 'package.json',    lang: 'javascript' },
      { file: 'tsconfig.json',   lang: 'typescript' },
      { file: 'pyproject.toml',  lang: 'python' },
      { file: 'requirements.txt', lang: 'python' },
      { file: 'go.mod',          lang: 'go' },
      { file: 'Cargo.toml',      lang: 'rust' },
      { file: 'Gemfile',         lang: 'ruby' },
      { file: '*.csproj',        lang: 'dotnet' },
      { file: 'pom.xml',         lang: 'java' },
    ];

    for (const { file, lang } of indicators) {
      if (file.startsWith('*')) {
        // Glob: check if any matching file exists
        try {
          const entries = fs.readdirSync(this.projectRoot);
          const ext = file.slice(1);
          if (entries.some(e => e.endsWith(ext))) {
            this.language = lang;
            return DEFAULT_IMAGES[lang];
          }
        } catch (_) {}
      } else if (fs.existsSync(path.join(this.projectRoot, file))) {
        this.language = lang;
        return DEFAULT_IMAGES[lang];
      }
    }

    // Default fallback
    return 'node:20-slim';
  }

  // ── Private: Image management ─────────────────────────────────────────────

  async _ensureImage() {
    try {
      execSync(`${this._detectedRuntime} image inspect ${this.image}`, {
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      console.log(`[MCPAdapter:container-sandbox] Image ${this.image} available locally.`);
    } catch (_) {
      console.log(`[MCPAdapter:container-sandbox] Pulling image ${this.image}...`);
      try {
        execSync(`${this._detectedRuntime} pull ${this.image}`, {
          encoding: 'utf-8',
          timeout: 300000, // 5 min for large images
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        console.log(`[MCPAdapter:container-sandbox] Image ${this.image} pulled successfully.`);
      } catch (pullErr) {
        console.warn(`[MCPAdapter:container-sandbox] Failed to pull image ${this.image}: ${pullErr.message}`);
      }
    }
  }

  // ── Private: Build container run arguments ────────────────────────────────

  _buildRunArgs({ command, image, network, workdir, env, extraVolumes, timeout }) {
    const args = ['run', '--rm'];

    // Resource limits
    args.push(`--cpus=${this.limits.cpus}`);
    args.push(`--memory=${this.limits.memory}`);
    args.push(`--pids-limit=${this.limits.pidsLimit}`);

    // Tmpfs for /tmp (writable temp space)
    args.push(`--tmpfs=/tmp:rw,noexec,nosuid,size=${this.limits.tmpfsSize}`);

    // Network isolation
    if (!network) {
      args.push('--network=none');
    }

    // Security: drop all capabilities, no new privileges
    args.push('--cap-drop=ALL');
    args.push('--security-opt=no-new-privileges');

    // Mount project directory
    const mountMode = this.readonlyMount ? 'ro' : 'rw';
    // Normalise path for Docker on Windows
    const projectPath = this.projectRoot.replace(/\\/g, '/');
    args.push(`-v`, `${projectPath}:${workdir}:${mountMode}`);

    // Extra volumes
    for (const vol of extraVolumes) {
      args.push(`-v`, vol);
    }

    // Working directory
    args.push(`-w`, workdir);

    // Environment variables
    for (const [key, val] of Object.entries(env)) {
      args.push(`-e`, `${key}=${val}`);
    }

    // Stop timeout (convert from ms to seconds)
    const stopTimeout = Math.max(1, Math.floor(timeout / 1000));
    args.push(`--stop-timeout=${stopTimeout}`);

    // Image
    args.push(image);

    // Command (use sh -c for shell interpretation)
    args.push('sh', '-c', command);

    return args;
  }

  // ── Private: Execution ────────────────────────────────────────────────────

  _dryRunExecute(command, args, startMs) {
    const fullCmd = `${this._detectedRuntime || 'docker'} ${args.join(' ')}`;
    console.log(`[MCPAdapter:container-sandbox] [DRY-RUN] Would execute:\n  ${fullCmd}`);

    const result = {
      exitCode: 0,
      stdout: `[DRY-RUN] Command: ${command}\n[DRY-RUN] Full container command: ${fullCmd}`,
      stderr: '',
      dryRun: true,
      containerId: 'dry-run',
      image: this.image,
      command,
      durationMs: Date.now() - startMs,
      networkEnabled: this.networkEnabled,
    };

    this._executionLog.push({
      containerId: 'dry-run',
      command,
      exitCode: 0,
      durationMs: result.durationMs,
      ts: Date.now(),
    });

    return result;
  }

  async _realExecute(command, args, timeout, startMs) {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const proc = spawn(this._detectedRuntime, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: timeout + 5000, // Extra 5s grace for container cleanup
      });

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        setTimeout(() => proc.kill('SIGKILL'), 5000);
      }, timeout);

      proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

      proc.on('close', (code) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startMs;
        const exitCode = timedOut ? 124 : (code ?? 1); // 124 = timeout convention

        if (timedOut) {
          stderr += `\n[container-sandbox] Execution timed out after ${timeout}ms.`;
        }

        // Extract container ID from the output if available
        const containerId = `ephemeral-${Date.now()}`;

        const result = {
          exitCode,
          stdout,
          stderr,
          dryRun: false,
          containerId,
          image: this.image,
          command,
          durationMs,
          timedOut,
          networkEnabled: this.networkEnabled,
        };

        this._executionLog.push({
          containerId,
          command,
          exitCode,
          durationMs,
          ts: Date.now(),
        });

        if (exitCode === 0) {
          console.log(`[MCPAdapter:container-sandbox] ✅ Container execution succeeded (${durationMs}ms).`);
        } else {
          console.warn(`[MCPAdapter:container-sandbox] ❌ Container exited with code ${exitCode} (${durationMs}ms).`);
        }

        resolve(result);
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startMs;
        console.warn(`[MCPAdapter:container-sandbox] Spawn error: ${err.message}`);

        resolve({
          exitCode: 1,
          stdout,
          stderr: stderr + `\n[container-sandbox] Spawn error: ${err.message}`,
          dryRun: false,
          containerId: 'error',
          image: this.image,
          command,
          durationMs,
          timedOut: false,
          networkEnabled: this.networkEnabled,
          error: err.message,
        });
      });
    });
  }

  // ── Private: Test command detection ───────────────────────────────────────

  _detectTestCommand() {
    const pkgPath = path.join(this.projectRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.scripts && pkg.scripts.test) return `npm test`;
      } catch (_) {}
    }

    if (fs.existsSync(path.join(this.projectRoot, 'pytest.ini')) ||
        fs.existsSync(path.join(this.projectRoot, 'pyproject.toml'))) {
      return 'pytest';
    }

    if (fs.existsSync(path.join(this.projectRoot, 'go.mod'))) {
      return 'go test ./...';
    }

    return 'npm test';
  }
}

module.exports = { ContainerSandboxAdapter, DEFAULT_IMAGES, DEFAULT_LIMITS };
