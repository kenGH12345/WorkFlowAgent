'use strict';

const fs   = require('fs');
const path = require('path');
const { PATHS } = require('./constants');
const { WorkflowState } = require('./types');
const { fileLockManager } = require('./file-lock-manager');

/**
 * Helper methods for Orchestrator.
 * All functions use `this` bound to the Orchestrator instance.
 */

/**
 * Builds investigation tools for SelfCorrectionEngine deep investigation.
 * @this {Orchestrator}
 */
function _buildInvestigationTools(stageLabel) {
  const self = this;

  const _getSourceCache = () => {
    if (self._investigationSourceCacheMap.has(stageLabel)) {
      return self._investigationSourceCacheMap.get(stageLabel);
    }

    // ── Dynamic upstream file discovery (Defect #9 fix) ──────────────────────
    // Previously, the file list was hardcoded per stage label.
    // Now we dynamically collect ALL upstream stage artifacts from StageContextStore
    // plus a fixed set of well-known output files, so investigation tools always
    // have full visibility into what upstream stages produced.
    const filesToRead = new Set([PATHS.AGENTS_MD]);

    // Always include requirements.md if it exists
    filesToRead.add(path.join(PATHS.OUTPUT_DIR, 'requirements.md'));

    // Dynamically add artifacts from all upstream stages (via StageContextStore)
    if (self.stageCtx) {
    const stageOrder = [WorkflowState.ANALYSE, WorkflowState.ARCHITECT, WorkflowState.PLAN, WorkflowState.CODE, WorkflowState.TEST];
    const currentStageIdx = stageOrder.indexOf(
      stageLabel === 'Architecture' ? WorkflowState.ARCHITECT
      : stageLabel === 'Code'       ? WorkflowState.CODE
      : stageLabel === 'TestReport' ? WorkflowState.TEST
      : stageLabel.toUpperCase()
    );
      for (let i = 0; i < stageOrder.length; i++) {
        if (currentStageIdx !== -1 && i >= currentStageIdx) break; // only upstream
        const ctx = self.stageCtx.get(stageOrder[i]);
        if (ctx && ctx.artifacts) {
          ctx.artifacts.forEach(a => filesToRead.add(a));
        }
      }
    }

    // Fallback: always include well-known output files for each stage
    if (stageLabel === 'Code' || stageLabel === 'TestReport') {
      filesToRead.add(path.join(PATHS.OUTPUT_DIR, 'architecture.md'));
    }
    if (stageLabel === 'TestReport') {
      filesToRead.add(path.join(PATHS.OUTPUT_DIR, 'code.diff'));
      filesToRead.add(path.join(PATHS.OUTPUT_DIR, 'test-execution-report.md'));
    }

    const parts = [];

    // Inject cross-stage context summary first (most important for investigation)
    if (self.stageCtx) {
      const crossCtx = self.stageCtx.getAll([], 1200);
      if (crossCtx) {
        parts.push(`**Cross-Stage Context Summary:**\n${crossCtx}`);
        console.log(`  [Investigation:readSource] Cross-stage context injected (${crossCtx.length} chars).`);
      }
    }

    for (const filePath of filesToRead) {
      if (!filePath || !fs.existsSync(filePath)) continue;
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        // Use larger excerpts for directly relevant files, smaller for context files
        const isDirectInput = filePath.includes('architecture.md') || filePath.includes('code.diff');
        const maxChars = isDirectInput ? 1200 : 600;
        const excerpt = raw.slice(0, maxChars);
        parts.push(`**${path.basename(filePath)}** (excerpt):\n${excerpt}`);
        console.log(`  [Investigation:readSource] Read ${path.basename(filePath)} (${raw.length} chars, showing ${excerpt.length}).`);
      } catch (err) {
        console.warn(`  [Investigation:readSource] Failed to read ${filePath}: ${err.message}`);
      }
    }
    const result = parts.length > 0 ? parts.join('\n\n---\n\n') : null;
    self._investigationSourceCacheMap.set(stageLabel, result);
    return result;
  };

  return {
    search: async (query) => {
      console.log(`  [Investigation:search] Querying experience store for: "${query}"`);
      const results = self.experienceStore.search({ keyword: query, limit: 5, scoreSort: true });
      if (!results || results.length === 0) {
        console.log(`  [Investigation:search] No experience records found.`);
        return null;
      }
      const snippets = results.slice(0, 5).map((r, i) =>
        `${i + 1}. [${r.type}] ${r.title}\n   ${r.content?.slice(0, 200) ?? ''}`
      ).join('\n\n');
      console.log(`  [Investigation:search] Found ${results.length} record(s). Using top ${Math.min(results.length, 5)}.`);
      return snippets;
    },

    readSource: async (signalType, _content) => {
      const cached = _getSourceCache();
      if (!cached) {
        console.log(`  [Investigation:readSource] No source files found.`);
      }
      return cached;
    },

    queryExperience: async (signalType) => {
      const skillName = stageLabel === 'Architecture' ? 'architecture-design'
                      : stageLabel === 'Code'         ? 'code-development'
                      : 'test-report';
      const contextBlock = await self.experienceStore.getContextBlock(skillName);
      if (!contextBlock) {
        console.log(`  [Investigation:queryExperience] No experience context for signal type "${signalType}".`);
        return null;
      }
      console.log(`  [Investigation:queryExperience] Retrieved experience context (${contextBlock.length} chars).`);
      return contextBlock;
    },

    queryGraph: async (symbolName) => {
      if (stageLabel !== 'Code' && stageLabel !== 'TestReport') return null;
      console.log(`  [Investigation:queryGraph] Looking up symbol: "${symbolName}"`);
      try {
        const md = self.codeGraph.querySymbolsAsMarkdown([symbolName]);
        if (md && !md.includes('_No matching') && !md.includes('_Code graph not')) {
          console.log(`  [Investigation:queryGraph] Found symbol info for "${symbolName}".`);
          return md;
        }
        // P1: Fallback to semantic search — natural-language queries like
        // "context loader" or "build prompt" benefit from the TF-IDF engine.
        const searchResults = self.codeGraph.search(symbolName, { limit: 3 });
        if (searchResults.length > 0) {
          const names = searchResults.map(s => s.name);
          const searchMd = self.codeGraph.querySymbolsAsMarkdown(names);
          if (searchMd && !searchMd.includes('_No matching')) {
            console.log(`  [Investigation:queryGraph] Found ${searchResults.length} symbol(s) via semantic search for "${symbolName}".`);
            return searchMd;
          }
        }
        console.log(`  [Investigation:queryGraph] No results for "${symbolName}".`);
        return null;
      } catch (err) {
        console.warn(`  [Investigation:queryGraph] Failed: ${err.message}`);
        return null;
      }
    },

    /**
     * Web search tool – queries the internet for external knowledge when local
     * experience and code graph are insufficient to resolve an issue.
     * Only available when WebSearchAdapter is registered in MCPRegistry.
     *
     * @param {string} query - Search query string
     * @returns {Promise<string|null>} Formatted search results or null
     */
    webSearch: async (query) => {
      if (!self.services || !self.services.has('mcpRegistry')) {
        console.log(`  [Investigation:webSearch] No MCPRegistry available. Skipping web search.`);
        return null;
      }
      try {
        const registry = self.services.resolve('mcpRegistry');
        const wsAdapter = registry.get('websearch');
        if (!wsAdapter) {
          console.log(`  [Investigation:webSearch] WebSearchAdapter not registered. Skipping.`);
          return null;
        }
        console.log(`  [Investigation:webSearch] 🌐 Searching web for: "${query.slice(0, 100)}"`);
        const result = await wsAdapter.search(query, { maxResults: 3 });
        if (!result || !result.results || result.results.length === 0) {
          console.log(`  [Investigation:webSearch] No web results found.`);
          return null;
        }
        const formatted = result.results.map((r, i) =>
          `${i + 1}. **${r.title}**\n   URL: ${r.url}\n   ${(r.snippet || '').slice(0, 200)}`
        ).join('\n\n');
        console.log(`  [Investigation:webSearch] ✅ Found ${result.results.length} web result(s) (provider: ${result.provider}).`);
        return formatted;
      } catch (err) {
        console.warn(`  [Investigation:webSearch] Web search failed: ${err.message}`);
        return null;
      }
    },
  };
}

/**
 * Registers built-in skills for common development domains.
 * @this {Orchestrator}
 */
function _registerBuiltinSkills() {
  const configSkills = (this._config && this._config.builtinSkills) || [];
  const builtins = configSkills.length > 0 ? configSkills : [
    { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow', 'orchestration'] },
    { name: 'architecture-design',    description: 'Architecture design patterns, principles and best practices', domains: ['architecture', 'design'] },
    { name: 'code-development',       description: 'Code development patterns, coding standards and best practices', domains: ['development', 'coding'] },
    { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality', 'review'] },
    { name: 'api-design',             description: 'REST/RPC API design rules and patterns', domains: ['backend', 'api'] },
    { name: 'test-report',            description: 'Test report writing standards and quality assurance patterns', domains: ['testing', 'qa'] },
  ];

  if (configSkills.length > 0) {
    console.log(`[Orchestrator] Registering ${builtins.length} skills from workflow.config.js`);
  } else {
    console.log(`[Orchestrator] No workflow.config.js found. Using minimal built-in skills.`);
  }

  for (const skill of builtins) {
    try {
      this.skillEvolution.registerSkill(skill);
    } catch (err) {
      if (!err.message.includes('already registered') && !err.message.includes('already exists')) {
        console.warn(`[Orchestrator] Failed to register built-in skill "${skill.name}": ${err.message}`);
      }
    }
  }
}

/**
 * Parses and applies fix blocks from an LLM response.
 *
 * Supports two block formats:
 *
 * 1. [REPLACE_IN_FILE] – string-match replacement (original format, kept for compatibility)
 *    Fails when LLM-generated "find:" text has subtle whitespace/indent differences from
 *    the actual file. see CHANGELOG: P0-C
 *
 * 2. [LINE_RANGE] – line-number replacement (new format, preferred for Fix Agent)
 *    Replaces lines startLine..endLine (1-based, inclusive) with new content.
 *    Immune to whitespace/indent mismatches because it uses line numbers, not text search.
 *    The Fix Agent is instructed to prefer this format when it knows the exact line range.
 *
 * @this {Orchestrator}
 */
function _applyFileReplacements(llmResponse) {
  let applied = 0;
  let failed = 0;
  const errors = [];
  const modifiedFiles = []; // P2-B: track which files were modified
  const lockConflicts = []; // Optimistic lock: track conflict details

  // Determine agentId for lock tracking (from task-based worker context if available)
  const agentId = this._currentAgentId || 'sequential';

  // ── Format 2: [LINE_RANGE] blocks (preferred – immune to whitespace mismatch) ──
  const lineRangeRegex = /\[LINE_RANGE\]([\s\S]*?)\[\/LINE_RANGE\]/g;
  let lrMatch;
  while ((lrMatch = lineRangeRegex.exec(llmResponse)) !== null) {
    const blockContent = lrMatch[1];
    try {
      const fileMatch      = blockContent.match(/^[ \t]*file:\s*(.+)$/m);
      const startLineMatch = blockContent.match(/^[ \t]*start_line:\s*(\d+)$/m);
      const endLineMatch   = blockContent.match(/^[ \t]*end_line:\s*(\d+)$/m);
      const replaceMatch   = blockContent.match(/^[ \t]*replace:\s*\|\s*\n([\s\S]*)$/m);

      if (!fileMatch)      { errors.push(`[LINE_RANGE] Block missing "file:" field`);       failed++; continue; }
      if (!startLineMatch) { errors.push(`[LINE_RANGE] Block missing "start_line:" field`); failed++; continue; }
      if (!endLineMatch)   { errors.push(`[LINE_RANGE] Block missing "end_line:" field`);   failed++; continue; }
      if (!replaceMatch)   { errors.push(`[LINE_RANGE] Block missing "replace: |" section`); failed++; continue; }

      const relPath   = fileMatch[1].trim();
      const absPath   = path.isAbsolute(relPath) ? relPath : path.join(this.projectRoot, relPath);
      const startLine = parseInt(startLineMatch[1], 10);
      const endLine   = parseInt(endLineMatch[1], 10);

      if (!fs.existsSync(absPath)) {
        errors.push(`[LINE_RANGE] File not found: ${absPath}`);
        failed++;
        continue;
      }
      if (startLine < 1 || endLine < startLine) {
        errors.push(`[LINE_RANGE] Invalid line range ${startLine}..${endLine} in ${relPath}`);
        failed++;
        continue;
      }

      const stripIndent = (text) => {
        const lines = text.split('\n');
        const nonEmpty = lines.filter(l => l.trim().length > 0);
        if (nonEmpty.length === 0) return text;
        const minIndent = Math.min(...nonEmpty.map(l => l.match(/^(\s*)/)[1].length));
        return lines.map(l => l.slice(minIndent)).join('\n');
      };

      const newContent = stripIndent(replaceMatch[1]).replace(/\n$/, '');

      const original = this.dryRun
        ? (this.sandbox.readFile(absPath) || fs.readFileSync(absPath, 'utf-8'))
        : fs.readFileSync(absPath, 'utf-8');

      // Optimistic lock: acquire version stamp before editing
      fileLockManager.acquireVersion(absPath, original, agentId);

      const fileLines = original.split('\n');
      if (endLine > fileLines.length) {
        errors.push(`[LINE_RANGE] end_line ${endLine} exceeds file length ${fileLines.length} in ${relPath}`);
        failed++;
        continue;
      }

      // Replace lines [startLine-1 .. endLine-1] (0-based) with new content lines
      const newLines = newContent.split('\n');
      fileLines.splice(startLine - 1, endLine - startLine + 1, ...newLines);
      const updated = fileLines.join('\n');

      if (this.dryRun) {
        this.sandbox.patchFile(absPath, original, updated);
        console.log(`[Orchestrator] 🧪 [DryRun] Would patch lines ${startLine}–${endLine}: ${relPath}`);
      } else {
        // Optimistic lock: re-read and verify before writing
        const preWriteContent = fs.readFileSync(absPath, 'utf-8');
        const lockCheck = fileLockManager.verifyVersion(absPath, preWriteContent, agentId);
        if (!lockCheck.valid) {
          const msg = `[LINE_RANGE] Optimistic lock conflict on ${relPath}: ${lockCheck.reason}`;
          errors.push(msg);
          lockConflicts.push({ file: relPath, reason: lockCheck.reason });
          console.warn(`[Orchestrator] 🔒 ${msg}`);
          failed++;
          continue;
        }
        fs.writeFileSync(absPath, updated, 'utf-8');
        fileLockManager.releaseVersion(absPath, updated, agentId);
        console.log(`[Orchestrator] ✏️  Patched lines ${startLine}–${endLine}: ${relPath}`);
      }
      modifiedFiles.push(relPath); // P2-B: track modified file
      applied++;

    } catch (err) {
      errors.push(`[LINE_RANGE] Error processing block: ${err.message}`);
      failed++;
    }
  }

  // ── Format 1: [REPLACE_IN_FILE] blocks (string-match, kept for compatibility) ──
  const blockRegex = /\[REPLACE_IN_FILE\]([\s\S]*?)\[\/REPLACE_IN_FILE\]/g;
  let match;

  while ((match = blockRegex.exec(llmResponse)) !== null) {
    const blockContent = match[1];

    try {
      const fileMatch = blockContent.match(/^[ \t]*file:\s*(.+)$/m);
      if (!fileMatch) {
        errors.push(`Block missing "file:" field`);
        failed++;
        continue;
      }
      const relPath = fileMatch[1].trim();
      const absPath = path.isAbsolute(relPath)
        ? relPath
        : path.join(this.projectRoot, relPath);

      if (!fs.existsSync(absPath)) {
        errors.push(`File not found: ${absPath}`);
        failed++;
        continue;
      }

      const findMatch = blockContent.match(/^[ \t]*find:\s*\|\s*\n([\s\S]*?)^[ \t]*replace:\s*\|/m);
      if (!findMatch) {
        errors.push(`Block for "${relPath}" missing "find: |" section`);
        failed++;
        continue;
      }

      const replaceMatch = blockContent.match(/^[ \t]*replace:\s*\|\s*\n([\s\S]*)$/m);
      if (!replaceMatch) {
        errors.push(`Block for "${relPath}" missing "replace: |" section`);
        failed++;
        continue;
      }

      const stripIndent = (text) => {
        const lines = text.split('\n');
        const nonEmpty = lines.filter(l => l.trim().length > 0);
        if (nonEmpty.length === 0) return text;
        const minIndent = Math.min(...nonEmpty.map(l => l.match(/^(\s*)/)[1].length));
        return lines.map(l => l.slice(minIndent)).join('\n');
      };

      const findStr    = stripIndent(findMatch[1]).replace(/\n$/, '');
      const replaceStr = stripIndent(replaceMatch[1]).replace(/\n$/, '');

      const original = this.dryRun
        ? (this.sandbox.readFile(absPath) || fs.readFileSync(absPath, 'utf-8'))
        : fs.readFileSync(absPath, 'utf-8');

      // Optimistic lock: acquire version stamp before editing
      fileLockManager.acquireVersion(absPath, original, agentId);

      if (!original.includes(findStr)) {
        errors.push(`"find:" text not found in ${relPath}. First 80 chars: "${findStr.slice(0, 80).replace(/\n/g, '↵')}"`);
        failed++;
        continue;
      }

      if (this.dryRun) {
        this.sandbox.patchFile(absPath, findStr, replaceStr);
        console.log(`[Orchestrator] 🧪 [DryRun] Would patch: ${relPath}`);
      } else {
        // Optimistic lock: re-read and verify before writing
        const preWriteContent = fs.readFileSync(absPath, 'utf-8');
        const lockCheck = fileLockManager.verifyVersion(absPath, preWriteContent, agentId);
        if (!lockCheck.valid) {
          const msg = `Optimistic lock conflict on ${relPath}: ${lockCheck.reason}`;
          errors.push(msg);
          lockConflicts.push({ file: relPath, reason: lockCheck.reason });
          console.warn(`[Orchestrator] 🔒 ${msg}`);
          failed++;
          continue;
        }
        // Only replace the FIRST occurrence. see CHANGELOG: P1-3
        const occurrences = original.split(findStr).length - 1;
        if (occurrences > 1) {
          console.warn(`[Orchestrator] ⚠️  "${relPath}": find text appears ${occurrences} time(s). Only replacing the FIRST occurrence.`);
        }
        const updated = original.replace(findStr, replaceStr);
        console.log(`[Orchestrator] ✏️  Patched: ${relPath}${occurrences > 1 ? ` (1 of ${occurrences} occurrence(s) replaced)` : ''}`);
        fs.writeFileSync(absPath, updated, 'utf-8');
        fileLockManager.releaseVersion(absPath, updated, agentId);
      }
      modifiedFiles.push(relPath); // P2-B: track modified file
      applied++;

    } catch (err) {
      errors.push(`Error processing block: ${err.message}`);
      failed++;
    }
  }

  if (applied === 0 && failed === 0) {
    errors.push('No [REPLACE_IN_FILE] or [LINE_RANGE] blocks found in LLM response');
    failed++;
  }

  // Log optimistic lock conflicts summary if any
  if (lockConflicts.length > 0) {
    console.warn(`[Orchestrator] 🔒 Optimistic lock: ${lockConflicts.length} conflict(s) detected. Files: ${lockConflicts.map(c => c.file).join(', ')}`);
  }

  return { applied, failed, errors, modifiedFiles, lockConflicts };
}

module.exports = { _buildInvestigationTools, _registerBuiltinSkills, _applyFileReplacements };
