/**
 * PlannerAgent – Execution Planning Agent
 *
 * Domain Expert: Kent Beck (XP creator, TDD pioneer, Agile Manifesto signatory)
 * Philosophy: "Make it work, make it right, make it fast" — incremental delivery in small, safe steps.
 *
 * Role: Strategic planner — decomposes architecture into dependency-aware, incrementally-deliverable tasks.
 * Input:  output/architecture.md  (file path passed by orchestrator)
 * Output: output/execution-plan.md
 *
 * Responsibilities:
 *  - Read the architecture document and decompose it into actionable implementation tasks
 *  - Define task dependencies, ordering, and acceptance criteria (TDD mindset: criteria before implementation)
 *  - Estimate complexity for each task
 *  - Group tasks into vertical-slice implementation phases
 *  - Apply XP principles: small steps, embrace change, feedback loops
 *
 * Constraints:
 *  - MUST NOT write any code
 *  - MUST NOT modify requirement.md or architecture.md
 *  - MUST produce a plan that the Developer agent can follow step by step
 */

'use strict';

const { BaseAgent } = require('./base-agent');
const { AgentRole } = require('../core/types');
const { buildJsonBlockInstruction } = require('../core/agent-output-schema');

class PlannerAgent extends BaseAgent {
  constructor(llmCall, hookEmitter, opts = {}) {
    super(AgentRole.PLANNER, llmCall, hookEmitter, opts);
  }

  /**
   * Builds the planner prompt.
   * Input content is the full text of architecture.md.
   *
   * @param {string} inputContent - Content of architecture.md
   * @param {string|null} expContext - Experience context block from ExperienceStore (optional)
   * @returns {string}
   */
  buildPrompt(inputContent, expContext = null) {
    const expSection = expContext
      ? `\n## Accumulated Experience (Reference Before Planning)\n${expContext}\n`
      : '';
    // Inject structured JSON output instruction
    const jsonInstruction = buildJsonBlockInstruction('planner');

    return `You are **Kent Beck** — creator of Extreme Programming (XP), pioneer of Test-Driven Development (TDD), and one of the original signatories of the Agile Manifesto.
You are renowned for your philosophy of **incremental delivery in small, safe steps**: "Make it work, make it right, make it fast."
Your hallmark: you decompose complex systems into the smallest possible independently-valuable tasks, ordered so that each step builds on a solid, tested foundation — minimising rework, maximising feedback, and ensuring that developers always have a clear, unambiguous next step.
You are acting as the **Execution Planning Agent** for this workflow.

## Your Role & Philosophy
- Read the architecture document thoroughly and produce a detailed execution plan.
- Decompose the architecture into concrete, actionable implementation tasks at the FILE and FUNCTION level.
- Apply your XP principle: **"Do the simplest thing that could possibly work"** for each task decomposition.
- Define clear dependencies between tasks (what must be done before what).
- Group tasks into logical implementation phases — each phase should deliver a **vertically-integrated slice** that can be tested independently.
- Estimate complexity for each task (Low / Medium / High).
- Define acceptance criteria for each task so the tester knows when it's "done" (your TDD instinct: criteria come BEFORE implementation).
- Apply your **"Embrace Change"** principle: order tasks so that later tasks can adapt without invalidating earlier work.
- Do NOT write any code, pseudocode, or implementation snippets.
- Do NOT modify or re-interpret the architecture – treat it as fixed input.
- If accumulated experience is provided below, use it to refine estimates and avoid known pitfalls (your **feedback loop** principle).

## Output Format
Produce a Markdown document with the following sections:

### 1. Plan Overview
- Total number of tasks
- Total number of phases
- Overall estimated complexity
- Critical path identification (which tasks form the longest dependency chain)

### 2. Implementation Phases
For each phase:
- **Phase N: <Phase Title>**
  - Goal: What this phase achieves
  - Prerequisites: What must be completed before this phase starts

### 3. Task Breakdown
For each task (use a consistent format):

#### Task T-<N>: <Task Title>
- **Phase**: Phase <N>
- **Complexity**: Low | Medium | High
- **Dependencies**: T-<X>, T-<Y> (or "None" if independent)
- **Files to create/modify**: List of specific file paths
- **Description**: What exactly needs to be implemented
- **Acceptance Criteria**:
  - [ ] Criterion 1 (testable, specific)
  - [ ] Criterion 2
  - ...
- **Risks/Notes**: Any known pitfalls or considerations

### 4. Dependency Graph
A visual representation of task dependencies (use Mermaid diagram):
\`\`\`mermaid
graph TD
  T1[Task 1] --> T3[Task 3]
  T2[Task 2] --> T3
  T3 --> T4[Task 4]
\`\`\`

### 5. Risk Assessment
- Tasks with highest risk of rework
- Potential blockers
- Mitigation strategies

### 6. Verification Checklist
A final checklist mapping each architecture component to its corresponding task(s), ensuring nothing is missed.

${jsonInstruction}

## Architecture Document
${inputContent}
${expSection}
## Output Language
**You MUST write the entire execution plan document in Chinese (简体中文).** All section headings, task descriptions, acceptance criteria, risk assessments, and notes must be in Chinese. Only keep technical terms, proper nouns, file names, code identifiers, and Mermaid diagram labels in English.

## Instructions
First output the JSON metadata block (as instructed above), then write the full Markdown document.
Remember: NO code, NO pseudocode – planning and task decomposition ONLY.
**CRITICAL**: Every task MUST have acceptance criteria. Tasks without acceptance criteria are incomplete.
**CRITICAL**: The dependency graph MUST be present and use Mermaid syntax.`;
  }

  /**
   * Parses the LLM response.
   * Validates JSON block and checks for mandatory sections.
   *
   * @param {string} llmResponse
   * @returns {string}
   */
  parseResponse(llmResponse) {
    // Validate JSON block presence
    const { extractJsonBlock, validateJsonBlock } = require('../core/agent-output-schema');
    const jsonBlock = extractJsonBlock(llmResponse);
    if (!jsonBlock) {
      console.warn(`[PlannerAgent] ⚠️  No structured JSON block found in output. Downstream agents will use regex-based extraction (degraded mode).`);
    } else {
      const check = validateJsonBlock(jsonBlock, 'planner');
      if (!check.valid) {
        console.warn(`[PlannerAgent] ⚠️  JSON block validation failed: ${check.reason}`);
      } else {
        console.log(`[PlannerAgent] ✅ Structured JSON block validated (${Object.keys(jsonBlock).length} fields).`);
      }
    }

    // Mandatory section compliance check
    const mandatorySections = ['Plan Overview', 'Implementation Phases', 'Task Breakdown', 'Dependency Graph'];
    const missingSections = mandatorySections.filter(s => !llmResponse.includes(s));
    if (missingSections.length > 0) {
      console.warn(`[PlannerAgent] ⚠️  COMPLIANCE: Missing mandatory section(s): ${missingSections.join(', ')}. The agent output specification requires these sections.`);
    } else {
      console.log(`[PlannerAgent] ✅ Mandatory sections present: ${mandatorySections.join(', ')}.`);
    }

    // Check for acceptance criteria presence
    const taskPattern = /#### Task T-/g;
    const taskCount = (llmResponse.match(taskPattern) || []).length;
    const criteriaPattern = /Acceptance Criteria/gi;
    const criteriaCount = (llmResponse.match(criteriaPattern) || []).length;
    if (taskCount > 0 && criteriaCount < taskCount) {
      console.warn(`[PlannerAgent] ⚠️  Only ${criteriaCount}/${taskCount} tasks have acceptance criteria. All tasks should have acceptance criteria.`);
    }

    // Detect implementation code (multi-line code blocks with logic)
    const codeBlockPattern = /```[\w]*\n([\s\S]*?)```/g;
    let match;
    while ((match = codeBlockPattern.exec(llmResponse)) !== null) {
      const blockContent = match[1];
      // Allow Mermaid and JSON blocks, but flag code blocks
      if (/[=;{}]/.test(blockContent) && !/^[\s#\-*>|]/.test(blockContent.trim()) && !blockContent.includes('graph ') && !blockContent.includes('"role"')) {
        console.warn(`[PlannerAgent] WARNING: Possible implementation code detected in execution-plan.md. Review recommended.`);
        break;
      }
    }

    return llmResponse;
  }
}

module.exports = { PlannerAgent };
