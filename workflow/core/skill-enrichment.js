/**
 * Skill Enrichment & Experience Preheating
 *
 * Extracted from context-budget-manager.js (P0 decomposition – ADR-33).
 * Contains: enrichSkillFromExternalKnowledge, preheatExperienceStore,
 *           enrichment concurrency control, LLM analysis prompts/parsers
 */

'use strict';

const { webSearchHelper } = require('./web-search-helpers');

// ─── External Knowledge → Skill Generation (ADR-29) ─────────────────────────

/**
 * Enriches a placeholder/empty skill by searching external knowledge sources
 * (web articles, docs, community best practices) and using LLM analysis to
 * generate structured skill content that fits the WFA Skill format natively.
 *
 * This is NOT "importing" external skills — it searches raw knowledge sources,
 * analyses them with an LLM, and auto-generates ALL 7 sections (Rules, SOP,
 * Checklist, Anti-Patterns, Gotchas, Best Practices, Context Hints) that are
 * fully native to WorkFlowAgent.
 *
 * Multi-pass enrichment:
 *   Pass 1: Full analysis across all 7 sections from initial search results
 *   Pass 2: Gap analysis identifies thin sections (< 3 entries), then runs a
 *           focused second pass with additional search results to fill gaps
 *
 * Triggers:
 *   1. Automatically when a new skill is created and detected as placeholder
 *   2. Manually via `/skill-enrich <name>` command
 *   3. From externalExperienceFallback() when high-quality results are found
 *
 * @param {Orchestrator} orch  - Orchestrator instance (provides WebSearch + LLM)
 * @param {string} skillName   - Target skill name (must exist in registry)
 * @param {object} [opts]
 * @param {number} [opts.maxSearchResults=5] - Max web search results per query
 * @param {number} [opts.maxFetchPages=3]    - Max pages to deep-fetch in first pass (2 more fetched in second pass)
 * @param {boolean} [opts.dryRun=false]      - If true, return generated content without writing
 * @returns {Promise<{success: boolean, sectionsAdded: number, sources: string[], error?: string}>}
 */
// ─── P2 Improvement: Enrichment Concurrency Control ─────────────────────────
// Rate limiter for batch enrichment: prevents API flooding when processing
// multiple skills in parallel. Uses a simple sliding-window approach.
const _enrichmentState = {
  activeConcurrency: 0,
  maxConcurrency: 2,        // Max parallel enrichment operations
  queueIntervalMs: 3000,    // Min interval between queue dispatches
  lastDispatchTime: 0,
};

/**
 * Acquires an enrichment slot. Resolves when a slot is available.
 * @returns {Promise<void>}
 */
async function _acquireEnrichmentSlot() {
  while (_enrichmentState.activeConcurrency >= _enrichmentState.maxConcurrency) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  // Enforce min interval between dispatches
  const now = Date.now();
  const timeSinceLast = now - _enrichmentState.lastDispatchTime;
  if (timeSinceLast < _enrichmentState.queueIntervalMs) {
    await new Promise(resolve => setTimeout(resolve, _enrichmentState.queueIntervalMs - timeSinceLast));
  }
  _enrichmentState.activeConcurrency++;
  _enrichmentState.lastDispatchTime = Date.now();
}

function _releaseEnrichmentSlot() {
  _enrichmentState.activeConcurrency = Math.max(0, _enrichmentState.activeConcurrency - 1);
}

async function enrichSkillFromExternalKnowledge(orch, skillName, opts = {}) {
  const { maxSearchResults = 5, maxFetchPages = 3, dryRun = false } = opts;
  const startTime = Date.now();

  // P2: Acquire concurrency slot before proceeding
  await _acquireEnrichmentSlot();

  try {
    // ── 1. Validate: skill must exist in registry ────────────────────────
    if (!orch.services || !orch.services.has('skillEvolution')) {
      return { success: false, sectionsAdded: 0, sources: [], error: 'SkillEvolutionEngine not available' };
    }
    const skillEvolution = orch.services.resolve('skillEvolution');
    const meta = skillEvolution.registry.get(skillName);
    if (!meta) {
      return { success: false, sectionsAdded: 0, sources: [], error: `Skill "${skillName}" not found in registry` };
    }

    console.log(`[SkillEnrich] 🌐 Starting external knowledge enrichment for skill: ${skillName}`);
    console.log(`[SkillEnrich]    Domains: [${(meta.domains || []).join(', ')}]`);
    console.log(`[SkillEnrich]    Keywords: [${((meta.triggers && meta.triggers.keywords) || []).join(', ')}]`);

    // ── 2. Construct multi-dimensional search queries ────────────────────
    // FIX(Defect #2): Expand from 2 queries to 4-5 dimensions for broader coverage.
    // Each query targets a different knowledge dimension to maximize information density.
    const domains = (meta.domains || []).join(' ');
    const keywords = ((meta.triggers && meta.triggers.keywords) || []).join(' ');
    const desc = meta.description || '';
    const queries = [
      // Dimension 1: Core rules and anti-patterns
      `${domains} ${keywords} best practices common pitfalls anti-patterns 2025 2026`.trim(),
      // Dimension 2: Environment-specific gotchas
      `${desc} gotchas environment specific issues version compatibility`.trim(),
      // Dimension 3: Step-by-step workflows / SOPs
      `${domains} ${keywords} step by step workflow checklist standard operating procedure`.trim(),
      // Dimension 4: Security and performance concerns
      `${domains} ${keywords} security vulnerabilities performance optimization tips`.trim(),
      // Dimension 5: Real-world case studies and debugging
      `${domains} ${keywords} production issues debugging lessons learned case study`.trim(),
    ].filter(q => q.length > 10).map(q => q.slice(0, 200));

    if (queries.length === 0) {
      return { success: false, sectionsAdded: 0, sources: [], error: 'Cannot construct search queries (no domains/keywords)' };
    }

    // ── 3. Search: run all queries in parallel ───────────────────────────
    // FIX(Defect #2): Run up to 5 queries (was 2) for broader knowledge coverage.
    const searchResults = [];
    const searchPromises = queries.slice(0, 5).map(q =>
      webSearchHelper(orch, q, { maxResults: maxSearchResults, label: `SkillEnrich(${skillName})` })
    );
    const rawResults = await Promise.all(searchPromises);
    for (const r of rawResults) {
      if (r && r.results) searchResults.push(...r.results);
    }

    // Deduplicate by URL
    const seen = new Set();
    const uniqueResults = searchResults.filter(r => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    });

    if (uniqueResults.length === 0) {
      console.log(`[SkillEnrich] ⚠️  No search results found for ${skillName}`);
      return { success: false, sectionsAdded: 0, sources: [], error: 'No search results found' };
    }
    console.log(`[SkillEnrich] 📊 Found ${uniqueResults.length} unique results, fetching top ${maxFetchPages} pages...`);

    // ── 4. Deep fetch: get full content from top pages ───────────────────
    const pagesToFetch = uniqueResults.slice(0, maxFetchPages);
    let wsAdapter = null;
    try {
      const registry = orch.services.resolve('mcpRegistry');
      wsAdapter = registry.get('websearch');
    } catch (_) { /* no adapter */ }

    let fetchedContent = '';
    const sources = [];
    if (wsAdapter && wsAdapter.fetchPage) {
      const fetchPromises = pagesToFetch.map(r =>
        wsAdapter.fetchPage(r.url, { maxLength: 6000 }).catch(() => ({ url: r.url, content: '' }))
      );
      const pages = await Promise.all(fetchPromises);
      for (const page of pages) {
        if (page.content && page.content.length > 100) {
          fetchedContent += `\n\n--- Source: ${page.url} ---\n${page.content}`;
          sources.push(page.url);
        }
      }
    }

    // Fallback: use snippets if no full pages fetched
    if (!fetchedContent) {
      fetchedContent = uniqueResults.map(r =>
        `--- Source: ${r.url} ---\n${r.snippet || ''}`
      ).join('\n\n');
      sources.push(...uniqueResults.map(r => r.url));
    }

    if (fetchedContent.length < 200) {
      console.log(`[SkillEnrich] ⚠️  Fetched content too short (${fetchedContent.length} chars)`);
      return { success: false, sectionsAdded: 0, sources, error: 'Fetched content too short for meaningful analysis' };
    }
    console.log(`[SkillEnrich] 📄 Total fetched content: ${fetchedContent.length} chars from ${sources.length} source(s)`);

    // ── 5. LLM Analysis: extract structured knowledge ───────────────────
    const analysisPrompt = _buildEnrichmentAnalysisPrompt(skillName, meta, fetchedContent);
    let analysisResult = null;

    if (orch._rawLlmCall) {
      const llmResponse = await orch._rawLlmCall(analysisPrompt, 'enrichment-analyst');
      analysisResult = _parseEnrichmentResponse(llmResponse);
    } else if (orch.llmCall) {
      const llmResponse = await orch.llmCall(analysisPrompt, 'enrichment-analyst');
      analysisResult = _parseEnrichmentResponse(llmResponse);
    }

    if (!analysisResult) {
      return { success: false, sectionsAdded: 0, sources, error: 'LLM analysis failed to produce structured output' };
    }

    // ── 5b. FIX(Defect #5): Gap Analysis + Second Pass ──────────────────
    // After the first LLM pass, check which sections are still thin (< 3 entries).
    // If thin sections exist AND we have unused search results, run a focused second
    // pass targeting only the thin sections. This dramatically improves coverage for
    // complex skills where a single prompt can't cover all dimensions adequately.
    const thinSections = _identifyThinSections(analysisResult);
    if (thinSections.length > 0 && uniqueResults.length > maxFetchPages) {
      console.log(`[SkillEnrich] 🔄 Gap analysis: ${thinSections.join(', ')} are thin. Running second pass...`);

      // Fetch additional pages from unused search results
      const unusedResults = uniqueResults.slice(maxFetchPages, maxFetchPages + 2);
      let additionalContent = '';
      if (wsAdapter && wsAdapter.fetchPage) {
        const addlFetchPromises = unusedResults.map(r =>
          wsAdapter.fetchPage(r.url, { maxLength: 6000 }).catch(() => ({ url: r.url, content: '' }))
        );
        const addlPages = await Promise.all(addlFetchPromises);
        for (const page of addlPages) {
          if (page.content && page.content.length > 100) {
            additionalContent += `\n\n--- Source: ${page.url} ---\n${page.content}`;
            sources.push(page.url);
          }
        }
      }

      // Build focused second-pass prompt targeting only thin sections
      const secondPassPrompt = _buildSecondPassPrompt(skillName, meta, thinSections, additionalContent || fetchedContent);
      let secondPassResult = null;
      if (orch._rawLlmCall) {
        const llmResponse2 = await orch._rawLlmCall(secondPassPrompt, 'enrichment-analyst');
        secondPassResult = _parseEnrichmentResponse(llmResponse2);
      } else if (orch.llmCall) {
        const llmResponse2 = await orch.llmCall(secondPassPrompt, 'enrichment-analyst');
        secondPassResult = _parseEnrichmentResponse(llmResponse2);
      }

      // Merge second pass results into first pass
      if (secondPassResult) {
        _mergeEnrichmentResults(analysisResult, secondPassResult);
        console.log(`[SkillEnrich] ✅ Second pass complete. Total entries: ${_countEntries(analysisResult)}`);
      }
    }

    // ── 6. Evolve: inject extracted knowledge into skill sections ────────
    if (dryRun) {
      console.log(`[SkillEnrich] 🏷️  Dry run: would add ${_countEntries(analysisResult)} entries to ${skillName}`);
      return { success: true, sectionsAdded: _countEntries(analysisResult), sources, dryRun: true, analysisResult };
    }

    let sectionsAdded = 0;
    // P3: Determine knowledge source type for provenance tracking
    const sourceType = sources.length > 0 ? 'external-search' : 'ai-generated';
    // FIX(Defect #3): Include SOP and Checklist in section mapping.
    // Previously these two sections were completely omitted from enrichment,
    // leaving them permanently empty for all auto-generated Skills.
    const sectionMap = [
      { key: 'rules', section: 'Rules' },
      { key: 'sop', section: 'SOP (Standard Operating Procedure)' },
      { key: 'checklist', section: 'Checklist' },
      { key: 'antiPatterns', section: 'Anti-Patterns' },
      { key: 'gotchas', section: 'Gotchas' },
      { key: 'bestPractices', section: 'Best Practices' },
      { key: 'contextHints', section: 'Context Hints' },
    ];

    for (const { key, section } of sectionMap) {
      const entries = analysisResult[key];
      if (!entries || !Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!entry.title || !entry.content) continue;
        // P3: Annotate content with source type for provenance tracking
        const annotatedContent = `${entry.content}\n> _Source: ${sourceType}${sources[0] ? ` | ${sources[0]}` : ''}_`;
        const ok = skillEvolution.evolve(skillName, {
          section,
          title: entry.title,
          content: annotatedContent,
          sourceExpId: `external-enrich-${sourceType}-${Date.now()}`,
          reason: `External knowledge enrichment (${sourceType}) from ${sources.length > 0 ? sources[0] : 'LLM internal knowledge'}`,
        });
        if (ok) sectionsAdded++;
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[SkillEnrich] ✅ Enriched skill "${skillName}": ${sectionsAdded} entries added from ${sources.length} source(s) [${sourceType}] in ${elapsed}s`);
    // P2: Release concurrency slot
    _releaseEnrichmentSlot();
    return { success: true, sectionsAdded, sources, sourceType };

  } catch (err) {
    // P2: Release concurrency slot on error
    _releaseEnrichmentSlot();
    console.warn(`[SkillEnrich] ❌ Enrichment failed for "${skillName}": ${err.message}`);
    return { success: false, sectionsAdded: 0, sources: [], error: err.message };
  }
}

/**
 * Builds the LLM prompt for analysing fetched web content and extracting
 * structured skill knowledge.
 *
 * FIX(Defect #1): Removed "Maximum 5 entries" hard limit → dynamic 3-8 range.
 * FIX(Defect #3): Added SOP and Checklist to output format.
 * FIX(Defect #4): Changed from "1-3 sentence" to richer content depth guidance.
 */
function _buildEnrichmentAnalysisPrompt(skillName, meta, fetchedContent) {
  const domains = (meta.domains || []).join(', ') || 'general';
  const skillType = meta.type || 'domain-skill';
  const keywords = ((meta.triggers && meta.triggers.keywords) || []).join(', ');
  return [
    `You are a senior software engineering knowledge curator with deep expertise in ${domains}.`,
    `Your job is to distil raw web content into a structured, actionable skill document.`,
    ``,
    `## Context`,
    `- Skill name: "${skillName}"`,
    `- Skill type: ${skillType}`,
    `- Domains: ${domains}`,
    `- Keywords: ${keywords || 'N/A'}`,
    `- Description: ${meta.description || 'N/A'}`,
    ``,
    `## Pre-Analysis Thinking (follow this sequence before writing output)`,
    `1. What are the TOP 3 most impactful things a developer needs to know about ${skillName}?`,
    `2. What mistakes do developers MOST COMMONLY make in this domain?`,
    `3. What environment/version/platform-specific traps exist (NOT general anti-patterns)?`,
    `4. What actionable rules can I extract that a developer can follow WITHOUT additional context?`,
    `5. What is the standard step-by-step workflow (SOP) for this domain? What phases does it have?`,
    `6. What verification checklist should be run AFTER completing work in this domain?`,
    `7. Is there any content that is SPECIFIC ENOUGH to be useful? (Discard vague platitudes.)`,
    ``,
    `## Output Format`,
    `Return ONLY a JSON object (no markdown fences, no explanation) with these 7 fields:`,
    `{`,
    `  "rules": [{ "title": "<imperative rule name>", "content": "<2-5 sentence prescriptive rule with context and rationale>" }],`,
    `  "sop": [{ "title": "<Phase N: phase name, e.g. 'Phase 1: Requirements Validation'>", "content": "<Multi-sentence description of this phase: entry criteria, key actions, exit criteria, common mistakes to avoid in this phase>" }],`,
    `  "checklist": [{ "title": "<Checklist group name, e.g. 'Correctness'>", "content": "<3-6 checkbox items as a markdown list: '- [ ] Item 1\\n- [ ] Item 2\\n- [ ] Item 3'>" }],`,
    `  "antiPatterns": [{ "title": "<pattern name>", "content": "<❌ What NOT to do → ✅ What to do instead. 2-4 sentences with concrete code pattern if applicable.>" }],`,
    `  "gotchas": [{ "title": "<gotcha name>", "content": "<Environment/version/platform-SPECIFIC trap. 2-4 sentences. MUST mention the specific version, platform, or environment.>" }],`,
    `  "bestPractices": [{ "title": "<practice name>", "content": "<What TO do and WHY. 2-5 sentences including measurable benefit if possible.>" }],`,
    `  "contextHints": [{ "title": "<hint name>", "content": "<Background context. 2-4 sentences about known limitations, historical reasons, undocumented behaviors.>" }]`,
    `}`,
    ``,
    `## Content Depth Requirements`,
    `Each entry's "content" field should be SUBSTANTIAL (not a one-liner):`,
    `- rules: 2-5 sentences. State the rule, explain WHY it matters, and give a concrete example of compliance.`,
    `- sop: 3-6 sentences per phase. Include entry criteria, key actions, tools/commands to use, and exit criteria.`,
    `- checklist: 3-6 checkbox items per group. Each item must be a yes/no verifiable assertion.`,
    `- antiPatterns: 2-4 sentences. Describe the wrong approach, explain the consequence, show the correct alternative.`,
    `- gotchas: 2-4 sentences. Describe the trap, the specific environment it applies to, and the workaround.`,
    `- bestPractices: 2-5 sentences. Describe the practice, explain the benefit with numbers if possible, note caveats.`,
    `- contextHints: 2-4 sentences. Provide background that aids decision-making without being prescriptive.`,
    ``,
    `## Section-Specific Quality Rules`,
    ``,
    `### rules (highest authority — aim for 5-8 entries)`,
    `- Written as IMPERATIVES: "Always X", "Never Y", "Before Z, ensure W"`,
    `- Each rule must be INDEPENDENTLY VERIFIABLE (a code reviewer can check compliance)`,
    `- Rules OVERRIDE best practices when in conflict`,
    `- Bad example: "Write clean code" (too vague, not verifiable)`,
    `- Good example: "All public functions must have JSDoc with @param and @returns — this enables IDE autocomplete for consumers and catches type mismatches during review" (specific, verifiable, explains why)`,
    ``,
    `### sop (step-by-step workflow — aim for 3-6 phases)`,
    `- Each phase must have a clear NAME, ENTRY CRITERIA, KEY ACTIONS, and EXIT CRITERIA`,
    `- Phases should be sequential: the output of Phase N is the input of Phase N+1`,
    `- An agent following this SOP should produce consistent output regardless of the specific project`,
    `- Bad example: "First, understand the requirements" (too vague, no exit criteria)`,
    `- Good example: "Phase 1: Requirements Validation — Entry: raw requirements text. Actions: (1) identify ambiguous terms, (2) list assumptions, (3) confirm with stakeholder. Exit: requirements doc with no TBD items and stakeholder sign-off."`,
    ``,
    `### checklist (verification — aim for 3-5 groups, 3-6 items each)`,
    `- Group by CONCERN: Correctness, Security, Performance, Maintainability, Documentation`,
    `- Each item must be a YES/NO verifiable assertion (not an instruction)`,
    `- Use checkbox markdown format: "- [ ] All error paths return proper HTTP status codes"`,
    `- Bad example: "- [ ] Code is good" (not verifiable)`,
    `- Good example: "- [ ] All database queries use parameterized statements (no string concatenation)"`,
    ``,
    `### antiPatterns (what NOT to do — aim for 4-7 entries)`,
    `- MUST include a concrete "instead" alternative (not just "don't do X")`,
    `- Use the ❌/✅ format: "❌ [wrong approach] → ✅ [correct approach]"`,
    `- Include code-level patterns when possible`,
    `- Bad example: "Don't write bad queries" (no alternative given)`,
    `- Good example: "❌ SELECT * FROM users → ✅ SELECT id, name, email FROM users — reduces data transfer by 60-80%, prevents accidental PII exposure in logs, and makes query plans more efficient"`,
    ``,
    `### gotchas (environment-specific traps — aim for 3-5 entries)`,
    `- MUST mention a SPECIFIC version, platform, OS, or runtime (not general advice)`,
    `- If you cannot cite a specific environment, this is an anti-pattern, not a gotcha`,
    `- Bad example: "Be careful with async code" (not environment-specific)`,
    `- Good example: "In Python 3.10+, match/case statements don't support guard clauses the same way as Rust — use if/elif chains for complex matching. This was a deliberate design choice (PEP 634) and is unlikely to change."`,
    ``,
    `### bestPractices (recommended patterns — aim for 5-8 entries)`,
    `- Must explain BOTH the "what" AND the "why" (benefit)`,
    `- Include measurable impact when possible ("reduces latency by ~30%", "prevents N+1 queries")`,
    `- Bad example: "Use caching" (no context)`,
    `- Good example: "Cache database query results with a 5-minute TTL for read-heavy endpoints — this typically reduces p95 latency by 40-60% while keeping data freshness acceptable. Use cache-aside pattern with Redis for multi-instance deployments."`,
    ``,
    `### contextHints (background knowledge — aim for 3-5 entries)`,
    `- NOT rules or practices — just useful context for future debugging`,
    `- Include "known limitations", "historical reasons for design choices", "undocumented behaviors"`,
    `- Bad example: "React is a UI library" (too basic)`,
    `- Good example: "React's useEffect cleanup runs BEFORE the next effect, not on unmount — this matters for subscription-based patterns where cleanup timing affects data consistency. This behavior is documented but commonly misunderstood."`,
    ``,
    `## Global Quality Gates (entries that fail these are REJECTED)`,
    `- ❌ REJECT entries that are vague platitudes ("write clean code", "follow best practices")`,
    `- ❌ REJECT entries that require additional context to be actionable ("be careful with X")`,
    `- ❌ REJECT entries that duplicate information across sections`,
    `- ❌ REJECT gotchas that don't mention a specific version/platform/environment`,
    `- ❌ REJECT one-liner content — each entry must have substantial depth (see Content Depth Requirements)`,
    `- ✅ ACCEPT only entries where a developer can ACT on the information immediately`,
    `- Aim for 3-8 entries per section (adapt based on available source material)`,
    `- If a section has no relevant HIGH-QUALITY content, use an empty array [] (better than filler)`,
    ``,
    `## Source Content`,
    ``,
    fetchedContent.slice(0, 20000), // Increased from 15K to 20K to support richer analysis
  ].join('\n');
}

/**
 * Parses the LLM response from enrichment analysis.
 * Handles both raw JSON and markdown-fenced JSON.
 */
function _parseEnrichmentResponse(response) {
  if (!response || typeof response !== 'string') return null;
  try {
    // Strip markdown fences if present
    let cleaned = response.trim();
    if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
    else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
    if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
    cleaned = cleaned.trim();

    // Find JSON object boundaries
    const startIdx = cleaned.indexOf('{');
    const endIdx = cleaned.lastIndexOf('}');
    if (startIdx === -1 || endIdx === -1) return null;
    cleaned = cleaned.slice(startIdx, endIdx + 1);

    const parsed = JSON.parse(cleaned);
    // Validate structure
    if (typeof parsed !== 'object') return null;
    return parsed;
  } catch (err) {
    console.warn(`[SkillEnrich] ⚠️  Failed to parse LLM response: ${err.message}`);
    return null;
  }
}

/**
 * Counts total entries across all sections in an analysis result.
 */
function _countEntries(result) {
  let count = 0;
  // FIX(Defect #3): Count SOP and Checklist entries too
  for (const key of ['rules', 'sop', 'checklist', 'antiPatterns', 'gotchas', 'bestPractices', 'contextHints']) {
    if (result[key] && Array.isArray(result[key])) count += result[key].length;
  }
  return count;
}

/**
 * FIX(Defect #5): Identifies which sections from the first pass are "thin" (< 3 entries)
 * and would benefit from a focused second pass.
 * @param {object} result - First pass LLM analysis result
 * @returns {string[]} - List of thin section keys
 */
function _identifyThinSections(result) {
  const expectedSections = {
    rules: 3,          // Expect at least 3 rules
    sop: 2,            // Expect at least 2 SOP phases
    checklist: 2,      // Expect at least 2 checklist groups
    antiPatterns: 3,   // Expect at least 3 anti-patterns
    gotchas: 2,        // Gotchas are harder to find, lower threshold
    bestPractices: 3,  // Expect at least 3 best practices
    contextHints: 2,   // Context hints are supplementary, lower threshold
  };

  const thin = [];
  for (const [key, minCount] of Object.entries(expectedSections)) {
    const entries = result[key];
    if (!entries || !Array.isArray(entries) || entries.length < minCount) {
      thin.push(key);
    }
  }
  return thin;
}

/**
 * FIX(Defect #5): Builds a focused second-pass prompt that targets only thin sections.
 * This is more efficient than re-running the full prompt because:
 * 1. It tells the LLM exactly which sections need more content
 * 2. It can use additional source material from unused search results
 * 3. It doesn't waste tokens re-generating sections that are already adequate
 */
function _buildSecondPassPrompt(skillName, meta, thinSections, sourceContent) {
  const domains = (meta.domains || []).join(', ') || 'general';

  // Build section-specific guidance for each thin section
  const sectionGuidance = {
    rules: 'Generate 3-5 additional prescriptive rules (imperative format: "Always X", "Never Y"). Each 2-5 sentences with rationale.',
    sop: 'Generate a 3-6 phase step-by-step SOP workflow. Each phase: name, entry criteria, key actions, exit criteria. 3-6 sentences per phase.',
    checklist: 'Generate 3-5 checklist groups (Correctness, Security, Performance, etc.). Each group: 3-6 checkbox items in "- [ ] Item" format.',
    antiPatterns: 'Generate 3-5 anti-patterns in "❌ Wrong → ✅ Correct" format. Each 2-4 sentences with concrete code patterns.',
    gotchas: 'Generate 3-5 environment/version/platform-SPECIFIC gotchas. Each MUST mention a specific version or platform. 2-4 sentences each.',
    bestPractices: 'Generate 3-5 best practices with measurable benefits. Each 2-5 sentences explaining what, why, and impact.',
    contextHints: 'Generate 3-5 background context hints about known limitations, historical reasons, or undocumented behaviors. 2-4 sentences each.',
  };

  const targetGuidance = thinSections.map(key =>
    `### ${key}\n${sectionGuidance[key] || 'Generate 3-5 entries.'}`
  ).join('\n\n');

  return [
    `You are a senior software engineering knowledge curator with deep expertise in ${domains}.`,
    `This is a FOCUSED SECOND PASS. The first analysis pass produced insufficient content for certain sections.`,
    ``,
    `## Context`,
    `- Skill: "${skillName}" (${meta.description || 'N/A'})`,
    `- Domains: ${domains}`,
    ``,
    `## Task`,
    `Generate content ONLY for these thin sections: [${thinSections.join(', ')}]`,
    `Do NOT generate content for sections not listed above.`,
    ``,
    `## Section Requirements`,
    ``,
    targetGuidance,
    ``,
    `## Output Format`,
    `Return ONLY a JSON object with the requested section keys. Example:`,
    `{`,
    thinSections.map(key =>
      `  "${key}": [{ "title": "...", "content": "..." }]`
    ).join(',\n'),
    `}`,
    ``,
    `## Quality Rules (same as first pass)`,
    `- ❌ REJECT vague platitudes`,
    `- ❌ REJECT entries requiring additional context to be actionable`,
    `- ✅ Each entry must be immediately actionable by a developer`,
    `- Content depth: 2-5 sentences per entry (no one-liners)`,
    ``,
    `## Source Content`,
    ``,
    sourceContent.slice(0, 20000),
  ].join('\n');
}

/**
 * FIX(Defect #5): Merges second-pass results into the first-pass result.
 * Only adds entries for sections that were thin in the first pass.
 * Avoids duplicate titles via case-insensitive comparison.
 */
function _mergeEnrichmentResults(target, source) {
  for (const key of ['rules', 'sop', 'checklist', 'antiPatterns', 'gotchas', 'bestPractices', 'contextHints']) {
    const sourceEntries = source[key];
    if (!sourceEntries || !Array.isArray(sourceEntries)) continue;

    if (!target[key]) target[key] = [];

    // Build set of existing titles for dedup
    const existingTitles = new Set(
      target[key].map(e => (e.title || '').toLowerCase().trim())
    );

    for (const entry of sourceEntries) {
      if (!entry.title || !entry.content) continue;
      const normalizedTitle = entry.title.toLowerCase().trim();
      if (existingTitles.has(normalizedTitle)) continue; // Skip duplicates
      target[key].push(entry);
      existingTitles.add(normalizedTitle);
    }
  }
}

// ─── P1: Experience Store Cold-Start Preheating ─────────────────────────────

/**
 * Preheats the ExperienceStore for a new project by searching external knowledge
 * sources for common experiences (pitfalls, best practices, stable patterns) relevant
 * to the project's detected tech stack, then injecting them as seed experiences.
 *
 * This solves the "empty experience store" cold-start problem: a new project starts
 * with zero experiences, so getContextBlock() returns nothing useful until the first
 * few workflow runs accumulate real experiences. Preheating fills the gap.
 *
 * Trigger: Called once during Orchestrator._initWorkflow() when the experience store
 * is empty (0 entries) and web search is available.
 *
 * @param {Orchestrator} orch - Orchestrator instance
 * @param {object} [opts]
 * @param {number} [opts.maxResults=5]    - Max web search results per query
 * @param {string[]} [opts.techStack=[]]  - Detected tech stack terms
 * @param {string} [opts.projectType='']  - Detected project type (e.g. 'frontend', 'backend')
 * @returns {Promise<{success: boolean, seeded: number, error?: string}>}
 */
async function preheatExperienceStore(orch, opts = {}) {
  const { maxResults = 5, techStack = [], projectType = '' } = opts;
  const startTime = Date.now();

  try {
    if (!orch.experienceStore) {
      return { success: false, seeded: 0, error: 'ExperienceStore not available' };
    }

    // Only preheat if the store is empty or nearly empty (< 3 entries)
    const stats = orch.experienceStore.getStats();
    if (stats.total >= 3) {
      console.log(`[ExpPreheat] ℹ️  Experience store already has ${stats.total} entries. Skipping preheat.`);
      return { success: true, seeded: 0 };
    }

    console.log(`[ExpPreheat] 🌱 Starting experience store cold-start preheating...`);
    console.log(`[ExpPreheat]    Tech stack: [${techStack.join(', ')}]`);
    console.log(`[ExpPreheat]    Project type: ${projectType || 'general'}`);

    // FIX(Defect #1): Construct multi-dimensional search queries (was 2-3, now 4-5)
    // Mirrors the 5-dimension strategy from enrichSkillFromExternalKnowledge
    const queries = [];
    if (techStack.length > 0) {
      const techTerms = techStack.slice(0, 4).join(' ');
      // Dimension 1: Common pitfalls and gotchas
      queries.push(`${techTerms} common pitfalls gotchas mistakes developers make 2025 2026`);
      // Dimension 2: Best practices and stable patterns
      queries.push(`${techTerms} best practices stable patterns production tips`);
      // Dimension 3: Performance and debugging
      queries.push(`${techTerms} performance optimization debugging lessons learned production`);
      // Dimension 4: Security concerns
      queries.push(`${techTerms} security vulnerabilities common attacks prevention`);
    }
    if (projectType) {
      // Dimension 5: Project-type-specific patterns
      queries.push(`${projectType} development common anti-patterns pitfalls architecture mistakes`);
    }
    // Always include a general software engineering query as fallback
    if (queries.length === 0) {
      queries.push('software development common pitfalls anti-patterns best practices 2025');
    }

    // FIX(Defect #1): Search up to 5 queries in parallel (was 3)
    const allResults = [];
    const searchPromises = queries.slice(0, 5).map(q =>
      webSearchHelper(orch, q, { maxResults, label: 'ExpPreheat' })
    );
    const rawResults = await Promise.all(searchPromises);
    for (const r of rawResults) {
      if (r && r.results) allResults.push(...r.results);
    }

    // Deduplicate by URL
    const seen = new Set();
    const uniqueResults = allResults.filter(r => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    });

    if (uniqueResults.length === 0) {
      console.log(`[ExpPreheat] ⚠️  No search results found. Cannot preheat.`);
      return { success: false, seeded: 0, error: 'No search results' };
    }

    console.log(`[ExpPreheat] 📊 Found ${uniqueResults.length} unique results. Deep-fetching top pages...`);

    // FIX(Defect #1): Deep-fetch top pages for richer content (was snippet-only)
    // Mirrors the deep-fetch strategy from enrichSkillFromExternalKnowledge
    const maxFetchPages = 3;
    const pagesToFetch = uniqueResults.slice(0, maxFetchPages);
    let wsAdapter = null;
    try {
      const registry = orch.services.resolve('mcpRegistry');
      wsAdapter = registry.get('websearch');
    } catch (_) { /* no adapter */ }

    let fetchedContent = '';
    const sources = [];
    if (wsAdapter && wsAdapter.fetchPage) {
      const fetchPromises = pagesToFetch.map(r =>
        wsAdapter.fetchPage(r.url, { maxLength: 6000 }).catch(() => ({ url: r.url, content: '' }))
      );
      const pages = await Promise.all(fetchPromises);
      for (const page of pages) {
        if (page.content && page.content.length > 100) {
          fetchedContent += `\n\n--- Source: ${page.url} ---\n${page.content}`;
          sources.push(page.url);
        }
      }
    }

    // Fallback: use snippets if deep-fetch unavailable (but with more content than before)
    if (!fetchedContent) {
      fetchedContent = uniqueResults.slice(0, 8).map(r =>
        `--- Source: ${r.url} ---\n${r.title}\n${(r.snippet || '').slice(0, 500)}`
      ).join('\n\n');
      sources.push(...uniqueResults.slice(0, 8).map(r => r.url));
    }

    console.log(`[ExpPreheat] 📄 Fetched content: ${fetchedContent.length} chars from ${sources.length} source(s)`);

    // FIX(Defect #1): Significantly enhanced prompt with content depth requirements,
    // quality gates, and examples — mirrors the quality standards from enrichment prompts
    const analysisPrompt = [
      `You are a senior software engineer with deep production experience. Analyse the source`,
      `content below and extract actionable experiences for a developer working on a`,
      `${projectType || 'software'} project${techStack.length > 0 ? ` using ${techStack.join(', ')}` : ''}.`,
      ``,
      `## Output Format`,
      `Return ONLY a JSON array (no markdown fences, no explanation):`,
      `[`,
      `  {`,
      `    "type": "positive" | "negative",`,
      `    "category": "pitfall" | "stable_pattern" | "performance" | "framework_limit" | "debug_technique" | "security",`,
      `    "title": "<concise imperative title, e.g. 'Always use parameterized queries in SQL'>",`,
      `    "content": "<4-6 sentence SUBSTANTIAL description (see Content Depth below)>",`,
      `    "tags": ["<relevant", "keywords"]`,
      `  }`,
      `]`,
      ``,
      `## Content Depth Requirements`,
      `Each experience's "content" field MUST be 4-6 sentences and include ALL of:`,
      `1. **What**: The specific situation, pattern, or problem`,
      `2. **Why**: Why it matters (consequence of ignoring / benefit of following)`,
      `3. **How**: Concrete action to take or avoid (with code pattern if applicable)`,
      `4. **Context**: When this applies (specific versions, environments, scale thresholds)`,
      ``,
      `## Quality Gates (entries that fail these are REJECTED)`,
      `- ❌ REJECT vague platitudes: "Write clean code", "Follow best practices"`,
      `- ❌ REJECT entries without concrete actions: "Be careful with X"`,
      `- ❌ REJECT one-liner or two-liner content — MINIMUM 4 sentences`,
      `- ✅ ACCEPT only entries where a developer can ACT immediately`,
      ``,
      `## Examples`,
      ``,
      `### ✅ Good Entry (follows all rules):`,
      `{`,
      `  "type": "negative",`,
      `  "category": "pitfall",`,
      `  "title": "Never use string concatenation for SQL queries",`,
      `  "content": "String-concatenated SQL queries are vulnerable to SQL injection attacks, which remain the #1 web application vulnerability (OWASP Top 10). Even in internal tools, an attacker who gains limited access can escalate privileges through injection. Always use parameterized queries or prepared statements: db.query('SELECT * FROM users WHERE id = ?', [userId]) instead of db.query('SELECT * FROM users WHERE id = ' + userId). ORMs like Sequelize and TypeORM handle this automatically, but raw query escape hatches still need manual parameterization.",`,
      `  "tags": ["sql", "security", "injection", "database"]`,
      `}`,
      ``,
      `### ❌ Bad Entry (too vague, no depth):`,
      `{`,
      `  "type": "negative",`,
      `  "category": "pitfall",`,
      `  "title": "Be careful with SQL",`,
      `  "content": "SQL injection is a common problem. Use parameterized queries.",`,
      `  "tags": ["sql"]`,
      `}`,
      ``,
      `## Generation Rules`,
      `- Generate 8-12 experiences (mix of positive and negative, at least 3 of each)`,
      `- Include at least 1 entry per category that is relevant to the tech stack`,
      `- Pitfalls: describe what goes wrong, the specific consequence, and the exact fix`,
      `- Stable patterns: describe the pattern, WHY it's stable, measured/estimated benefit`,
      `- Performance: include specific thresholds or benchmarks when possible`,
      `- Security: cite specific vulnerability types (CWE/OWASP when applicable)`,
      `- Tags should include technology names, versions, and relevant concepts`,
      ``,
      `## Source Content`,
      fetchedContent.slice(0, 20000),
    ].join('\n');

    let experiences = null;
    if (orch._rawLlmCall) {
      const llmResponse = await orch._rawLlmCall(analysisPrompt);
      experiences = _parsePreheatResponse(llmResponse);
    }

    if (!experiences || experiences.length === 0) {
      console.log(`[ExpPreheat] ⚠️  LLM analysis did not produce valid experiences.`);
      return { success: false, seeded: 0, error: 'LLM analysis produced no experiences' };
    }

    // Inject experiences into the store
    const { ExperienceType, ExperienceCategory } = require('./experience-store');
    let seeded = 0;
    for (const exp of experiences) {
      try {
        const type = exp.type === 'positive' ? ExperienceType.POSITIVE : ExperienceType.NEGATIVE;
        const categoryMap = {
          'pitfall': ExperienceCategory.PITFALL,
          'stable_pattern': ExperienceCategory.STABLE_PATTERN,
          'performance': ExperienceCategory.PERFORMANCE,
          'framework_limit': ExperienceCategory.FRAMEWORK_LIMIT,
          'debug_technique': ExperienceCategory.DEBUG_TECHNIQUE,
        };
        const category = categoryMap[exp.category] || ExperienceCategory.STABLE_PATTERN;

        orch.experienceStore.record({
          type,
          category,
          title: exp.title,
          content: `${exp.content}\n> _Source: cold-start-preheat (external-search)_`,
          tags: exp.tags || [],
          ttlDays: type === ExperienceType.NEGATIVE ? 90 : 180, // Shorter TTL for seeded experiences
        });
        seeded++;
      } catch (recErr) {
        console.warn(`[ExpPreheat] ⚠️  Failed to record experience "${exp.title}": ${recErr.message}`);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[ExpPreheat] ✅ Experience store preheated: ${seeded} seed experiences injected in ${elapsed}s`);
    return { success: true, seeded };

  } catch (err) {
    console.warn(`[ExpPreheat] ❌ Preheating failed: ${err.message}`);
    return { success: false, seeded: 0, error: err.message };
  }
}

/**
 * Parses the LLM response for experience preheating.
 * Handles both raw JSON arrays and markdown-fenced JSON.
 */
function _parsePreheatResponse(response) {
  if (!response || typeof response !== 'string') return null;
  try {
    let cleaned = response.trim();
    // Strip markdown fences
    if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
    else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
    if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
    cleaned = cleaned.trim();

    // Find JSON array boundaries
    const startIdx = cleaned.indexOf('[');
    const endIdx = cleaned.lastIndexOf(']');
    if (startIdx === -1 || endIdx === -1) return null;
    cleaned = cleaned.slice(startIdx, endIdx + 1);

    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return null;

    // Validate each entry
    // FIX(Defect #1): Increased cap from 10 to 15 to match expanded generation target
    return parsed.filter(e =>
      e && typeof e === 'object' &&
      e.title && typeof e.title === 'string' &&
      e.content && typeof e.content === 'string' &&
      (e.type === 'positive' || e.type === 'negative')
    ).slice(0, 15);
  } catch (err) {
    console.warn(`[ExpPreheat] ⚠️  Failed to parse LLM response: ${err.message}`);
    return null;
  }
}


module.exports = {
  enrichSkillFromExternalKnowledge,
  preheatExperienceStore,
};
