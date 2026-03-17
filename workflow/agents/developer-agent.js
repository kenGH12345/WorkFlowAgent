/**
 * DeveloperAgent – Code Development Agent
 *
 * Role: Executor.
 * Input:  output/architecture.md  (file path passed by orchestrator)
 * Output: output/code.diff        (unified diff format)
 *
 * Constraints:
 *  - MUST NOT modify requirement.md or architecture.md
 *  - MUST NOT write test reports
 *  - MUST produce output as a unified diff (git diff format)
 *  - MUST strictly follow the architecture document
 */

'use strict';

const { BaseAgent } = require('./base-agent');
const { AgentRole } = require('../core/types');
const { buildJsonBlockInstruction } = require('../core/agent-output-schema');

class DeveloperAgent extends BaseAgent {
  constructor(llmCall, hookEmitter, opts = {}) {
    super(AgentRole.DEVELOPER, llmCall, hookEmitter, opts);
  }

  /**
   * Builds the developer prompt.
   * Input content is the full text of architecture.md.
   *
   * @param {string} inputContent - Content of architecture.md
   * @param {string|null} expContext - Experience context block from ExperienceStore (optional)
   * @returns {string}
   */
  buildPrompt(inputContent, expContext = null) {
    const expSection = expContext
      ? `\n## Accumulated Experience (Reference Before Coding)\n${expContext}\n`
      : '';
    // P0-NEW-1: inject structured JSON output instruction
    const jsonInstruction = buildJsonBlockInstruction('developer');

    return `You are **Kent Beck** – inventor of Test-Driven Development (TDD), creator of Extreme Programming (XP), and author of *Test Driven Development: By Example* and *Implementation Patterns*.
You believe that code is read far more often than it is written, and that the best code is the code that clearly communicates its intent.
Your hallmark: you write the simplest code that passes the tests, refactor mercilessly, and never introduce a component that the architecture did not ask for.
You are acting as the **Code Development Agent** for this workflow.

## Your Role
- Read the architecture document and implement it faithfully as code.
- Output ONLY a unified diff (git diff format) representing the changes to be applied.
- Do NOT modify requirement.md or architecture.md.
- Do NOT write test cases or test reports.
- Strictly follow the architecture: do not introduce components or patterns not described.
- If accumulated experience is provided below, apply proven patterns and avoid known pitfalls.

## Output Format
Produce a unified diff in standard git diff format:
\`\`\`diff
--- a/path/to/file.js
+++ b/path/to/file.js
@@ -line,count +line,count @@
 context line
+added line
-removed line
 context line
\`\`\`

Rules:
- Each file change must have a proper diff header
- Include sufficient context lines (3 lines before/after each change)
- Group related changes in the same file together
- Add new files with \`--- /dev/null\` and \`+++ b/new-file.js\`

## Mandatory Preamble Sections
Before the diff output, you MUST include the following two sections:

### Architecture Design *(mandatory)*
A concise record of the implementation design decisions made for this coding task:
- Which modules/files were created or modified and why
- Which design patterns were applied (e.g. factory, singleton, middleware chain)
- How the implementation maps to the architecture document's component breakdown
- Any deviations from the architecture and the justification for each deviation
- ⚠️ This section is REQUIRED. If you skip it, the workflow will flag a compliance error.

### Execution Plan *(mandatory)*
An ordered list of the implementation steps taken:
- Step 1: [what was done first and why]
- Step 2: [what was done next]
- ... (continue for all significant steps)
- What was intentionally deferred or left as TODO and why
- ⚠️ This section is REQUIRED. If you skip it, the workflow will flag a compliance error.

${jsonInstruction}

## Architecture Document
${inputContent}
${expSection}
## Instructions
First output the JSON metadata block (as instructed above), then write the "Architecture Design" and "Execution Plan" sections, then generate the code.diff inside a \`\`\`diff block.
**CRITICAL**: Both preamble sections are MANDATORY. Do not omit them.`;
  }

  /**
   * Parses the LLM response.
   * Extracts the diff content from code blocks if wrapped.
   *
   * @param {string} llmResponse
   * @returns {string}
   */
  parseResponse(llmResponse) {
    // P0-NEW-1: validate JSON block presence
    const { extractJsonBlock, validateJsonBlock } = require('../core/agent-output-schema');
    const jsonBlock = extractJsonBlock(llmResponse);
    if (!jsonBlock) {
      console.warn(`[DeveloperAgent] ⚠️  No structured JSON block found in output. Downstream agents will use regex-based extraction (degraded mode).`);
    } else {
      const check = validateJsonBlock(jsonBlock, 'developer');
      if (!check.valid) {
        console.warn(`[DeveloperAgent] ⚠️  JSON block validation failed: ${check.reason}`);
      } else {
        console.log(`[DeveloperAgent] ✅ Structured JSON block validated (${Object.keys(jsonBlock).length} fields).`);
      }
    }

    // ── Mandatory section compliance check ────────────────────────────────────
    const mandatorySections = ['Architecture Design', 'Execution Plan'];
    const missingSections = mandatorySections.filter(s => !llmResponse.includes(s));
    if (missingSections.length > 0) {
      console.warn(`[DeveloperAgent] ⚠️  COMPLIANCE: Missing mandatory section(s): ${missingSections.join(', ')}. The agent output specification requires these sections.`);
    } else {
      console.log(`[DeveloperAgent] ✅ Mandatory sections present: Architecture Design, Execution Plan.`);
    }

    // Extract content from ```diff ... ``` block if present (handle optional diff and \r\n)
    const diffBlockMatch = llmResponse.match(/```(?:diff)?\r?\n([\s\S]*?)```/);
    if (diffBlockMatch) {
      return diffBlockMatch[1].trim();
    }
    // Fallback: strip any remaining markdown backticks just in case
    return llmResponse.replace(/^```(?:diff)?\r?\n/m, '').replace(/```$/m, '').trim();
  }
}

module.exports = { DeveloperAgent };
