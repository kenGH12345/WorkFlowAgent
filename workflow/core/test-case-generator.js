'use strict';

const fs   = require('fs');
const path = require('path');
const { PATHS } = require('./constants');
const { translateMdFile } = require('./i18n-translator');

/**
 * TestCaseGenerator – Pre-test planning module.
 *
 * Generates a structured test-cases.md BEFORE the TesterAgent runs.
 * This "test-first" approach forces explicit coverage planning and
 * significantly improves test report quality by:
 *  1. Deriving test cases directly from acceptance criteria (no guesswork)
 *  2. Ensuring every requirement has at least one corresponding test case
 *  3. Providing the TesterAgent with a concrete, executable checklist
 *  4. Making coverage gaps visible before the report is written
 *
 * Output format: output/test-cases.md
 *   - Part 1: JSON array of test cases (machine-readable, automation-ready)
 *   - Part 2: Acceptance criteria coverage matrix (human-readable)
 */
class TestCaseGenerator {
  /**
   * @param {Function} llmCall  - Raw LLM call function (prompt: string) => Promise<string>
   * @param {object}   opts
   * @param {boolean}  [opts.verbose=false]
   * @param {string}   [opts.outputDir]
   */
  constructor(llmCall, opts = {}) {
    this._llmCall   = llmCall;
    this._verbose   = opts.verbose ?? false;
    this._outputDir = opts.outputDir || PATHS.OUTPUT_DIR;
  }

  /**
   * Generates test-cases.md from requirements + architecture + code diff.
   *
   * @returns {Promise<{ path: string, caseCount: number, skipped: boolean }>}
   */
  async generate() {
    const requirementsPath = path.join(this._outputDir, 'requirement.md');
    const architecturePath = path.join(this._outputDir, 'architecture.md');
    const codeDiffPath     = path.join(this._outputDir, 'code.diff');
    const outputPath       = path.join(this._outputDir, 'test-cases.md');

    // Skip if no requirements available
    if (!fs.existsSync(requirementsPath)) {
      if (this._verbose) {
        console.log(`[TestCaseGenerator] ⏭️  Skipped: requirements.md not found.`);
      }
      return { path: null, caseCount: 0, skipped: true };
    }

    const requirementsContent = fs.readFileSync(requirementsPath, 'utf-8');
    const architectureContent = fs.existsSync(architecturePath)
      ? fs.readFileSync(architecturePath, 'utf-8')
      : null;
    const codeDiffContent = fs.existsSync(codeDiffPath)
      ? fs.readFileSync(codeDiffPath, 'utf-8').slice(0, 6000) // cap to avoid token overflow
      : null;

    const archSection = architectureContent
      ? `\n### Architecture Document\n${architectureContent}\n`
      : '';
    const diffSection = codeDiffContent
      ? `\n### Code Diff (for context)\n\`\`\`diff\n${codeDiffContent}\n\`\`\`\n`
      : '';

    const prompt = `## Role
You are **Boris Beizer** – author of *Software Testing Techniques* (2nd ed.) and *Black-Box Testing*, and the engineer who gave the industry its vocabulary for test design: equivalence partitioning, boundary value analysis, cause-effect graphing, and state-transition testing.
Your hallmark: you design test cases that find bugs, not test cases that confirm the code works. You never write a test case that cannot fail.
You are a senior test engineer producing a complete, executable test suite from the requirements below.

## Input
I will provide a requirements document describing the features to be tested.
Based on this, generate a comprehensive set of test cases.

### Requirements Document
${requirementsContent}
${archSection}${diffSection}
## Output Requirements
Output TWO sections in sequence:

### SECTION 1 – Test Cases (JSON)
Output a JSON array. Each object must contain exactly these fields:
- \`case_id\`: string, format: TC_<FEATURE>_<NNN> (e.g. TC_LOGIN_001, TC_REG_002)
- \`title\`: string, concise test title in format "Verify [condition] when [action]"
- \`precondition\`: string, the required initial state before the test starts
- \`steps\`: array of strings, each string is ONE atomic action (no compound steps)
- \`expected\`: string, specific and assertable expected result (e.g. "Page URL changes to /dashboard", "Error message 'Invalid password' appears")
- \`test_data\`: object, concrete key-value pairs of all test data used (NEVER use vague terms like "valid data" – always give actual values)
- \`automation_type\`: string, MUST be one of: \`"auto"\` (can be automated) or \`"manual"\` (requires human interaction, e.g. UI visual checks, hardware-dependent, captcha, OAuth flows). Default to \`"auto"\` unless the test genuinely cannot be automated.
Output the JSON array between these exact markers:
\`\`\`json
[
  { ... }
]
\`\`\`

### SECTION 2 – Coverage Matrix (Markdown)
After the JSON block, output a Markdown table mapping every acceptance criterion to test case IDs:

## Acceptance Criteria Coverage Matrix

| Requirement / Criterion | Test Case IDs | Coverage Status |
|------------------------|---------------|-----------------|
| AC-001: ... | TC_XXX_001, TC_XXX_002 | ✅ Covered |
| AC-002: ... | – | ❌ Not covered |

## Test Design Principles
Apply ALL of the following methods when generating test cases:
1. **Equivalence Partitioning** – valid class, invalid class for each input field
2. **Boundary Value Analysis** – min, max, min-1, max+1 for numeric/length constraints
3. **Error Guessing** – SQL injection, XSS, special characters, null/empty, whitespace-only
4. **Scenario Flow** – happy path end-to-end, then each failure branch
5. **Coverage Rule** – every acceptance criterion must have ≥1 test case; every input field must have ≥1 negative test

## Quality Rules
- Steps must be atomic: "Click the Submit button" ✅ / "Fill in the form and submit" ❌
- Expected results must be observable and assertable: "Toast message 'Saved successfully' appears" ✅ / "Operation succeeds" ❌
- test_data must contain real values: \`{"username": "testuser", "password": "Pass123!"}\` ✅ / \`{"username": "valid username"}\` ❌
- Include at least: 1 happy-path case, 2 negative/error cases, 1 boundary case per major feature
- Priority field is NOT required in the JSON (keep schema minimal)

## Few-Shot Examples (follow this format exactly)

### Example Input (fragment):
"User registration: username must be alphanumeric, 6–20 characters. If username already exists, show 'Username already taken'."

### Example Output (fragment):
\`\`\`json
[
  {
    "case_id": "TC_REG_001",
    "title": "Verify successful registration with valid username",
    "precondition": "Registration page is open; username 'testuser123' does not exist in the system",
    "steps": [
      "Enter 'testuser123' in the username field",
      "Enter 'Pass1234!' in the password field",
      "Click the Register button"
    ],
    "expected": "Page redirects to /register-success, or displays toast 'Registration successful, please log in'",
    "test_data": {"username": "testuser123", "password": "Pass1234!"},
    "automation_type": "auto"
  },
  {
    "case_id": "TC_REG_002",
    "title": "Verify registration fails when username already exists",
    "precondition": "Registration page is open; username 'existing' already exists in the system",
    "steps": [
      "Enter 'existing' in the username field",
      "Enter 'Pass1234!' in the password field",
      "Click the Register button"
    ],
    "expected": "Error message 'Username already taken' is displayed; page does not redirect",
    "test_data": {"username": "existing", "password": "Pass1234!"},
    "automation_type": "auto"
  },
  {
    "case_id": "TC_REG_003",
    "title": "Verify registration fails when username is shorter than 6 characters (boundary)",
    "precondition": "Registration page is open",
    "steps": [
      "Enter 'abc' in the username field",
      "Enter 'Pass1234!' in the password field",
      "Click the Register button"
    ],
    "expected": "Inline validation error 'Username must be 6–20 characters' is displayed",
    "test_data": {"username": "abc", "password": "Pass1234!"},
    "automation_type": "auto"
  },
  {
    "case_id": "TC_REG_004",
    "title": "Verify registration fails when username contains special characters",
    "precondition": "Registration page is open",
    "steps": [
      "Enter 'user@name!' in the username field",
      "Enter 'Pass1234!' in the password field",
      "Click the Register button"
    ],
    "expected": "Inline validation error 'Username must contain only letters and numbers' is displayed",
    "test_data": {"username": "user@name!", "password": "Pass1234!"},
    "automation_type": "auto"
  }
]
\`\`\`

## Final Instructions
Now generate the complete test suite for the requirements provided above.
- Output ONLY the two sections described (JSON block + Coverage Matrix).
- Do NOT add any explanation, preamble, or commentary outside these two sections.
- Ensure every acceptance criterion appears in the Coverage Matrix.`;

    if (this._verbose) {
      console.log(`[TestCaseGenerator] 🧪 Generating test cases from requirements...`);
    }

    let response;
    try {
      response = await this._llmCall(prompt);
    } catch (err) {
      console.warn(`[TestCaseGenerator] ⚠️  LLM call failed (non-fatal): ${err.message}`);
      return { path: null, caseCount: 0, skipped: true };
    }

    if (!response || !response.trim()) {
      console.warn(`[TestCaseGenerator] ⚠️  LLM returned empty response. Skipping.`);
      return { path: null, caseCount: 0, skipped: true };
    }

    // P2-4 fix: count test cases by parsing the JSON block instead of regex matching
    // on "case_id" strings. The previous regex approach over-counted when the LLM
    // included "case_id" in Coverage Matrix examples or commentary text.
    let caseCount = 0;
    try {
      const jsonMatch2 = response.match(/```json\s*([\s\S]*?)```/);
      if (jsonMatch2) {
        const parsed = JSON.parse(jsonMatch2[1].trim());
        caseCount = Array.isArray(parsed) ? parsed.length : 0;
      }
    } catch {
      // Fallback to regex if JSON parse fails
      caseCount = (response.match(/"case_id"\s*:/g) || []).length;
    }

    // Wrap output in a titled Markdown document
    const finalContent = `# Test Cases\n\n> Auto-generated by TestCaseGenerator before the test stage.\n> The JSON block below is automation-ready. The Coverage Matrix follows.\n\n${response}`;

    // P2-1 fix: backup existing test-cases.md before overwriting.
    // Previously: writeFileSync always overwrote the file, destroying any
    // _annotateResults() execution statuses appended by TestCaseExecutor.
    // If the workflow rolls back to CODE and re-runs, the historical execution
    // results (PASS/FAIL/BLOCKED statuses) are permanently lost.
    // Fix: rename the existing file to test-cases.v{N}.md before writing the new one.
    if (fs.existsSync(outputPath)) {
      try {
        let version = 1;
        let backupPath;
        do {
          backupPath = outputPath.replace(/\.md$/, `.v${version}.md`);
          version++;
        } while (fs.existsSync(backupPath));
        fs.renameSync(outputPath, backupPath);
        if (this._verbose) {
          console.log(`[TestCaseGenerator] 📦 Backed up previous test-cases.md → ${require('path').basename(backupPath)}`);
        }
      } catch (backupErr) {
        console.warn(`[TestCaseGenerator] ⚠️  Could not backup test-cases.md (non-fatal): ${backupErr.message}`);
      }
    }

    fs.writeFileSync(outputPath, finalContent, 'utf-8');

    if (this._verbose) {
      console.log(`[TestCaseGenerator] ✅ Generated ${caseCount} test case(s) → ${outputPath}`);
    }

    // Async Chinese translation – non-blocking, does not affect main flow
    translateMdFile(outputPath, this._llmCall).catch((err) => {
      console.warn(`[TestCaseGenerator] ⚠️  Chinese translation failed (non-fatal): ${err.message}`);
    });

    return { path: outputPath, caseCount, skipped: false };
  }
}

module.exports = { TestCaseGenerator };
