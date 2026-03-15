/**
 * TesterAgent – Quality Testing Agent
 *
 * Role: Independent auditor.
 * Input:  output/code.diff  (file path passed by orchestrator)
 * Output: output/test-report.md
 *
 * Constraints:
 *  - MUST operate as a black-box tester (no knowledge of internal implementation)
 *  - MUST NOT modify any source files, requirement.md, or architecture.md
 *  - MUST produce an objective, evidence-based test report
 *  - Context is intentionally isolated from the developer agent's context
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { BaseAgent } = require('./base-agent');
const { AgentRole } = require('../core/types');
const { PATHS } = require('../core/constants');

class TesterAgent extends BaseAgent {
  constructor(llmCall, hookEmitter) {
    super(AgentRole.TESTER, llmCall, hookEmitter);
  }

  /**
   * Builds the tester prompt.
   * Input content is the code diff to be reviewed.
   * Black-box approach: tester evaluates observable behaviour, not internals.
   *
   * @param {string} inputContent - Content of code.diff
   * @param {string|null} expContext - Experience context block from ExperienceStore (optional)
   * @returns {string}
   */
  buildPrompt(inputContent, expContext = null) {
    const expSection = expContext
      ? `\n## Accumulated Experience (Reference Before Testing)\n${expContext}\n`
      : '';

    // Inject requirements.md and architecture.md so the tester can verify
    // acceptance criteria coverage and architecture compliance – without these,
    // the "Coverage Analysis" section would be based on guesswork.
    const requirementsPath = path.join(PATHS.OUTPUT_DIR, 'requirements.md');
    const architecturePath = path.join(PATHS.OUTPUT_DIR, 'architecture.md');

    const requirementsContent = fs.existsSync(requirementsPath)
      ? fs.readFileSync(requirementsPath, 'utf-8')
      : null;
    const architectureContent = fs.existsSync(architecturePath)
      ? fs.readFileSync(architecturePath, 'utf-8')
      : null;

    const requirementsSection = requirementsContent
      ? `\n## Requirements Document (for Coverage Verification)\n${requirementsContent}\n`
      : '';
    const architectureSection = architectureContent
      ? `\n## Architecture Document (for Compliance Verification)\n${architectureContent}\n`
      : '';

    return `You are a **Quality Testing Agent** – an independent auditor.

## Your Role
- Review the provided code diff from a BLACK-BOX perspective.
- Evaluate correctness, completeness, edge cases, and potential defects.
- Verify that the code satisfies ALL acceptance criteria in the requirements document.
- Verify that the code complies with the architecture design.
- Do NOT modify any source files, requirement documents, or architecture documents.
- Be objective and evidence-based: cite specific lines from the diff when reporting issues.
- If accumulated experience is provided below, apply proven test patterns and avoid known pitfalls.

## Output Format
Produce a Markdown test report with the following sections:
1. **Test Summary** – Overall pass/fail verdict with confidence score (0-100%)
2. **Test Cases Executed** – Table with columns: ID | Description | Input | Expected | Actual | Status
3. **Defects Found** – Numbered list with: Severity (Critical/High/Medium/Low) | Location | Description | Reproduction Steps
4. **Coverage Analysis** – Map each acceptance criterion from requirements.md to: ✅ Covered / ❌ Missing / ⚠️ Partial
5. **Architecture Compliance** – Verify each component/interface from architecture.md is correctly implemented
6. **Risk Assessment** – Areas of the code that carry the highest risk of failure
7. **Recommendations** – Specific, actionable fixes for each defect found
8. **Regression Checklist** – Items to verify after fixes are applied

## Severity Definitions
- **Critical**: System crash, data loss, security vulnerability
- **High**: Core feature broken, no workaround
- **Medium**: Feature partially broken, workaround exists
- **Low**: Minor UI/UX issue, cosmetic defect
${requirementsSection}${architectureSection}
## Code Diff to Review
\`\`\`diff
${inputContent}
\`\`\`
${expSection}
## Instructions
Write the test-report.md now. Be thorough, objective, and cite evidence from the diff.
Pay special attention to Coverage Analysis – every acceptance criterion must be explicitly verified.`;
  }

  /**
   * Parses the LLM response.
   * Validates that the report contains required sections.
   *
   * @param {string} llmResponse
   * @returns {string}
   */
  parseResponse(llmResponse) {
    const requiredSections = ['Test Summary', 'Defects Found', 'Recommendations'];
    const missingSections = requiredSections.filter(s => !llmResponse.includes(s));
    if (missingSections.length > 0) {
      console.warn(`[TesterAgent] WARNING: Test report missing sections: ${missingSections.join(', ')}`);
    }
    return llmResponse;
  }
}

module.exports = { TesterAgent };
