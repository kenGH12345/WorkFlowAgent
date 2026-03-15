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

class DeveloperAgent extends BaseAgent {
  constructor(llmCall, hookEmitter) {
    super(AgentRole.DEVELOPER, llmCall, hookEmitter);
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

    return `You are a **Code Development Agent** – a disciplined executor.

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

## Architecture Document
${inputContent}
${expSection}
## Instructions
Generate the code.diff now. Output ONLY the diff content, no explanations outside the diff blocks.`;
  }

  /**
   * Parses the LLM response.
   * Extracts the diff content from code blocks if wrapped.
   *
   * @param {string} llmResponse
   * @returns {string}
   */
  parseResponse(llmResponse) {
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
