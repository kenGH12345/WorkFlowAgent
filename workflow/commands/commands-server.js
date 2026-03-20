/**
 * Server Commands — CLI entry point for WorkflowServer (P2-3)
 *
 * Registers the /serve command that starts the WorkflowServer in
 * long-running HTTP service mode with health check endpoints.
 *
 * Usage:
 *   /serve                      – Start server on default port 3100
 *   /serve --port 8080          – Start server on custom port
 *   /serve --host 127.0.0.1     – Bind to specific host
 */

'use strict';

/**
 * @param {Function} registerCommand - Command registration function from command-router.js
 */
function registerServerCommands(registerCommand) {

  registerCommand('serve', 'Start the workflow server in long-running HTTP service mode (POST /workflow to trigger)', async (args, context) => {
    const { WorkflowServer } = require('../core/workflow-server');

    // Parse arguments: --port <n> --host <addr>
    let port = 3100;
    let host = '0.0.0.0';

    const portMatch = args.match(/--port\s+(\d+)/);
    if (portMatch) port = parseInt(portMatch[1], 10);

    const hostMatch = args.match(/--host\s+([\w.]+)/);
    if (hostMatch) host = hostMatch[1];

    // The orchestratorFactory creates a fresh Orchestrator for each workflow request.
    // It requires `llmCall` from the context (provided by the IDE/CLI integration).
    if (!context.llmCall) {
      return '❌ Cannot start server: `llmCall` is not available in the current context. The /serve command requires an LLM provider to be configured.';
    }

    const orchestratorFactory = (opts) => {
      const { Orchestrator } = require('../index');
      return new Orchestrator({
        llmCall: context.llmCall,
        projectRoot: context.projectRoot || process.cwd(),
        ...opts,
      });
    };

    const server = new WorkflowServer({
      port,
      host,
      orchestratorFactory,
      defaultOrchestratorOpts: {
        projectRoot: context.projectRoot || process.cwd(),
      },
    });

    try {
      await server.start();
      return `🚀 WorkflowServer started on http://${host}:${port}\n` +
             `   Health:    GET  /healthz\n` +
             `   Readiness: GET  /readyz\n` +
             `   Status:    GET  /status\n` +
             `   Trigger:   POST /workflow { projectId, requirement }\n` +
             `   Stop:      SIGTERM / SIGINT`;
    } catch (err) {
      return `❌ Failed to start WorkflowServer: ${err.message}`;
    }
  });
}

module.exports = { registerServerCommands };
