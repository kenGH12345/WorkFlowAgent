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

const path = require('path');
const { BaseAgent } = require('./base-agent');
const { AgentRole } = require('../core/types');
const { buildJsonBlockInstruction } = require('../core/agent-output-schema');

// ─── Anchor File Extraction ──────────────────────────────────────────────────

/**
 * Extracts anchor file references from user requirement text.
 *
 * Supports multiple formats that IDE Copilot may use:
 *   1. @file:path/to/file.ext or @path/to/file.ext
 *   2. Explicit file names with common extensions (e.g. "FarmRobotSettingSubUICtrl.lua")
 *   3. Markdown-style references [filename](path)
 *   4. Backtick-wrapped file references `path/to/file.ext`
 *
 * @param {string} text - User requirement text
 * @returns {{ anchorFiles: string[], anchorNames: string[] }}
 *   anchorFiles  – full paths or identifiable file references
 *   anchorNames  – just the base names (for display and search hinting)
 */
function extractAnchorFiles(text) {
  const anchorFiles = [];
  const seen = new Set();

  // Pattern 1: @file:path or @path/to/file.ext (IDE @ reference)
  const atFilePattern = /@(?:file:)?([\w\\/.\-]+\.\w{1,10})/g;
  let match;
  while ((match = atFilePattern.exec(text)) !== null) {
    const filePath = match[1].trim();
    if (!seen.has(filePath.toLowerCase())) {
      seen.add(filePath.toLowerCase());
      anchorFiles.push(filePath);
    }
  }

  // Pattern 2: Explicit file names with known extensions
  // Matches things like: FarmRobotSettingSubUICtrl.lua, UserService.ts, config.yaml
  const fileNamePattern = /(?:^|[\s"'`(,])([A-Za-z_][\w\-.]*\.(?:lua|js|ts|tsx|jsx|py|java|cs|cpp|c|h|go|rs|rb|php|swift|kt|vue|svelte|yaml|yml|json|xml|sql|sh|bat|ps1|css|scss|less|html))(?=[\s"'`),;]|$)/gm;
  while ((match = fileNamePattern.exec(text)) !== null) {
    const fileName = match[1].trim();
    if (!seen.has(fileName.toLowerCase())) {
      seen.add(fileName.toLowerCase());
      anchorFiles.push(fileName);
    }
  }

  // Pattern 3: Markdown-style [name](path) references
  const mdLinkPattern = /\[([^\]]+)\]\(([^)]+\.\w{1,10})\)/g;
  while ((match = mdLinkPattern.exec(text)) !== null) {
    const filePath = match[2].trim();
    if (!seen.has(filePath.toLowerCase())) {
      seen.add(filePath.toLowerCase());
      anchorFiles.push(filePath);
    }
  }

  // Pattern 4: Backtick-wrapped paths that look like files
  const backtickPattern = /`([\w\\/.\-]+\.\w{1,10})`/g;
  while ((match = backtickPattern.exec(text)) !== null) {
    const filePath = match[1].trim();
    // Accept if: has path separator, starts with uppercase, or has a source-code extension
    const hasPath = filePath.includes('/') || filePath.includes('\\');
    const hasCodeExt = /\.(lua|js|ts|tsx|jsx|py|java|cs|cpp|c|h|go|rs|rb|php|swift|kt|vue|svelte|yaml|yml|json|xml|sql|sh|bat|css|scss|html)$/i.test(filePath);
    if (hasPath || hasCodeExt || /^[A-Z]/.test(filePath)) {
      if (!seen.has(filePath.toLowerCase())) {
        seen.add(filePath.toLowerCase());
        anchorFiles.push(filePath);
      }
    }
  }

  const anchorNames = anchorFiles.map(f => path.basename(f).replace(/\.[^.]+$/, ''));

  return { anchorFiles, anchorNames };
}

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

    // ── Anchor File Extraction ────────────────────────────────────────────
    // Extract user-referenced files (@file or explicit names) from the requirement.
    // These are injected as an "Anchor Files" section so the LLM focuses its
    // codebase research on these files and their direct dependencies, instead
    // of performing broad exploratory searches across the entire project.
    const { anchorFiles, anchorNames } = extractAnchorFiles(inputContent);
    let anchorSection = '';
    if (anchorFiles.length > 0) {
      console.log(`[AnalystAgent] \uD83D\uDCCC Anchor files extracted: [${anchorFiles.join(', ')}]`);
      anchorSection = `\n## Anchor Files (User-Referenced)\nThe user has explicitly referenced the following files. **Focus your codebase research on these files and their direct dependencies ONLY.** Do NOT search broadly across the project.\n${anchorFiles.map(f => `- \`${f}\``).join('\n')}\n\n**Search strategy**: Start by reading these anchor files. Then identify their imports/dependencies and callers. Do NOT search for unrelated files.\n`;
    } else {
      // No explicit file references — extract entity names for focused search
      const entityPattern = /\b([A-Z][a-zA-Z0-9]{2,}(?:[A-Z][a-z]+)+)\b/g;
      const entities = [];
      const entitySeen = new Set();
      let m;
      while ((m = entityPattern.exec(inputContent)) !== null) {
        if (!entitySeen.has(m[1])) {
          entitySeen.add(m[1]);
          entities.push(m[1]);
        }
      }
      if (entities.length > 0) {
        console.log(`[AnalystAgent] \uD83D\uDD0D Inferred entity names: [${entities.slice(0, 8).join(', ')}]`);
        anchorSection = `\n## Inferred Entities\nNo explicit file references found. The following entity names were extracted from the requirement. **Search for these specific names only** — do NOT perform broad exploratory searches.\n${entities.slice(0, 8).map(e => `- \`${e}\``).join('\n')}\n`;
      }
    }

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
8. **Functional Module Map** *(mandatory)* – A structured decomposition of the codebase into functional modules:
   - Based on your codebase research, identify the distinct functional modules affected by this requirement.
   - For each module, provide: a short ID (e.g. "mod-auth"), a descriptive name, a one-line description, file path boundaries (glob patterns), dependencies on other modules, complexity estimate (low/medium/high), and whether it is isolatable (can be designed/implemented independently).
   - Also identify cross-cutting concerns that span multiple modules (e.g. logging, error-handling, config).
   - This module map is used by downstream ARCHITECT stage to enable parallel architecture design.
   - If the requirement is small and touches only 1 module, still produce the map with that single module.
   - ⚠️ This section is REQUIRED. If you skip it, the workflow will flag a compliance error.
   - Output format example:
     \`\`\`
     | Module ID | Name | Description | Boundaries | Dependencies | Complexity | Isolatable |
     |-----------|------|-------------|------------|--------------|------------|------------|
     | mod-auth  | Authentication | User login, registration, token management | src/auth/*, src/middleware/auth* | mod-db, mod-config | medium | yes |
     \`\`\`
     Cross-cutting concerns: logging, error-handling, configuration

${jsonInstruction}

**IMPORTANT for JSON block**: The JSON metadata block MUST include a "moduleMap" field with this structure:
\`\`\`
"moduleMap": {
  "modules": [
    {
      "id": "mod-xxx",
      "name": "Module Name",
      "description": "One-line description",
      "boundaries": ["src/xxx/*", "src/yyy/*"],
      "dependencies": ["mod-yyy"],
      "complexity": "low|medium|high",
      "isolatable": true|false
    }
  ],
  "crossCuttingConcerns": ["logging", "error-handling"]
}
\`\`\`

## User Requirement
${inputContent}
${anchorSection}${expSection}
## Codebase Research Rules (CRITICAL)
- If Anchor Files are listed above: read ONLY those files and their direct imports/callers. Do NOT search for other files.
- If Inferred Entities are listed above: search for ONLY those entity names. Do NOT broaden the search.
- **Search budget**: at most 6 file searches and 4 file reads. Stop once you have enough context to write the requirement.
- **Relevance gate**: before reading any file, ask: "Is this directly needed to understand the user's requirement?" If no, skip it.
- Do NOT perform broad pattern searches like "Show.*Food" or "Close.*Menu" that match unrelated files.

## Output Language
**You MUST write the entire requirement document in Chinese (简体中文).** All section headings, descriptions, user stories, acceptance criteria, and explanations must be in Chinese. Only keep technical terms, proper nouns, file names, and code identifiers in English.

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
    // Verify that the mandatory "Architecture Design", "Execution Plan", and
    // "Functional Module Map" sections are present in the output.
    const mandatorySections = ['Architecture Design', 'Execution Plan', 'Functional Module Map'];
    const missingSections = mandatorySections.filter(s => !llmResponse.includes(s));
    if (missingSections.length > 0) {
      console.warn(`[AnalystAgent] ⚠️  COMPLIANCE: Missing mandatory section(s): ${missingSections.join(', ')}. The agent output specification requires these sections.`);
    } else {
      console.log(`[AnalystAgent] ✅ Mandatory sections present: Architecture Design, Execution Plan, Functional Module Map.`);
    }

    // ── Module Map validation ──────────────────────────────────────────────
    // Verify that the JSON block contains a valid moduleMap structure.
    if (jsonBlock && jsonBlock.moduleMap) {
      const mm = jsonBlock.moduleMap;
      if (Array.isArray(mm.modules) && mm.modules.length > 0) {
        const validModules = mm.modules.filter(m => m.id && m.name);
        const isolatableCount = mm.modules.filter(m => m.isolatable).length;
        console.log(`[AnalystAgent] 🗺️  Module Map: ${validModules.length} module(s), ${isolatableCount} isolatable, ${(mm.crossCuttingConcerns || []).length} cross-cutting concern(s).`);
        if (validModules.length < mm.modules.length) {
          console.warn(`[AnalystAgent] ⚠️  Module Map: ${mm.modules.length - validModules.length} module(s) missing required 'id' or 'name' field.`);
        }
      } else {
        console.warn(`[AnalystAgent] ⚠️  Module Map: 'modules' array is empty or missing. Downstream ARCHITECT may not benefit from parallel design.`);
      }
    } else if (jsonBlock) {
      console.warn(`[AnalystAgent] ⚠️  Module Map: No 'moduleMap' field found in JSON block. ARCHITECT stage will use single-pass design.`);
    }

    return llmResponse;
  }
}

module.exports = { AnalystAgent, extractAnchorFiles };
