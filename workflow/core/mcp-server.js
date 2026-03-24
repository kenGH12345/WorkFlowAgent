/**
 * MCP Server – Model Context Protocol Server for WorkFlowAgent
 *
 * Exposes WorkFlowAgent capabilities as MCP tools that any IDE
 * (Cursor, VS Code, Claude Code, Windsurf, etc.) can call via
 * the standard MCP protocol over stdio transport.
 *
 * Protocol: JSON-RPC 2.0 over stdio (newline-delimited JSON)
 * Spec: https://modelcontextprotocol.io/specification
 *
 * Design:
 *   - Zero external dependencies (uses Node.js built-in readline + process.stdin/stdout)
 *   - Implements MCP initialize/initialized handshake
 *   - Exposes workflow tools: workflow_triage, workflow_run, workflow_init, workflow_status
 *   - RequestTriage auto-routes simple tasks back to IDE
 *   - Graceful shutdown on SIGTERM/SIGINT
 *
 * Usage:
 *   # Start as stdio MCP server (for IDE integration)
 *   node workflow/core/mcp-server.js --project-root /path/to/project
 *
 *   # Or via command:
 *   /serve-mcp [--project-root <dir>]
 *
 * MCP Client Config (e.g. claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "workflowagent": {
 *         "command": "node",
 *         "args": ["workflow/core/mcp-server.js", "--project-root", "/path/to/project"]
 *       }
 *     }
 *   }
 *
 * @module mcp-server
 */

'use strict';

const readline = require('readline');
const path = require('path');
const fs = require('fs');

// ─── MCP Protocol Constants ─────────────────────────────────────────────────

const MCP_PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'workflowagent';
const SERVER_VERSION = '1.0.0';

// ─── Tool Definitions ───────────────────────────────────────────────────────

/**
 * MCP tool definitions exposed to the IDE.
 * Each tool has a name, description, and inputSchema (JSON Schema).
 */
const TOOLS = [
  {
    name: 'workflow_triage',
    description: 'Evaluate a requirement\'s complexity and get routing recommendation. Returns whether to use IDE directly, lightweight workflow, or full pipeline. Zero LLM cost — pure rule engine.',
    inputSchema: {
      type: 'object',
      properties: {
        requirement: {
          type: 'string',
          description: 'The requirement text to evaluate for complexity routing',
        },
      },
      required: ['requirement'],
    },
  },
  {
    name: 'workflow_run',
    description: 'Execute the full WorkFlowAgent pipeline for a requirement. Automatically triages complexity first — if the task is too simple, returns a suggestion to handle it directly in IDE. Use --force to bypass triage.',
    inputSchema: {
      type: 'object',
      properties: {
        requirement: {
          type: 'string',
          description: 'The requirement to implement',
        },
        mode: {
          type: 'string',
          enum: ['auto', 'sequential', 'parallel'],
          description: 'Execution mode. auto=LLM decides, sequential=full pipeline, parallel=task decomposition. Default: auto.',
        },
        force: {
          type: 'boolean',
          description: 'Skip complexity triage and force workflow execution. Default: false.',
        },
      },
      required: ['requirement'],
    },
  },
  {
    name: 'workflow_init',
    description: 'Initialize WorkFlowAgent for a project. Detects tech stack, generates config, builds CodeGraph, creates project profile. Must run before workflow_run on new projects.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to the project root directory. Defaults to the configured project root.',
        },
        dryRun: {
          type: 'boolean',
          description: 'Preview what would be done without making changes. Default: false.',
        },
      },
      required: [],
    },
  },
  {
    name: 'workflow_status',
    description: 'Get the current workflow status, including init state, staleness warnings, and active workflow progress.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

// ─── MCPServer Class ────────────────────────────────────────────────────────

class MCPServer {
  /**
   * @param {object} opts
   * @param {string}   [opts.projectRoot]          - Project root directory
   * @param {Function} [opts.orchestratorFactory]   - (opts) => Orchestrator instance
   * @param {Function} [opts.llmCall]              - async (prompt) => string
   */
  constructor(opts = {}) {
    this._projectRoot = opts.projectRoot || process.cwd();
    this._orchestratorFactory = opts.orchestratorFactory || null;
    this._llmCall = opts.llmCall || null;
    this._initialized = false;
    this._rl = null;
    this._requestHandlers = new Map();
    this._notificationHandlers = new Map();
    this._currentWorkflow = null;

    // Lazy-load RequestTriage (avoid circular deps)
    this._triage = null;

    // Register MCP method handlers
    this._registerHandlers();
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Starts the MCP server on stdio transport.
   * Reads JSON-RPC messages from stdin, writes responses to stdout.
   */
  start() {
    // All non-protocol output goes to stderr (MCP spec requirement)
    this._log('Starting MCP Server...');
    this._log(`Project root: ${this._projectRoot}`);

    this._rl = readline.createInterface({
      input: process.stdin,
      output: undefined, // We write to stdout manually
      terminal: false,
    });

    // Buffer for incomplete messages
    let buffer = '';

    process.stdin.on('data', (chunk) => {
      buffer += chunk.toString();

      // Process complete lines (newline-delimited JSON)
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep incomplete last line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const message = JSON.parse(trimmed);
          this._handleMessage(message).catch(err => {
            this._log(`Error handling message: ${err.message}`);
          });
        } catch (parseErr) {
          this._log(`Failed to parse JSON-RPC message: ${parseErr.message}`);
          this._log(`Raw line: ${trimmed.slice(0, 200)}`);
        }
      }
    });

    process.stdin.on('end', () => {
      this._log('stdin closed. Shutting down.');
      process.exit(0);
    });

    // Graceful shutdown
    process.on('SIGTERM', () => { this._log('SIGTERM received.'); process.exit(0); });
    process.on('SIGINT', () => { this._log('SIGINT received.'); process.exit(0); });

    this._log('MCP Server ready. Waiting for JSON-RPC messages on stdin...');
  }

  // ─── Message Handling ─────────────────────────────────────────────────

  /**
   * Routes an incoming JSON-RPC message to the appropriate handler.
   * @param {object} message
   */
  async _handleMessage(message) {
    // JSON-RPC 2.0 request (has id + method)
    if (message.id !== undefined && message.method) {
      return this._handleRequest(message);
    }

    // JSON-RPC 2.0 notification (has method but no id)
    if (message.method && message.id === undefined) {
      return this._handleNotification(message);
    }

    // Response (has id but no method) — ignore (we don't make outgoing requests)
    if (message.id !== undefined && !message.method) {
      return;
    }

    this._log(`Unknown message format: ${JSON.stringify(message).slice(0, 200)}`);
  }

  /**
   * Handles a JSON-RPC request (expects a response).
   * @param {object} req - { jsonrpc, id, method, params }
   */
  async _handleRequest(req) {
    const handler = this._requestHandlers.get(req.method);

    if (!handler) {
      this._sendError(req.id, -32601, `Method not found: ${req.method}`);
      return;
    }

    try {
      const result = await handler(req.params || {});
      this._sendResult(req.id, result);
    } catch (err) {
      this._log(`Handler error for ${req.method}: ${err.message}`);
      this._sendError(req.id, -32603, err.message);
    }
  }

  /**
   * Handles a JSON-RPC notification (no response expected).
   * @param {object} notif - { jsonrpc, method, params }
   */
  async _handleNotification(notif) {
    const handler = this._notificationHandlers.get(notif.method);
    if (handler) {
      try {
        await handler(notif.params || {});
      } catch (err) {
        this._log(`Notification handler error for ${notif.method}: ${err.message}`);
      }
    }
    // Notifications don't require a response per spec
  }

  // ─── MCP Protocol Handlers ────────────────────────────────────────────

  _registerHandlers() {
    // ── MCP Handshake ─────────────────────────────────────────────────────
    this._requestHandlers.set('initialize', async (params) => {
      this._log(`Initialize request from: ${params.clientInfo?.name || 'unknown'} v${params.clientInfo?.version || '?'}`);

      return {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: {},
          // No resources or prompts for now
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
      };
    });

    this._notificationHandlers.set('notifications/initialized', async () => {
      this._initialized = true;
      this._log('MCP session initialized successfully.');
    });

    // ── Tool Listing ──────────────────────────────────────────────────────
    this._requestHandlers.set('tools/list', async () => {
      return { tools: TOOLS };
    });

    // ── Tool Execution ────────────────────────────────────────────────────
    this._requestHandlers.set('tools/call', async (params) => {
      const { name, arguments: args } = params;

      switch (name) {
        case 'workflow_triage':
          return this._handleWorkflowTriage(args);
        case 'workflow_run':
          return this._handleWorkflowRun(args);
        case 'workflow_init':
          return this._handleWorkflowInit(args);
        case 'workflow_status':
          return this._handleWorkflowStatus(args);
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    });

    // ── Ping ──────────────────────────────────────────────────────────────
    this._requestHandlers.set('ping', async () => {
      return {};
    });
  }

  // ─── Tool Implementations ─────────────────────────────────────────────

  /**
   * workflow_triage: Evaluate requirement complexity and return routing advice.
   */
  async _handleWorkflowTriage(args) {
    const { requirement } = args;
    if (!requirement) {
      return this._toolResponse('Error: requirement is required', true);
    }

    const triage = this._getTriage();
    const result = triage.triage(requirement, { projectRoot: this._projectRoot });
    const mcpResult = triage.formatMCPResponse(result);
    const displayText = triage.formatTriageResult(result);

    return this._toolResponse(
      `## Requirement Triage\n\n${displayText}\n\n\`\`\`json\n${JSON.stringify(mcpResult, null, 2)}\n\`\`\``
    );
  }

  /**
   * workflow_run: Execute workflow with auto-triage.
   */
  async _handleWorkflowRun(args) {
    const { requirement, mode = 'auto', force = false } = args;
    if (!requirement) {
      return this._toolResponse('Error: requirement is required', true);
    }

    // ── Step 1: Triage (unless --force) ──────────────────────────────────
    if (!force) {
      const triage = this._getTriage();
      const triageResult = triage.triage(requirement, { projectRoot: this._projectRoot });

      // Block if not initialized
      if (triageResult.requiresInit) {
        return this._toolResponse(
          `❌ **Project Not Initialized**\n\n` +
          `${triageResult.initState.reason}\n\n` +
          `Please run \`workflow_init\` first, or use the terminal:\n` +
          `\`\`\`bash\nnode workflow/init-project.js --path ${this._projectRoot}\n\`\`\``,
          true
        );
      }

      // Suggest IDE for simple tasks
      if (!triageResult.shouldProceed) {
        const displayText = triage.formatTriageResult(triageResult);
        return this._toolResponse(
          `${displayText}\n\n` +
          `To force workflow execution, call \`workflow_run\` with \`force: true\`.`
        );
      }

      // Include staleness warnings
      if (triageResult.staleness && triageResult.staleness.isStale) {
        const warnings = triageResult.staleness.warnings.map(w => w.message).join('\n');
        this._log(`Staleness warnings:\n${warnings}`);
      }
    }

    // ── Step 2: Execute workflow ──────────────────────────────────────────
    if (!this._orchestratorFactory) {
      return this._toolResponse(
        `⚠️ Workflow execution is not available in this MCP server configuration.\n\n` +
        `The MCP server was started without an LLM provider. To enable workflow execution:\n` +
        `1. Configure an LLM call function when starting the server\n` +
        `2. Or use the CLI directly: \`/wf ${requirement}\`\n\n` +
        `**Triage result is still valid** — use it to decide how to proceed in IDE.`
      );
    }

    // Check if a workflow is already running
    if (this._currentWorkflow) {
      return this._toolResponse(
        `⚠️ A workflow is already running.\n\n` +
        `Current: "${this._currentWorkflow.requirement}"\n` +
        `Started: ${this._currentWorkflow.startTime}\n\n` +
        `Wait for it to complete or restart the MCP server.`,
        true
      );
    }

    try {
      const orchestrator = this._orchestratorFactory({
        projectRoot: this._projectRoot,
      });

      this._currentWorkflow = {
        requirement,
        startTime: new Date().toISOString(),
      };

      this._log(`Starting workflow: "${requirement}" (mode: ${mode})`);

      if (mode === 'parallel') {
        await orchestrator.runAuto(requirement);
      } else if (mode === 'auto') {
        await orchestrator.runAuto(requirement);
      } else {
        await orchestrator.run(requirement);
      }

      this._currentWorkflow = null;

      return this._toolResponse(
        `✅ **Workflow Complete**\n\n` +
        `**Requirement**: ${requirement}\n` +
        `**Mode**: ${mode}\n\n` +
        `Artifacts have been produced in the workflow output directory.`
      );
    } catch (err) {
      this._currentWorkflow = null;
      return this._toolResponse(
        `❌ **Workflow Failed**\n\n` +
        `**Error**: ${err.message}\n` +
        `**Requirement**: ${requirement}`,
        true
      );
    }
  }

  /**
   * workflow_init: Initialize workflow for a project.
   */
  async _handleWorkflowInit(args) {
    const targetRoot = args.projectPath || this._projectRoot;
    const dryRun = args.dryRun || false;

    const scriptPath = path.join(__dirname, '..', 'init-project.js');
    if (!fs.existsSync(scriptPath)) {
      return this._toolResponse(`❌ init-project.js not found at: ${scriptPath}`, true);
    }

    try {
      const { spawn } = require('child_process');
      const spawnArgs = [scriptPath, '--path', targetRoot];
      if (dryRun) spawnArgs.push('--dry-run');

      this._log(`Running: node ${spawnArgs.join(' ')}`);

      const output = await new Promise((resolve, reject) => {
        const chunks = [];
        const child = spawn(process.execPath, spawnArgs, {
          cwd: targetRoot,
          timeout: 120000,
        });

        child.stdout.on('data', (d) => chunks.push(d.toString()));
        child.stderr.on('data', (d) => chunks.push(d.toString()));

        child.on('close', (code) => {
          const result = chunks.join('');
          if (code === 0) {
            resolve(result);
          } else {
            reject(new Error(`Init failed (exit ${code}):\n${result.slice(-500)}`));
          }
        });

        child.on('error', (err) => reject(err));
      });

      return this._toolResponse(
        `✅ **Workflow Initialization Complete**\n\n` +
        `\`\`\`\n${output.slice(-2000)}\n\`\`\``
      );
    } catch (err) {
      return this._toolResponse(`❌ **Initialization Failed**\n\n${err.message}`, true);
    }
  }

  /**
   * workflow_status: Get current workflow and project status.
   */
  async _handleWorkflowStatus() {
    const triage = this._getTriage();
    const initState = triage.checkInitState(this._projectRoot);
    const staleness = triage.checkStaleness(this._projectRoot);

    const lines = [
      `## WorkFlowAgent Status`,
      ``,
      `**Project Root**: ${this._projectRoot}`,
      `**MCP Server**: ${SERVER_NAME} v${SERVER_VERSION}`,
      ``,
      `### Initialization`,
      `- **Initialized**: ${initState.isInitialized ? '✅ Yes' : '❌ No'}`,
      `- **Fully Initialized**: ${initState.isFullyInitialized ? '✅ Yes' : '⚠️ Partial'}`,
    ];

    if (initState.details.hasConfig) {
      lines.push(`- **Config**: ✅ ${initState.details.configPath}`);
    } else {
      lines.push(`- **Config**: ❌ Not found`);
    }

    if (initState.details.hasCodeGraph) {
      lines.push(`- **CodeGraph**: ✅ ${initState.details.codeGraphPath}`);
    } else {
      lines.push(`- **CodeGraph**: ❌ Not built`);
    }

    lines.push(`- **Project Profile**: ${initState.details.hasProjectProfile ? '✅ Yes' : '❌ No'}`);
    lines.push(`- **AGENTS.md**: ${initState.details.hasAgentsMd ? '✅ Yes' : '❌ No'}`);

    if (staleness.isStale) {
      lines.push(``);
      lines.push(`### ⚠️ Staleness Warnings`);
      for (const w of staleness.warnings) {
        lines.push(`- ${w.message}`);
      }
    }

    if (this._currentWorkflow) {
      lines.push(``);
      lines.push(`### 🔄 Active Workflow`);
      lines.push(`- **Requirement**: ${this._currentWorkflow.requirement}`);
      lines.push(`- **Started**: ${this._currentWorkflow.startTime}`);
    }

    // Check for manifest
    const manifestPaths = [
      path.join(this._projectRoot, 'workflow', 'output', 'manifest.json'),
      path.join(this._projectRoot, 'workflow', 'manifest.json'),
    ];
    for (const mp of manifestPaths) {
      if (fs.existsSync(mp)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(mp, 'utf-8'));
          lines.push(``);
          lines.push(`### Last Workflow`);
          lines.push(`- **State**: ${manifest.currentState}`);
          lines.push(`- **Updated**: ${manifest.updatedAt}`);
          lines.push(`- **Transitions**: ${manifest.history?.length || 0}`);
        } catch (_) { /* ignore parse errors */ }
        break;
      }
    }

    return this._toolResponse(lines.join('\n'));
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  /**
   * Lazy-loads RequestTriage to avoid circular dependencies.
   */
  _getTriage() {
    if (!this._triage) {
      const { RequestTriage } = require('./request-triage');
      this._triage = new RequestTriage();
    }
    return this._triage;
  }

  /**
   * Creates an MCP tool response.
   * @param {string} text - Response text content
   * @param {boolean} [isError=false] - Whether this is an error response
   * @returns {object}
   */
  _toolResponse(text, isError = false) {
    return {
      content: [
        { type: 'text', text },
      ],
      isError,
    };
  }

  /**
   * Sends a JSON-RPC result response.
   * @param {number|string} id - Request ID
   * @param {object} result
   */
  _sendResult(id, result) {
    this._send({
      jsonrpc: '2.0',
      id,
      result,
    });
  }

  /**
   * Sends a JSON-RPC error response.
   * @param {number|string} id - Request ID
   * @param {number} code - Error code
   * @param {string} message - Error message
   */
  _sendError(id, code, message) {
    this._send({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    });
  }

  /**
   * Writes a JSON-RPC message to stdout.
   * @param {object} message
   */
  _send(message) {
    const json = JSON.stringify(message);
    process.stdout.write(json + '\n');
  }

  /**
   * Logs to stderr (MCP spec: stdout is reserved for protocol messages).
   * @param {string} msg
   */
  _log(msg) {
    process.stderr.write(`[MCPServer] ${msg}\n`);
  }
}

// ─── CLI Entry Point ────────────────────────────────────────────────────────

if (require.main === module) {
  // Parse CLI args
  const args = process.argv.slice(2);
  let projectRoot = process.cwd();

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project-root' && args[i + 1]) {
      projectRoot = path.resolve(args[i + 1]);
      i++;
    }
  }

  // Start MCP server
  const server = new MCPServer({
    projectRoot,
    // orchestratorFactory and llmCall are not available in standalone CLI mode.
    // The server still provides triage, init, and status tools.
    // Full workflow execution requires the server to be started with an LLM provider.
  });

  server.start();
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = { MCPServer, TOOLS, MCP_PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION };
