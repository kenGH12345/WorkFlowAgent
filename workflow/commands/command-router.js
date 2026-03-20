/**
 * Command Router – Central dispatch hub for all slash commands.
 *
 * Architecture (P0 refactor):
 *   This file is the ONLY entry point for command registration and dispatch.
 *   Commands are grouped into sub-routers by domain:
 *     - commands-workflow.js     – /wf, /wf-tasks, /workflow-status, etc.
 *     - commands-agentflow.js    – /agentflow-status, /task-list, /experience-*, etc.
 *     - commands-devtools.js     – /gc, /ci, /graph, /evolve, /deep-audit, etc.
 *     - commands-analyze.js     – /analyze (standalone project architecture analysis)
 *     - commands-marketplace.js  – /skill-export, /skill-import, /help, etc.
 *
 * Supported commands:
 *   /ask-workflow-agent <requirement>  – Start or resume a workflow (sequential)
 *   /wf <requirement>                  – Run full sequential pipeline
 *   /wf <requirement> --auto           – Smart auto-dispatch
 *   /wf <requirement> --parallel       – Force parallel execution
 *   /wf-tasks <goal> --tasks "..."     – Run via parallel task-based execution
 *   /workflow-status                   – Show current workflow state
 *   /workflow-reset                    – Delete manifest and start fresh
 *   /workflow-artifacts                – List all produced artifacts
 *   ... and many more (see /help)
 */

'use strict';

// ─── Command Registry ─────────────────────────────────────────────────────────

const COMMANDS = {};

/**
 * Registers a command handler.
 *
 * @param {string}   name    - Command name without leading slash (e.g. 'ask-workflow-agent')
 * @param {string}   description
 * @param {Function} handler - async (args: string, context: object) => string (output message)
 */
function registerCommand(name, description, handler) {
  COMMANDS[name] = { name, description, handler };
}

/**
 * Parses and dispatches a slash command string.
 *
 * @param {string} input   - Full command string (e.g. '/ask-workflow-agent Build a todo app')
 * @param {object} context - Runtime context passed to handlers (orchestrator, stateMachine, etc.)
 * @returns {Promise<string>} Output message from the handler
 */
async function dispatch(input, context = {}) {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    throw new Error(`[CommandRouter] Not a command: "${trimmed}". Commands must start with /`);
  }

  const parts = trimmed.slice(1).split(/\s+/);
  const commandName = parts[0];
  const args = parts.slice(1).join(' ');

  const command = COMMANDS[commandName];
  if (!command) {
    const available = Object.keys(COMMANDS).map(c => `/${c}`).join(', ');
    throw new Error(`[CommandRouter] Unknown command: "/${commandName}". Available: ${available}`);
  }

  console.log(`[CommandRouter] Dispatching: /${commandName} ${args ? `"${args}"` : ''}`);
  return command.handler(args, context);
}

// ─── Load Sub-Routers ─────────────────────────────────────────────────────────

const { registerWorkflowCommands }    = require('./commands-workflow');
const { registerAgentFlowCommands }   = require('./commands-agentflow');
const { registerDevToolsCommands }    = require('./commands-devtools');
const { registerDoctorCommands }      = require('./commands-doctor');
const { registerMarketplaceCommands } = require('./commands-marketplace');
const { registerServerCommands }      = require('./commands-server');
const { registerAnalyzeCommands }     = require('./commands-analyze');

registerWorkflowCommands(registerCommand);
registerAgentFlowCommands(registerCommand);
registerDevToolsCommands(registerCommand);
registerDoctorCommands(registerCommand);
registerMarketplaceCommands(registerCommand, COMMANDS);
registerServerCommands(registerCommand);
registerAnalyzeCommands(registerCommand);

// ─── Export ───────────────────────────────────────────────────────────────────

module.exports = { dispatch, registerCommand, COMMANDS };
