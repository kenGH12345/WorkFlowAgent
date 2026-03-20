/**
 * BaseAgent – abstract base class for all workflow agents.
 *
 * Enforces the file-reference communication protocol:
 *   - Input is always a FILE PATH (never raw content)
 *   - Output is always a FILE PATH written to ./output/
 *
 * Subclasses must implement:
 *   - buildPrompt(inputContent)  → string
 *   - parseResponse(llmResponse) → string  (the content to write to outputFilePath)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { AGENT_CONTRACTS, AgentRole } = require('../core/types');
const { PATHS, HOOK_EVENTS } = require('../core/constants');
const { translateMdFile } = require('../core/i18n-translator');

class BaseAgent {
  /**
   * @param {string} role          - One of AgentRole values
   * @param {Function} llmCall     - async (prompt: string) => string  (LLM adapter)
   * @param {Function} hookEmitter - async (event: string, payload: object) => void
   * @param {object} [opts]
   * @param {string} [opts.outputDir] - P2-b: Instance-level output directory.
   *   When provided, agent outputs are written here instead of the global PATHS.OUTPUT_DIR.
   *   This enables multiple Orchestrator instances to run in parallel without
   *   overwriting each other's output files.
   */
  constructor(role, llmCall, hookEmitter = async () => {}, opts = {}) {
    if (!Object.values(AgentRole).includes(role)) {
      throw new Error(`[BaseAgent] Unknown role: "${role}"`);
    }
    this.role = role;
    this.contract = AGENT_CONTRACTS[role];
    this.llmCall = llmCall;
    this.hookEmitter = hookEmitter;
    // P2-b: instance-level output directory
    this._outputDir = opts.outputDir || PATHS.OUTPUT_DIR;
  }

  // ─── Public API ───────────────────────────────────────────────────────────────

  /**
   * Execute the agent.
   *
   * @param {string|null} inputFilePath - Path to the input artifact file.
   *                                      Pass null for the analyst (raw user input).
   * @param {string|null} rawInput      - Raw user requirement string (analyst only).
   * @param {string|null} expContext    - Experience context block from ExperienceStore (optional).
   * @returns {string} outputFilePath   - Path to the produced artifact file.
   */
  async run(inputFilePath = null, rawInput = null, expContext = null) {
    console.log(`[${this.role}] Starting...`);

    // 1. Read input content
    const inputContent = this._readInput(inputFilePath, rawInput);

    // 2. Validate we are not violating our own contract
    await this.assertAllowed('run');

    // 3. Build prompt and call LLM
    const prompt = this.buildPrompt(inputContent, expContext);
    const llmResponse = await this.llmCall(prompt);

    // 4. Parse response into output content
    const outputContent = this.parseResponse(llmResponse);

    // 5. Write output to file
    const outputFilePath = this._writeOutput(outputContent);

    console.log(`[${this.role}] Done. Output: ${outputFilePath}`);
    return outputFilePath;
  }

  // ─── Abstract Methods (must be overridden) ────────────────────────────────────

  /**
   * Build the LLM prompt from the input content.
   * @param {string} inputContent
   * @param {string|null} expContext - Experience context block (optional)
   * @returns {string}
   */
  buildPrompt(inputContent, expContext = null) {
    throw new Error(`[${this.role}] buildPrompt() must be implemented by subclass`);
  }

  /**
   * Parse the raw LLM response into the content to write to the output file.
   * @param {string} llmResponse
   * @returns {string}
   */
  parseResponse(llmResponse) {
    // Default: write the response as-is
    return llmResponse;
  }

  // ─── Boundary Enforcement ─────────────────────────────────────────────────────

  /**
   * Checks whether an action is in the forbidden list and throws if so.
   * Emits AGENT_BOUNDARY_VIOLATION hook before throwing.
   *
   * @param {string} action
   */
  async assertAllowed(action) {
    if (this.contract.forbiddenActions.includes(action)) {
      const payload = { role: this.role, action, contract: this.contract };
      await this.hookEmitter(HOOK_EVENTS.AGENT_BOUNDARY_VIOLATION, payload);
      throw new Error(
        `[${this.role}] Boundary violation: action "${action}" is forbidden for this agent.\n` +
        `Forbidden actions: ${this.contract.forbiddenActions.join(', ')}`
      );
    }
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────────

  /**
   * Reads input content from a file path or falls back to rawInput.
   * Enforces the file-reference protocol: always prefer file path.
   */
  _readInput(inputFilePath, rawInput) {
    if (inputFilePath) {
      if (!fs.existsSync(inputFilePath)) {
        throw new Error(`[${this.role}] Input file not found: "${inputFilePath}"`);
      }
      return fs.readFileSync(inputFilePath, 'utf-8');
    }
    if (rawInput) {
      return rawInput;
    }
    throw new Error(`[${this.role}] No input provided (neither file path nor raw input)`);
  }

  /**
   * Writes output content to the designated output file path.
   * Ensures the output directory exists.
   *
   * @param {string} content
   * @returns {string} Absolute path to the written file
   */
  _writeOutput(content) {
    const outputFilePath = path.join(this._outputDir, this.contract.outputFilePath.replace('output/', ''));
    const dir = path.dirname(outputFilePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    
    // Atomic write: write to temp file first, then rename
    // R3-1 audit: added random suffix to prevent collision when parallel agents
    // finish in the same millisecond (task-based mode with concurrency > 1).
    const tempFilePath = `${outputFilePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(tempFilePath, content, 'utf-8');
    fs.renameSync(tempFilePath, outputFilePath);

    // Auto-generate Chinese translation for .md files (non-blocking)
    if (outputFilePath.endsWith('.md')) {
      translateMdFile(outputFilePath, this.llmCall).catch((err) => {
        console.warn(`[${this.role}] ⚠️  Chinese translation failed (non-fatal): ${err.message}`);
      });
    }
    
    return outputFilePath;
  }

}

module.exports = { BaseAgent };
