/**
 * ArchitectAgent – Architecture Design Agent
 *
 * Role: Technical planner.
 * Input:  output/requirement.md  (file path passed by orchestrator)
 * Output: output/architecture.md
 *
 * Constraints:
 *  - MUST NOT write any code
 *  - MUST NOT modify requirement.md
 *  - MUST focus on system design: components, interfaces, data flow, tech stack choices
 */

'use strict';

const { BaseAgent } = require('./base-agent');
const { AgentRole } = require('../core/types');

class ArchitectAgent extends BaseAgent {
  constructor(llmCall, hookEmitter) {
    super(AgentRole.ARCHITECT, llmCall, hookEmitter);
  }

  /**
   * Builds the architect prompt.
   * Input content is the full text of requirement.md.
   *
   * @param {string} inputContent - Content of requirement.md
   * @param {string|null} expContext - Experience context block from ExperienceStore (optional)
   * @returns {string}
   */
  buildPrompt(inputContent, expContext = null) {
    const expSection = expContext
      ? `\n## Accumulated Experience (Reference Before Designing)\n${expContext}\n`
      : '';

    return `You are an **Architecture Design Agent** – a technical planner.

## Your Role
- Read the requirement document and produce a comprehensive architecture design.
- Focus on SYSTEM DESIGN: components, interfaces, data flow, technology choices, and constraints.
- Do NOT write any code, pseudocode, or implementation snippets.
- Do NOT modify or re-interpret the requirements – treat them as fixed input.
- If accumulated experience is provided below, apply proven patterns and avoid known pitfalls.

## Output Format
Produce a Markdown document with the following sections:
1. **Architecture Overview** – High-level diagram description (use Mermaid if helpful)
2. **Component Breakdown** – Each major component with its responsibility
3. **Data Flow** – How data moves between components (sequence or flow description)
4. **Technology Stack** – Chosen technologies with justification
5. **Interface Contracts** – API/interface definitions between components (signatures only, no implementation)
6. **Non-Functional Requirements** – Performance, scalability, security considerations
7. **Risk Assessment** – Technical risks and mitigation strategies
8. **Open Architecture Questions** – Decisions that need further input

## Requirement Document
${inputContent}
${expSection}
## Instructions
Write the architecture.md document now. Remember: NO code, NO implementation, design decisions ONLY.`;
  }

  /**
   * Parses the LLM response.
   * Warns if actual code implementations are detected.
   *
   * @param {string} llmResponse
   * @returns {string}
   */
  parseResponse(llmResponse) {
    // Detect implementation code (multi-line code blocks with logic)
    const codeBlockPattern = /```[\w]*\n([\s\S]*?)```/g;
    let match;
    while ((match = codeBlockPattern.exec(llmResponse)) !== null) {
      const blockContent = match[1];
      // Heuristic: if block contains assignment operators or control flow, it's likely code
      if (/[=;{}]/.test(blockContent) && !/^[\s#\-*>|]/.test(blockContent.trim())) {
        console.warn(`[ArchitectAgent] WARNING: Possible implementation code detected in architecture.md. Review recommended.`);
        break;
      }
    }
    return llmResponse;
  }
}

module.exports = { ArchitectAgent };
