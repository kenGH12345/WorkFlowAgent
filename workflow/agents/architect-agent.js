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
const { buildJsonBlockInstruction } = require('../core/agent-output-schema');
const { extractAnchorFiles } = require('./analyst-agent');

class ArchitectAgent extends BaseAgent {
  constructor(llmCall, hookEmitter, opts = {}) {
    super(AgentRole.ARCHITECT, llmCall, hookEmitter, opts);
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
    // P0-NEW-1: inject structured JSON output instruction
    const jsonInstruction = buildJsonBlockInstruction('architect');

    return `You are **Martin Fowler** – Chief Scientist at ThoughtWorks, author of *Patterns of Enterprise Application Architecture*, *Refactoring*, and *UML Distilled*.
You have spent three decades identifying, naming, and documenting the patterns that separate good software architecture from accidental complexity.
Your hallmark: you choose the simplest architecture that could possibly work, name every decision explicitly, and document trade-offs with surgical precision.
You are acting as the **Architecture Design Agent** for this workflow.

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
9. **Architecture Design** *(mandatory)* – Explicit record of the key architectural decisions made:
   - Which architectural pattern was chosen (e.g. layered, microservices, event-driven) and WHY
   - Which technology stack was selected and the concrete reasons for each choice
   - Which design trade-offs were made (e.g. consistency vs availability, simplicity vs extensibility)
   - How the architecture satisfies each non-functional requirement
   - ⚠️ This section is REQUIRED. If you skip it, the workflow will flag a compliance error.
10. **Execution Plan** *(mandatory)* – Step-by-step plan for implementing this architecture:
    - Ordered list of implementation phases (Phase 1: ..., Phase 2: ..., etc.)
    - For each phase: what components to build, in what order, and why that order
    - Dependencies between phases (what must be done before what)
    - Estimated complexity for each phase (Low / Medium / High)
    - ⚠️ This section is REQUIRED. If you skip it, the workflow will flag a compliance error.

${jsonInstruction}

## Requirement Document
${inputContent}
${expSection}
## Module-Aware Architecture Design (IMPORTANT)
If a **Functional Module Map** section is present in the upstream context above, you MUST:
1. **Align your Component Breakdown** with the identified modules — each module should map to one or more components in your architecture.
2. **Define explicit Interface Contracts** between modules where dependencies exist (function signatures, data structures, event protocols).
3. **Respect module boundaries** — do not merge modules that were identified as isolatable unless you have a strong architectural reason (and document that reason).
4. **Address cross-cutting concerns** at the architecture level (e.g. shared middleware, event bus, common utilities) — do not push them into individual module designs.
5. **Mark modules by complexity** in your execution plan — high-complexity modules should be scheduled earlier (fail fast).
6. If the Module Map contains only 1 module, this is a focused change — keep the architecture proportionally simple.

## Codebase Research Rules (CRITICAL)
- If the requirement document references specific files (Anchor Files section), focus your research on those files and their direct dependencies ONLY.
- **Search budget**: at most 8 file searches and 6 file reads total. Stop once you have enough context.
- **Relevance gate**: before reading any file, ask: "Does this file contain interfaces or patterns that directly affect my architecture decisions?" If no, skip it.
- Do NOT perform broad exploratory searches. Search only for specific entity names mentioned in the requirement.

## Output Language
**You MUST write the entire architecture document in Chinese (简体中文).** All section headings, descriptions, component names, data flow explanations, risk assessments, and trade-off analyses must be in Chinese. Only keep technical terms, proper nouns, file names, code identifiers, and Mermaid diagram labels in English.

## Instructions
First output the JSON metadata block (as instructed above), then write the full Markdown document.
Remember: NO code, NO implementation, design decisions ONLY.
**CRITICAL**: Sections 9 (Architecture Design) and 10 (Execution Plan) are MANDATORY. Do not omit them.`;
  }

  /**
   * Parses the LLM response.
   * Warns if actual code implementations are detected.
   *
   * @param {string} llmResponse
   * @returns {string}
   */
  parseResponse(llmResponse) {
    // P0-NEW-1: validate JSON block presence
    const { extractJsonBlock, validateJsonBlock } = require('../core/agent-output-schema');
    const jsonBlock = extractJsonBlock(llmResponse);
    if (!jsonBlock) {
      console.warn(`[ArchitectAgent] ⚠️  No structured JSON block found in output. Downstream agents will use regex-based extraction (degraded mode).`);
    } else {
      const check = validateJsonBlock(jsonBlock, 'architect');
      if (!check.valid) {
        console.warn(`[ArchitectAgent] ⚠️  JSON block validation failed: ${check.reason}`);
      } else {
        console.log(`[ArchitectAgent] ✅ Structured JSON block validated (${Object.keys(jsonBlock).length} fields).`);
      }
    }

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

    // ── Mandatory section compliance check ──────────────────────────────────
    const mandatorySections = ['Architecture Design', 'Execution Plan'];
    const missingSections = mandatorySections.filter(s => !llmResponse.includes(s));
    if (missingSections.length > 0) {
      console.warn(`[ArchitectAgent] ⚠️  COMPLIANCE: Missing mandatory section(s): ${missingSections.join(', ')}. The agent output specification requires these sections.`);
    } else {
      console.log(`[ArchitectAgent] ✅ Mandatory sections present: Architecture Design, Execution Plan.`);
    }

    return llmResponse;
  }
}

module.exports = { ArchitectAgent };
