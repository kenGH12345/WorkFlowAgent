'use strict';

/**
 * Agent Output Schema – Structured knowledge contracts for inter-agent communication.
 *
 * Problem it solves (P0-NEW-1 – "Text Pipeline"):
 *   Previously, agents exchanged pure Markdown files. Downstream agents had to
 *   re-parse natural language to extract structured knowledge (tech stack, decisions,
 *   module list, etc.), which was fragile and lossy.
 *
 * Solution:
 *   Each agent now outputs a JSON+Markdown hybrid file:
 *     - A leading JSON block (```json ... ```) containing structured metadata
 *     - Followed by the full Markdown narrative for human readability
 *
 *   Downstream agents and StageContextStore read the JSON block directly,
 *   eliminating regex-based heuristic extraction.
 *
 * Schema format (per agent role):
 *   ANALYST  → AnalystOutputSchema
 *   ARCHITECT → ArchitectOutputSchema
 *   DEVELOPER → DeveloperOutputSchema
 *   TESTER   → TesterOutputSchema
 */

// ─── Schema Definitions ───────────────────────────────────────────────────────

/**
 * ANALYST output schema.
 * Embedded as a JSON block at the top of requirements.md.
 */
const ANALYST_SCHEMA = {
  role: 'analyst',
  version: '1.0',
  fields: {
    requirements:    { type: 'array',  description: 'Structured requirement items', required: true },
    risks:           { type: 'array',  description: 'Identified risk items',        required: false },
    clarifications:  { type: 'array',  description: 'Clarification Q&A pairs',      required: false },
    scope:           { type: 'string', description: 'Scope decision (minimal/full)', required: false },
    keyDecisions:    { type: 'array',  description: 'Top-level decisions made',      required: false },
  },
};

/**
 * ARCHITECT output schema.
 * Embedded as a JSON block at the top of architecture.md.
 */
const ARCHITECT_SCHEMA = {
  role: 'architect',
  version: '1.0',
  fields: {
    modules:      { type: 'array',  description: 'Module/component definitions',    required: true },
    techStack:    { type: 'object', description: 'Technology stack choices',         required: true },
    decisions:    { type: 'array',  description: 'Architecture decision records',    required: true },
    apis:         { type: 'array',  description: 'API endpoint definitions',         required: false },
    dataModels:   { type: 'array',  description: 'Data model definitions',           required: false },
    keyDecisions: { type: 'array',  description: 'Summary of key decisions (text)',  required: false },
  },
};

/**
 * PLANNER output schema.
 * Embedded as a JSON block at the top of execution-plan.md.
 */
const PLANNER_SCHEMA = {
  role: 'planner',
  version: '1.0',
  fields: {
    tasks:         { type: 'array',  description: 'Ordered list of implementation tasks',    required: true },
    dependencies:  { type: 'array',  description: 'Task dependency relationships',           required: false },
    phases:        { type: 'array',  description: 'Implementation phases grouping',          required: true },
    totalEstimate: { type: 'string', description: 'Total estimated complexity',              required: false },
    keyDecisions:  { type: 'array',  description: 'Planning decisions made',                 required: false },
    risks:         { type: 'array',  description: 'Identified execution risks',              required: false },
  },
};

/**
 * DEVELOPER output schema.
 * Embedded as a JSON block at the top of code.diff.
 */
const DEVELOPER_SCHEMA = {
  role: 'developer',
  version: '1.0',
  fields: {
    filesChanged:   { type: 'array',  description: 'List of changed file paths',     required: true },
    summary:        { type: 'string', description: 'Implementation summary',          required: true },
    implementedReqs:{ type: 'array',  description: 'Requirement IDs implemented',     required: false },
    keyDecisions:   { type: 'array',  description: 'Implementation decisions made',   required: false },
    knownIssues:    { type: 'array',  description: 'Known issues or TODOs',           required: false },
  },
};

/**
 * TESTER output schema.
 * Embedded as a JSON block at the top of test-report.md.
 */
const TESTER_SCHEMA = {
  role: 'tester',
  version: '1.0',
  fields: {
    passed:       { type: 'number',  description: 'Number of passing tests',         required: true },
    failed:       { type: 'number',  description: 'Number of failing tests',         required: true },
    coverage:     { type: 'number',  description: 'Code coverage percentage',        required: false },
    failures:     { type: 'array',   description: 'Failure details',                 required: false },
    keyDecisions: { type: 'array',   description: 'Testing decisions made',          required: false },
  },
};

const SCHEMAS = {
  analyst:   ANALYST_SCHEMA,
  architect: ARCHITECT_SCHEMA,
  planner:   PLANNER_SCHEMA,
  developer: DEVELOPER_SCHEMA,
  tester:    TESTER_SCHEMA,
};

// ─── JSON Block Extraction ────────────────────────────────────────────────────

/**
 * Extracts the structured JSON metadata block from an agent output file.
 *
 * Agent output files use a JSON+Markdown hybrid format:
 *   ```json
 *   { "role": "analyst", "version": "1.0", "requirements": [...], ... }
 *   ```
 *   ## Full Markdown narrative follows...
 *
 * @param {string} content - Full file content
 * @returns {object|null} Parsed JSON object, or null if no valid block found
 */
function extractJsonBlock(content) {
  if (!content || typeof content !== 'string') return null;

  // Match ```json ... ``` at the start of the file (allow leading whitespace/newlines)
  const match = content.match(/^\s*```json\s*\n([\s\S]*?)\n```/);
  if (!match) return null;

  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/**
 * Validates a parsed JSON block against the expected schema for a given role.
 *
 * @param {object} jsonBlock - Parsed JSON from extractJsonBlock()
 * @param {string} role      - Agent role: 'analyst' | 'architect' | 'developer' | 'tester'
 * @returns {{ valid: boolean, reason: string, missingFields: string[] }}
 */
function validateJsonBlock(jsonBlock, role) {
  if (!jsonBlock) {
    return { valid: false, reason: 'No JSON block found', missingFields: [] };
  }

  const schema = SCHEMAS[role.toLowerCase()];
  if (!schema) {
    return { valid: true, reason: `No schema defined for role "${role}"`, missingFields: [] };
  }

  const missingFields = [];
  for (const [field, spec] of Object.entries(schema.fields)) {
    if (spec.required && !(field in jsonBlock)) {
      missingFields.push(field);
    }
  }

  if (missingFields.length > 0) {
    return {
      valid: false,
      reason: `Missing required fields: ${missingFields.join(', ')}`,
      missingFields,
    };
  }

  return { valid: true, reason: 'ok', missingFields: [] };
}

/**
 * Builds the JSON block prompt instruction for an agent.
 * Injected into agent prompts to instruct the LLM to output structured metadata.
 *
 * @param {string} role - Agent role
 * @returns {string} Prompt instruction block
 */
function buildJsonBlockInstruction(role) {
  const schema = SCHEMAS[role.toLowerCase()];
  if (!schema) return '';

  const fieldDescriptions = Object.entries(schema.fields)
    .map(([field, spec]) => `  "${field}": ${spec.type === 'array' ? '[]' : spec.type === 'object' ? '{}' : '""'}  // ${spec.description}${spec.required ? ' [REQUIRED]' : ''}`)
    .join(',\n');

  return [
    `## MANDATORY: Structured Output Header`,
    ``,
    `**You MUST begin your response with a JSON metadata block** (before any Markdown content).`,
    `This block enables downstream agents to read your decisions as structured data, not text.`,
    ``,
    `\`\`\`json`,
    `{`,
    `  "role": "${role}",`,
    `  "version": "1.0",`,
    fieldDescriptions,
    `}`,
    `\`\`\``,
    ``,
    `After the JSON block, write your full Markdown narrative as usual.`,
    `The JSON block MUST be valid JSON. Do not add comments inside the JSON block.`,
  ].join('\n');
}

/**
 * Extracts keyDecisions from a structured JSON block (P0-NEW-1 fix).
 * Falls back to empty array if the block is missing or malformed.
 *
 * @param {object|null} jsonBlock
 * @returns {string[]}
 */
function extractKeyDecisions(jsonBlock) {
  if (!jsonBlock) return [];

  // Try keyDecisions field first
  if (Array.isArray(jsonBlock.keyDecisions) && jsonBlock.keyDecisions.length > 0) {
    return jsonBlock.keyDecisions.slice(0, 6).map(d => String(d).slice(0, 150));
  }

  // For architect: synthesise from decisions array
  if (Array.isArray(jsonBlock.decisions) && jsonBlock.decisions.length > 0) {
    return jsonBlock.decisions.slice(0, 6).map(d => {
      if (typeof d === 'string') return d.slice(0, 150);
      if (d && d.choice) return `${d.id ? d.id + ': ' : ''}${d.choice}`.slice(0, 150);
      return JSON.stringify(d).slice(0, 150);
    });
  }

  // For analyst: synthesise from requirements
  if (Array.isArray(jsonBlock.requirements) && jsonBlock.requirements.length > 0) {
    return jsonBlock.requirements.slice(0, 4).map(r => {
      if (typeof r === 'string') return r.slice(0, 150);
      if (r && r.text) return `${r.id ? r.id + ': ' : ''}${r.text}`.slice(0, 150);
      return JSON.stringify(r).slice(0, 150);
    });
  }

  return [];
}

/**
 * Extracts a summary string from a structured JSON block.
 *
 * @param {object|null} jsonBlock
 * @param {string} stageName
 * @returns {string}
 */
function extractSummary(jsonBlock, stageName) {
  if (!jsonBlock) return `${stageName} stage completed.`;

  // Developer: use summary field
  if (jsonBlock.summary) return String(jsonBlock.summary).slice(0, 500);

  // Architect: synthesise from techStack + module count
  if (jsonBlock.techStack) {
    const ts = jsonBlock.techStack;
    const parts = [];
    if (ts.language)  parts.push(`Language: ${ts.language}`);
    if (ts.framework) parts.push(`Framework: ${ts.framework}`);
    if (ts.database)  parts.push(`Database: ${ts.database}`);
    const moduleCount = Array.isArray(jsonBlock.modules) ? jsonBlock.modules.length : 0;
    if (moduleCount > 0) parts.push(`${moduleCount} module(s)`);
    if (parts.length > 0) return parts.join(' | ');
  }

  // Analyst: synthesise from requirement count + scope
  if (Array.isArray(jsonBlock.requirements)) {
    const scope = jsonBlock.scope ? ` (scope: ${jsonBlock.scope})` : '';
    return `${jsonBlock.requirements.length} requirement(s) identified${scope}.`;
  }

  // Tester: synthesise from pass/fail counts
  if (typeof jsonBlock.passed === 'number') {
    const cov = typeof jsonBlock.coverage === 'number' ? ` | Coverage: ${jsonBlock.coverage}%` : '';
    return `Tests: ${jsonBlock.passed} passed / ${jsonBlock.failed ?? 0} failed${cov}.`;
  }

  return `${stageName} stage completed.`;
}

module.exports = {
  SCHEMAS,
  ANALYST_SCHEMA,
  ARCHITECT_SCHEMA,
  PLANNER_SCHEMA,
  DEVELOPER_SCHEMA,
  TESTER_SCHEMA,
  extractJsonBlock,
  validateJsonBlock,
  buildJsonBlockInstruction,
  extractKeyDecisions,
  extractSummary,
};
