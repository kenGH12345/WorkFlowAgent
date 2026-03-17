/**
 * ContextLoader – Context-aware document auto-injector
 *
 * Solves the "Agent won't read skills/ or decision-log.md unless prompted" problem.
 *
 * How it works:
 *  1. Skill matching  – scans task text for domain keywords, loads matching skill files
 *  2. ADR extraction  – extracts relevant ADR entries from decision-log.md by keyword
 *  3. Role mandates   – each agent role has a fixed set of docs it MUST always receive
 *
 * Integration: called inside buildAgentPrompt() before building the dynamic suffix.
 * Zero-config: works out of the box; projects can extend via workflow.config.js.
 *
 * Token budget: total injected context is capped at MAX_INJECT_TOKENS to avoid
 * pushing the prompt over the hallucination-risk threshold.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { PATHS } = require('./constants');
const { estimateTokens } = require('../tools/thin-tools');

// ─── Configuration ────────────────────────────────────────────────────────────

/** Max tokens to inject from skills + ADRs combined (per prompt call) */
const MAX_INJECT_TOKENS = 2800;

/** Max tokens for a single skill file injection */
const MAX_SKILL_TOKENS = 800;

/** Max tokens for the ADR digest injection */
const MAX_ADR_TOKENS = 600;

/** Max tokens for the code graph injection (compact summary only) */
const MAX_GRAPH_TOKENS = 600;

// ─── Keyword → Skill mapping (built-in defaults) ─────────────────────────────
// Keys are skill file names (without .md), values are trigger keyword arrays.
// Projects can extend this via workflow.config.js → skillKeywords.

const BUILTIN_SKILL_KEYWORDS = {
  'flutter-dev':          ['flutter', 'dart', 'widget', 'riverpod', 'provider', 'bloc', 'pubspec'],
  'javascript-dev':       ['javascript', 'js', 'node', 'npm', 'typescript', 'ts', 'react', 'vue', 'express'],
  'go-crud':              ['go', 'golang', 'gin', 'gorm', 'grpc', 'protobuf'],
  'java-dev':             ['java', 'spring', 'maven', 'gradle', 'jvm', 'kotlin'],
  'lua-scripting':        ['lua', 'luajit', 'coroutine', 'metatables', 'unity lua', 'xlua'],
  'unity-csharp':         ['unity', 'c#', 'csharp', 'monobehaviour', 'scriptableobject', 'ecs'],
  'api-design':           ['api', 'rest', 'graphql', 'endpoint', 'swagger', 'openapi', 'http'],
  'architecture-design':  ['architecture', 'design pattern', 'module', 'dependency', 'coupling', 'solid'],
  'code-review':          ['review', 'refactor', 'clean code', 'lint', 'quality', 'smell'],
  'test-report':          ['test', 'unit test', 'integration test', 'coverage', 'jest', 'pytest', 'mocha'],
  'project-onboarding':   ['onboard', 'setup', 'init', 'new project', 'getting started'],
  'workflow-orchestration':['workflow', 'orchestrat', 'agent', 'pipeline', 'stage'],
};

// ─── Role → Mandatory docs mapping ───────────────────────────────────────────
// These docs are ALWAYS injected for the given role, regardless of task content.

const ROLE_MANDATORY_DOCS = {
  analyst:    ['docs/architecture-constraints.md'],
  architect:  ['docs/architecture-constraints.md', 'docs/decision-log.md'],
  developer:  ['docs/architecture-constraints.md', 'output/code-graph.md'],
  tester:     ['docs/architecture-constraints.md'],
  'coding-agent': ['docs/architecture-constraints.md', 'output/code-graph.md'],
  'init-agent':   [],
};

// ─── ContextLoader ────────────────────────────────────────────────────────────

class ContextLoader {
  /**
   * @param {object} [options]
   * @param {string}   [options.workflowRoot]    - Root of the workflow directory
   * @param {string}   [options.projectRoot]     - Root of the project being worked on
   * @param {object}   [options.skillKeywords]   - Extra keyword→skill mappings from config
   * @param {string[]} [options.alwaysLoadSkills]- Skills to always inject regardless of keywords
   */
  constructor({
    workflowRoot    = PATHS.SKILLS_DIR ? path.dirname(PATHS.SKILLS_DIR) : __dirname,
    projectRoot     = null,
    skillKeywords   = {},
    alwaysLoadSkills = [],
  } = {}) {
    this._workflowRoot     = workflowRoot;
    this._projectRoot      = projectRoot || null;
    this._skillsDir        = path.join(workflowRoot, 'skills');
    this._docsDir          = workflowRoot;  // docs/ is relative to workflowRoot
    this._skillKeywords    = { ...BUILTIN_SKILL_KEYWORDS, ...skillKeywords };
    this._alwaysLoadSkills = alwaysLoadSkills;

    // ── File Read Cache (D1+D3 optimisation) ──────────────────────────────────
    // Caches file contents in memory to avoid redundant disk I/O within the same
    // workflow run. Skills and docs don't change during a run, so caching is safe.
    // Key: absolute file path, Value: { content: string, mtime: number }
    // The cache is per-instance; when a new ContextLoader is created, it starts fresh.
    /** @type {Map<string, { content: string, mtime: number }>} */
    this._fileCache = new Map();
  }

  /**
   * Reads a file with in-memory caching. Returns the cached content if the
   * file's mtime hasn't changed since last read; otherwise reads from disk
   * and updates the cache.
   *
   * @param {string} filePath - Absolute path to the file
   * @returns {string|null} File content, or null if the file doesn't exist
   * @private
   */
  _readFileCached(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      const stat = fs.statSync(filePath);
      const cached = this._fileCache.get(filePath);
      if (cached && cached.mtime === stat.mtimeMs) {
        return cached.content;
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      this._fileCache.set(filePath, { content, mtime: stat.mtimeMs });
      return content;
    } catch {
      return null;
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Resolves all context to inject for a given task + role.
   *
   * @param {string} taskText  - The task/prompt text (used for keyword matching)
   * @param {string} role      - Agent role (analyst|architect|developer|tester|...)
   * @returns {{ sections: string[], tokenCount: number, sources: string[] }}
   *   sections  – array of Markdown strings ready to inject
   *   tokenCount – total estimated tokens of all sections
   *   sources    – list of file names that were loaded (for logging)
   */
  resolve(taskText, role) {
    const sections = [];
    const sources  = [];
    let   budget   = MAX_INJECT_TOKENS;

    // 1. Role-mandatory docs (always injected first, highest priority)
    const mandatoryDocs = ROLE_MANDATORY_DOCS[role] || [];
    for (const docRelPath of mandatoryDocs) {
      // For output/ files (e.g. code-graph.md): must come from projectRoot only
      // (these are project-specific artifacts, not workflow-level docs)
      const isOutputFile = docRelPath.startsWith('output/');
      let docPath;
      if (isOutputFile) {
        if (!this._projectRoot) continue;  // no project root configured, skip
        docPath = path.join(this._projectRoot, docRelPath);
      } else {
        docPath = path.join(this._workflowRoot, docRelPath);
      }

      const content = this._readFileCached(docPath);
      if (!content) continue;
      const docName = path.basename(docRelPath);

      // For decision-log.md: extract only relevant ADR entries to save tokens
      if (docName === 'decision-log.md') {
        const digest = this._extractRelevantADRs(content, taskText, MAX_ADR_TOKENS);
        if (digest) {
          const tokens = estimateTokens(digest);
          if (tokens <= budget) {
            sections.push(`## 📋 Relevant Architecture Decisions (from decision-log.md)\n\n${digest}`);
            sources.push('decision-log.md (digest)');
            budget -= tokens;
          }
        }
      } else if (docName === 'code-graph.md') {
        // For code-graph.md: use compact summary with strict token cap
        const tokenCap = Math.min(MAX_GRAPH_TOKENS, budget);
        const truncated = this._truncate(content, tokenCap);
        if (truncated) {
          sections.push(`## 🗺️ Code Graph (project symbol index)\n\n${truncated}`);
          sources.push('code-graph.md');
          budget -= estimateTokens(truncated);
        }
      } else {
        const tokens = estimateTokens(content);
        const truncated = this._truncate(content, Math.min(tokens, budget));
        if (truncated) {
          sections.push(`## 📐 ${docName}\n\n${truncated}`);
          sources.push(docName);
          budget -= estimateTokens(truncated);
        }
      }
      if (budget <= 0) break;
    }

    // 2. Always-load skills (from config)
    for (const skillName of this._alwaysLoadSkills) {
      if (budget <= 0) break;
      const loaded = this._loadSkill(skillName, budget);
      if (loaded) {
        sections.push(loaded.section);
        sources.push(loaded.source);
        budget -= loaded.tokens;
      }
    }

    // 3. Keyword-matched skills (from task text)
    const matchedSkills = this._matchSkills(taskText, role);
    for (const skillName of matchedSkills) {
      if (budget <= 0) break;
      // Skip if already loaded via alwaysLoadSkills
      if (sources.some(s => s.startsWith(skillName))) continue;
      const loaded = this._loadSkill(skillName, Math.min(MAX_SKILL_TOKENS, budget));
      if (loaded) {
        sections.push(loaded.section);
        sources.push(loaded.source);
        budget -= loaded.tokens;
      }
    }

    const tokenCount = MAX_INJECT_TOKENS - budget;
    if (sources.length > 0) {
      console.log(`[ContextLoader] Injected ${sources.length} context doc(s) (~${tokenCount} tokens): ${sources.join(', ')}`);
    }

    return { sections, tokenCount, sources };
  }

  // ─── Skill Matching ───────────────────────────────────────────────────────

  /**
   * Returns skill names whose keywords appear in the task text.
   * Sorted by match score (most matches first).
   *
   * @param {string} taskText
   * @param {string} role
   * @returns {string[]}
   */
  _matchSkills(taskText, role) {
    const lower = taskText.toLowerCase();
    const scores = [];

    for (const [skillName, keywords] of Object.entries(this._skillKeywords)) {
      const skillPath = path.join(this._skillsDir, `${skillName}.md`);
      // Use _readFileCached to benefit from the cache (also pre-warms the cache
      // for _loadSkill which will be called next for matching skills).
      if (!this._readFileCached(skillPath)) continue;

      let score = 0;
      for (const kw of keywords) {
        if (lower.includes(kw.toLowerCase())) score++;
      }
      if (score > 0) scores.push({ skillName, score });
    }

    // Sort by score descending, return top 3 to stay within token budget
    return scores
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(s => s.skillName);
  }

  // ─── ADR Extraction ───────────────────────────────────────────────────────

  /**
   * Extracts relevant ADR entries from decision-log.md content.
   * Matches ADR blocks whose title or content contains task keywords.
   * Falls back to the last 2 ADRs if no keyword match found.
   *
   * @param {string} logContent  - Full content of decision-log.md
   * @param {string} taskText    - Task text for keyword matching
   * @param {number} tokenBudget - Max tokens for the digest
   * @returns {string|null}
   */
  _extractRelevantADRs(logContent, taskText, tokenBudget) {
    // Split into ADR blocks (each starts with ## ADR-)
    const adrBlocks = logContent.split(/(?=^## ADR-)/m).filter(b => b.trim().startsWith('## ADR-'));
    if (adrBlocks.length === 0) return null;

    const taskLower = taskText.toLowerCase();
    const taskWords = taskLower.split(/\W+/).filter(w => w.length > 3);

    // Score each ADR block by keyword overlap
    const scored = adrBlocks.map(block => {
      const blockLower = block.toLowerCase();
      const score = taskWords.filter(w => blockLower.includes(w)).length;
      return { block, score };
    });

    // Sort by score, take top matches; always include the most recent ADR
    const sorted = scored.sort((a, b) => b.score - a.score);
    const topMatches = sorted.filter(s => s.score > 0).slice(0, 3);

    // If no keyword match, fall back to the last 2 ADRs (most recent decisions)
    const toInclude = topMatches.length > 0
      ? topMatches
      : scored.slice(-2);

    // Build digest: extract just the Status + Context + Decision lines (not full body)
    const digestParts = toInclude.map(({ block }) => {
      const lines = block.split('\n');
      const title = lines[0]; // ## ADR-xxx: title
      const statusLine = lines.find(l => l.startsWith('**Status**'));
      const contextIdx = lines.findIndex(l => l.startsWith('**Context**'));
      const decisionIdx = lines.findIndex(l => l.startsWith('**Decision**'));

      const summary = [
        title,
        statusLine || '',
        contextIdx >= 0 ? lines.slice(contextIdx, contextIdx + 3).join('\n') : '',
        decisionIdx >= 0 ? lines.slice(decisionIdx, decisionIdx + 3).join('\n') : '',
      ].filter(Boolean).join('\n');

      return summary;
    });

    const digest = digestParts.join('\n\n---\n\n');
    return this._truncate(digest, tokenBudget);
  }

  // ─── Skill Loading ────────────────────────────────────────────────────────

  /**
   * Loads a skill file and returns a formatted section.
   *
   * @param {string} skillName
   * @param {number} tokenBudget
   * @returns {{ section: string, source: string, tokens: number }|null}
   */
  _loadSkill(skillName, tokenBudget) {
    const skillPath = path.join(this._skillsDir, `${skillName}.md`);
    const content = this._readFileCached(skillPath);
    if (!content) return null;

    // Skip empty/placeholder skills (no real content yet)
    if (this._isPlaceholderSkill(content)) return null;

    const truncated = this._truncate(content, tokenBudget);
    if (!truncated) return null;

    const tokens = estimateTokens(truncated);
    return {
      section: `## 🧠 Skill: ${skillName}\n\n${truncated}`,
      source:  `${skillName}.md`,
      tokens,
    };
  }

  /**
   * Returns true if a skill file has no real content yet (only placeholder text).
   */
  _isPlaceholderSkill(content) {
    const placeholderPhrases = [
      '_No rules defined yet',
      '_No SOP defined yet',
      '_No best practices defined yet',
    ];
    // If ALL sections are placeholders, skip the file
    const nonPlaceholderLines = content
      .split('\n')
      .filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('>') && !l.startsWith('|'))
      .filter(l => !placeholderPhrases.some(p => l.includes(p)));
    return nonPlaceholderLines.length < 3;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Truncates content to fit within a token budget.
   * Truncates at paragraph boundaries when possible.
   *
   * D6 optimisation: uses a content-aware chars/token ratio instead of a fixed
   * constant. Chinese text averages ~2 chars/token (vs ~4 for English), so a
   * Chinese-heavy document with 2000 chars is ~1000 tokens, not ~500.
   * We sample the first 200 chars to estimate the CJK ratio and adjust accordingly.
   *
   * @param {string} content
   * @param {number} tokenBudget
   * @returns {string}
   */
  _truncate(content, tokenBudget) {
    if (!content) return '';
    // Estimate CJK ratio from the first 200 chars to adjust chars/token ratio.
    // CJK characters: ~2 chars/token; ASCII/Latin: ~4 chars/token.
    const sample = content.slice(0, 200);
    const cjkCount = (sample.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []).length;
    const cjkRatio = sample.length > 0 ? cjkCount / sample.length : 0;
    const charsPerToken = cjkRatio > 0.3 ? 2 : (cjkRatio > 0.1 ? 3 : 4);
    const maxChars = tokenBudget * charsPerToken;
    if (content.length <= maxChars) return content;

    // Try to truncate at a paragraph boundary
    const truncated = content.slice(0, maxChars);
    const lastPara  = truncated.lastIndexOf('\n\n');
    const result    = lastPara > maxChars * 0.7 ? truncated.slice(0, lastPara) : truncated;
    return result + '\n\n> *(truncated to fit token budget)*';
  }
}

module.exports = { ContextLoader };
