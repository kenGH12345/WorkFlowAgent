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
const { buildJsonBlockInstruction } = require('../core/agent-output-schema');

class AnalystAgent extends BaseAgent {
  constructor(llmCall, hookEmitter, opts = {}) {
    super(AgentRole.ANALYST, llmCall, hookEmitter, opts);
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
    // P0-NEW-1: inject structured JSON output instruction
    const jsonInstruction = buildJsonBlockInstruction('analyst');

    return `You are **Alistair Cockburn** – the world's foremost authority on use cases and requirements engineering.
You invented the use-case methodology, co-authored the Agile Manifesto, and wrote *Writing Effective Use Cases* (Addison-Wesley, 2000).
Your hallmark: you translate messy human intent into crystal-clear, testable requirements that leave no room for misinterpretation.
You are acting as the **Requirement Analysis Agent** for this workflow.

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
6. **Architecture Design** *(mandatory)* – High-level analysis of the problem domain:
   - Key entities and their relationships
   - Major functional boundaries (what subsystems are implied by the requirements)
   - Constraints and non-functional requirements identified from the user's request
   - ⚠️ This section is REQUIRED. If you skip it, the workflow will flag a compliance error.
7. **Execution Plan** *(mandatory)* – Ordered list of analysis steps taken and decisions made:
   - What clarifications were applied to the raw requirement
   - What assumptions were made and why
   - What risks or ambiguities remain unresolved
   - ⚠️ This section is REQUIRED. If you skip it, the workflow will flag a compliance error.

${jsonInstruction}

## User Requirement
${inputContent}
${expSection}
## Instructions
First output the JSON metadata block (as instructed above), then write the full Markdown document.
Remember: NO technical details, NO code, NO architecture.
**CRITICAL**: Sections 6 (Architecture Design) and 7 (Execution Plan) are MANDATORY. Do not omit them.`;
  }

  /**
   * Parses the LLM response.
   * Validates that no code blocks or technical keywords slipped through.
   *
   * @param {string} llmResponse
   * @returns {string}
   */
  parseResponse(llmResponse) {
    // P0-NEW-1: validate JSON block presence
    const { extractJsonBlock, validateJsonBlock } = require('../core/agent-output-schema');
    const jsonBlock = extractJsonBlock(llmResponse);
    if (!jsonBlock) {
      console.warn(`[AnalystAgent] ⚠️  No structured JSON block found in output. Downstream agents will use regex-based extraction (degraded mode).`);
    } else {
      const check = validateJsonBlock(jsonBlock, 'analyst');
      if (!check.valid) {
        console.warn(`[AnalystAgent] ⚠️  JSON block validation failed: ${check.reason}`);
      } else {
        console.log(`[AnalystAgent] ✅ Structured JSON block validated (${Object.keys(jsonBlock).length} fields).`);
      }
    }

    // Warn if technical content detected (soft check – does not block)
    const technicalPatterns = [/```[\w]*\n/, /class\s+\w+/, /function\s+\w+\s*\(/, /import\s+\w+/];
    for (const pattern of technicalPatterns) {
      if (pattern.test(llmResponse)) {
        console.warn(`[AnalystAgent] WARNING: Technical content detected in requirement.md output. Review recommended.`);
        break;
      }
    }

    // ── Mandatory section compliance check ──────────────────────────────────
    // Verify that the mandatory "Architecture Design" and "Execution Plan" sections
    // are present in the output. These are required by the agent output specification.
    const mandatorySections = ['Architecture Design', 'Execution Plan'];
    const missingSections = mandatorySections.filter(s => !llmResponse.includes(s));
    if (missingSections.length > 0) {
      console.warn(`[AnalystAgent] ⚠️  COMPLIANCE: Missing mandatory section(s): ${missingSections.join(', ')}. The agent output specification requires these sections.`);
    } else {
      console.log(`[AnalystAgent] ✅ Mandatory sections present: Architecture Design, Execution Plan.`);
    }

    return llmResponse;
  }
}

module.exports = { AnalystAgent };
