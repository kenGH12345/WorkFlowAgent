/**
 * Workflow Server — Long-Running Service Mode + Health Check (P2-3, Hightower)
 *
 * Problem: CodexForge workflows are currently CLI-only, one-shot processes.
 * In production environments (CI/CD, team dashboards, scheduled runs),
 * a persistent HTTP service mode is needed for:
 *   1. Triggering workflows via HTTP API
 *   2. Health monitoring (/healthz, /readyz)
 *   3. Workflow status queries
 *   4. Graceful shutdown with in-flight workflow completion
 *
 * Design:
 *   - Zero new dependencies (uses Node.js built-in `http` module)
 *   - Minimal footprint: <200 lines
 *   - Integrates with existing Orchestrator constructor
 *   - Graceful shutdown: SIGTERM/SIGINT → finish current workflow → close
 *
 * Usage:
 *   const { WorkflowServer } = require('./core/workflow-server');
 *   const server = new WorkflowServer({ port: 3100, orchestratorFactory: (opts) => new Orchestrator(opts) });
 *   server.start();
 */

'use strict';

const http = require('http');

// ─── Health Status ──────────────────────────────────────────────────────────

const ServiceStatus = {
  STARTING:  'starting',
  READY:     'ready',
  BUSY:      'busy',      // Workflow currently running
  DRAINING:  'draining',  // Shutting down, finishing current workflow
  STOPPED:   'stopped',
};

// ─── Workflow Server ────────────────────────────────────────────────────────

class WorkflowServer {
  /**
   * @param {object} opts
   * @param {number}   [opts.port=3100]              - HTTP port
   * @param {string}   [opts.host='0.0.0.0']         - Bind address
   * @param {Function} opts.orchestratorFactory       - (opts) => Orchestrator instance
   * @param {object}   [opts.defaultOrchestratorOpts] - Default Orchestrator constructor options
   */
  constructor({ port = 3100, host = '0.0.0.0', orchestratorFactory, defaultOrchestratorOpts = {} } = {}) {
    if (typeof orchestratorFactory !== 'function') {
      throw new Error('[WorkflowServer] orchestratorFactory is required and must be a function.');
    }

    this._port = port;
    this._host = host;
    this._orchestratorFactory = orchestratorFactory;
    this._defaultOrchestratorOpts = defaultOrchestratorOpts;
    this._status = ServiceStatus.STOPPED;
    this._server = null;
    this._startedAt = null;
    this._requestCount = 0;
    this._workflowCount = 0;
    this._currentWorkflow = null; // { projectId, startTime, promise }
    this._shutdownPromise = null;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Starts the HTTP server.
   * @returns {Promise<void>}
   */
  start() {
    return new Promise((resolve, reject) => {
      this._status = ServiceStatus.STARTING;

      this._server = http.createServer((req, res) => this._handleRequest(req, res));

      this._server.listen(this._port, this._host, () => {
        this._status = ServiceStatus.READY;
        this._startedAt = new Date().toISOString();
        console.log(`[WorkflowServer] 🚀 Listening on http://${this._host}:${this._port}`);
        console.log(`[WorkflowServer]    Health: GET /healthz | Readiness: GET /readyz`);
        console.log(`[WorkflowServer]    Trigger: POST /workflow { projectId, requirement }`);
        resolve();
      });

      this._server.on('error', (err) => {
        this._status = ServiceStatus.STOPPED;
        reject(err);
      });

      // Graceful shutdown handlers
      const shutdown = () => this.stop();
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    });
  }

  /**
   * Gracefully stops the server.
   * Waits for any in-flight workflow to complete before closing.
   * @returns {Promise<void>}
   */
  async stop() {
    if (this._status === ServiceStatus.STOPPED || this._shutdownPromise) {
      return this._shutdownPromise;
    }

    this._status = ServiceStatus.DRAINING;
    console.log(`[WorkflowServer] 🛑 Graceful shutdown initiated...`);

    this._shutdownPromise = (async () => {
      // Wait for in-flight workflow
      if (this._currentWorkflow) {
        console.log(`[WorkflowServer]    Waiting for in-flight workflow "${this._currentWorkflow.projectId}"...`);
        try {
          await this._currentWorkflow.promise;
        } catch {
          // Workflow may fail; that's OK for shutdown
        }
      }

      // Close HTTP server
      await new Promise((resolve) => {
        if (this._server) {
          this._server.close(() => resolve());
        } else {
          resolve();
        }
      });

      this._status = ServiceStatus.STOPPED;
      console.log(`[WorkflowServer] ✅ Server stopped. Total: ${this._workflowCount} workflow(s), ${this._requestCount} request(s).`);
    })();

    return this._shutdownPromise;
  }

  // ─── HTTP Handler ───────────────────────────────────────────────────────

  async _handleRequest(req, res) {
    this._requestCount++;
    const url = new URL(req.url, `http://${req.headers.host}`);
    const method = req.method.toUpperCase();
    const pathname = url.pathname;

    try {
      // ── Health Check (Liveness) ─────────────────────────────────────
      if (pathname === '/healthz' && method === 'GET') {
        return this._json(res, 200, {
          status: 'ok',
          service: 'codexforge-workflow',
          uptime: this._startedAt ? Math.round((Date.now() - new Date(this._startedAt).getTime()) / 1000) : 0,
          startedAt: this._startedAt,
        });
      }

      // ── Readiness Check ─────────────────────────────────────────────
      if (pathname === '/readyz' && method === 'GET') {
        const ready = this._status === ServiceStatus.READY;
        return this._json(res, ready ? 200 : 503, {
          status: ready ? 'ready' : this._status,
          currentWorkflow: this._currentWorkflow ? this._currentWorkflow.projectId : null,
          workflowCount: this._workflowCount,
        });
      }

      // ── Status ──────────────────────────────────────────────────────
      if (pathname === '/status' && method === 'GET') {
        return this._json(res, 200, {
          status: this._status,
          startedAt: this._startedAt,
          requestCount: this._requestCount,
          workflowCount: this._workflowCount,
          currentWorkflow: this._currentWorkflow ? {
            projectId: this._currentWorkflow.projectId,
            startedAt: this._currentWorkflow.startTime,
            elapsed: Math.round((Date.now() - new Date(this._currentWorkflow.startTime).getTime()) / 1000),
          } : null,
        });
      }

      // ── Trigger Workflow ────────────────────────────────────────────
      if (pathname === '/workflow' && method === 'POST') {
        // Parse request body
        const body = await this._readBody(req);
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          return this._json(res, 400, { error: 'Invalid JSON body' });
        }

        if (!payload.projectId || !payload.requirement) {
          return this._json(res, 400, { error: 'Missing required fields: projectId, requirement' });
        }

        // Reject if busy
        if (this._status !== ServiceStatus.READY) {
          return this._json(res, 503, {
            error: `Server is ${this._status}. Cannot accept new workflows.`,
            currentWorkflow: this._currentWorkflow?.projectId || null,
          });
        }

        // Start workflow (non-blocking: respond immediately, run in background)
        const orchOpts = {
          ...this._defaultOrchestratorOpts,
          projectId: payload.projectId,
          ...payload.orchestratorOpts,
        };

        const orchestrator = this._orchestratorFactory(orchOpts);
        const startTime = new Date().toISOString();

        this._status = ServiceStatus.BUSY;
        this._workflowCount++;

        const workflowPromise = orchestrator.run(payload.requirement)
          .then(() => {
            console.log(`[WorkflowServer] ✅ Workflow "${payload.projectId}" completed.`);
          })
          .catch((err) => {
            console.error(`[WorkflowServer] ❌ Workflow "${payload.projectId}" failed: ${err.message}`);
          })
          .finally(() => {
            this._currentWorkflow = null;
            if (this._status === ServiceStatus.BUSY) {
              this._status = ServiceStatus.READY;
            }
          });

        this._currentWorkflow = {
          projectId: payload.projectId,
          startTime,
          promise: workflowPromise,
        };

        return this._json(res, 202, {
          message: 'Workflow started',
          projectId: payload.projectId,
          startTime,
        });
      }

      // ── 404 ─────────────────────────────────────────────────────────
      return this._json(res, 404, {
        error: 'Not found',
        endpoints: [
          'GET  /healthz  — liveness probe',
          'GET  /readyz   — readiness probe',
          'GET  /status   — detailed server status',
          'POST /workflow  — trigger a workflow { projectId, requirement }',
        ],
      });
    } catch (err) {
      return this._json(res, 500, { error: err.message });
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  _json(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
  }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  }

  // ─── Getters ──────────────────────────────────────────────────────────

  get status() { return this._status; }
  get port() { return this._port; }
}

module.exports = { WorkflowServer, ServiceStatus };
