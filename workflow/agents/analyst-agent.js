/**
 * AnalystAgent – Requirement Analysis Agent
 *
 * Role: Business translator.
 * Input:  Raw user requirement string (no input file)
 * Output: output/requirement.md
 *
 * Constraints:
 *  - MUST NOT produce technical implementation details
 *  - MUST NOT write code, architecture docs, or test reports
 *  - MUST focus solely on clarifying WHAT the user wants, not HOW
 */

'use strict';

const { BaseAgent } = require('./base-agent');
const { AgentRole } = require('../core/types');

class AnalystAgent extends BaseAgent {
  constructor(llmCall, hookEmitter) {
    super(AgentRole.ANALYST, llmCall, hookEmitter);
  }

  /**
   * Builds the analyst prompt.
   * Enforces strict role boundary: no technical details, no code.
   *
   * @param {string} inputContent - Raw user requirement text
   * @param {string|null} expContext - Experience context block from ExperienceStore (optional)
   * @returns {string}
   */
  buildPrompt(inputContent, expContext = null) {
    const expSection = expContext
      ? `\n## Accumulated Experience (Reference Before Analysis)\n${expContext}\n`
      : '';

    return `You are a **Requirement Analysis Agent** – a business translator.

## Your Role
- Translate the user's raw requirement into a structured, unambiguous requirement document.
- Focus ONLY on WHAT the user wants, not HOW to implement it.
- Do NOT include any technical implementation details, code snippets, or architecture decisions.
- Do NOT suggest frameworks, libraries, or design patterns.

## Output Format
Produce a Markdown document with the following sections:
1. **Overview** – One-paragraph summary of the business goal
2. **User Stories** – Bullet list of "As a [role], I want [goal], so that [benefit]"
3. **Acceptance Criteria** – Numbered list of verifiable conditions (WHEN/THEN/IF format)
4. **Out of Scope** – Explicit list of things NOT included in this requirement
5. **Open Questions** – Any ambiguities that need clarification before implementation

## User Requirement
${inputContent}
${expSection}
## Instructions
Write the requirement.md document now. Remember: NO technical details, NO code, NO architecture.`;
  }

  /**
   * Parses the LLM response.
   * Validates that no code blocks or technical keywords slipped through.
   *
   * @param {string} llmResponse
   * @returns {string}
   */
  parseResponse(llmResponse) {
    // Warn if technical content detected (soft check – does not block)
    const technicalPatterns = [/```[\w]*\n/, /class\s+\w+/, /function\s+\w+\s*\(/, /import\s+\w+/];
    for (const pattern of technicalPatterns) {
      if (pattern.test(llmResponse)) {
        console.warn(`[AnalystAgent] WARNING: Technical content detected in requirement.md output. Review recommended.`);
        break;
      }
    }
    return llmResponse;
  }
}

module.exports = { AnalystAgent };
