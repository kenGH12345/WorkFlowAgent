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

  // ─── /serve-mcp: Start MCP Server (stdio transport for IDE integration) ───
  registerCommand('serve-mcp', 'Start the MCP protocol server on stdio for IDE plugin integration', async (args, context) => {
    const path = require('path');
    const { MCPServer } = require('../core/mcp-server');

    // Parse --project-root argument
    let projectRoot = context.projectRoot || context.orchestrator?.projectRoot || process.cwd();
    const rootMatch = args.match(/--project-root\s+(\S+)/);
    if (rootMatch) projectRoot = path.resolve(rootMatch[1]);

    // Build orchestrator factory if llmCall is available
    let orchestratorFactory = null;
    if (context.llmCall) {
      orchestratorFactory = (opts) => {
        const { Orchestrator } = require('../index');
        return new Orchestrator({
          llmCall: context.llmCall,
          projectRoot: opts.projectRoot || projectRoot,
          ...opts,
        });
      };
    }

    const server = new MCPServer({
      projectRoot,
      orchestratorFactory,
      llmCall: context.llmCall || null,
    });

    server.start();

    return [
      `🔌 MCP Server started on stdio transport.`,
      ``,
      `   Project root: ${projectRoot}`,
      `   Protocol: JSON-RPC 2.0 over stdin/stdout`,
      `   Tools: workflow_triage, workflow_run, workflow_init, workflow_status`,
      `   Workflow execution: ${orchestratorFactory ? '✅ Available (LLM configured)' : '⚠️ Limited (no LLM provider)'}`,
      ``,
      `   To connect from an IDE, add to MCP config:`,
      `   {`,
      `     "mcpServers": {`,
      `       "workflowagent": {`,
      `         "command": "node",`,
      `         "args": ["workflow/core/mcp-server.js", "--project-root", "${projectRoot}"]`,
      `       }`,
      `     }`,
      `   }`,
    ].join('\n');
  });

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
