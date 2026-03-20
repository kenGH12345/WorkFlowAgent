/**
 * Batch inject PURPOSE comments into existing Skill .md files.
 *
 * P1: Add <!-- PURPOSE: ... --> below every ## heading that lacks one.
 * P2: Generate a "thinness report" showing which Skills need enrichment.
 *
 * Usage: node workflow/scripts/batch-inject-purpose.js [--dry-run]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SKILLS_DIR = path.resolve(__dirname, '..', 'skills');
const DRY_RUN = process.argv.includes('--dry-run');

// ─── PURPOSE definitions for STANDARD 5-section skills ──────────────────────
const STANDARD_PURPOSES = {
  '## Rules': `<!-- PURPOSE: Prescriptive constraints that MUST be followed. Written as imperatives ("Always X", "Never Y"). Each rule should be independently verifiable. Rules are the highest-authority content in a skill — they override best practices when in conflict. -->`,
  '## SOP (Standard Operating Procedure)': `<!-- PURPOSE: Step-by-step workflow for the skill's domain. Numbered phases with clear entry/exit criteria. An agent following this SOP should produce consistent, high-quality output regardless of the specific project. -->`,
  '## Checklist': `<!-- PURPOSE: A verification checklist to run AFTER completing work. Each item is a yes/no question or a checkbox assertion. Group items by concern (correctness, security, performance, maintainability). -->`,
  '## Best Practices': `<!-- PURPOSE: Recommended patterns that SHOULD be followed. Unlike Rules (which are mandatory), Best Practices are advisory — they can be overridden with justification. Each entry explains WHAT to do and WHY it helps. -->`,
  '## Anti-Patterns': `<!-- PURPOSE: Common MISTAKES to avoid. Each entry describes: (1) the wrong approach, (2) why it's wrong, (3) the correct alternative. -->`,
  '## Gotchas': `<!-- PURPOSE: Environment/version/platform-SPECIFIC traps that are NOT general anti-patterns. A gotcha is something that works in one context but breaks in another. -->`,
  '## Context Hints': `<!-- PURPOSE: Background knowledge that helps an agent make better decisions. Not rules or practices — just useful context about libraries, team conventions, or known limitations. -->`,
  '## Evolution History': null, // No PURPOSE needed for this meta-section
};

// ─── PURPOSE definitions for TROUBLESHOOTING skills ─────────────────────────
const TROUBLESHOOTING_PURPOSES = {
  '## Common Errors': `<!-- PURPOSE: Document specific error messages, stack traces, and symptoms that developers encounter. Each entry should include the exact error text and a brief description of when it occurs. -->`,
  '## Root Cause Analysis': `<!-- PURPOSE: Explain WHY each common error occurs at a technical level. Link symptoms to underlying causes (misconfiguration, race condition, version incompatibility, etc.). -->`,
  '## Fix Recipes': `<!-- PURPOSE: Step-by-step fix instructions for each error. Must be copy-paste actionable: "1. Open X, 2. Change Y to Z, 3. Verify by running W". -->`,
  '## Prevention Rules': `<!-- PURPOSE: Prescriptive rules that PREVENT errors from occurring in the first place. Written as imperatives: "Always X", "Never Y", "Before doing Z, check W". -->`,
  '## Evolution History': null,
};

// ─── PURPOSE definitions for STANDARDS skills ───────────────────────────────
const STANDARDS_PURPOSES = {
  '## Coding Standards': `<!-- PURPOSE: Language-specific coding rules enforced across the project. Each rule should be testable (a linter or reviewer can verify compliance). -->`,
  '## Naming Conventions': `<!-- PURPOSE: Naming patterns for files, variables, functions, classes, constants, and database entities. Include examples for each pattern. -->`,
  '## Directory Structure': `<!-- PURPOSE: Expected project layout rules. Describe where different types of files should live and why. -->`,
  '## Commit Conventions': `<!-- PURPOSE: Git commit message format, branch naming, PR title conventions. Include templates and examples. -->`,
  '## Evolution History': null,
};

// ─── PURPOSE definitions for bp-* (best-practice) skills ────────────────────
// These have unique sections. We map section headings to generic purpose descriptions.
const BP_PURPOSES = {
  // bp-architecture-design
  '## 第一性原理': `<!-- PURPOSE: The fundamental axiom this skill is built upon. One sentence that grounds all subsequent guidance. -->`,
  '## 设计前：回顾 spec.md 前三节': `<!-- PURPOSE: Pre-design checklist ensuring the designer has understood background, goals, and requirements before proposing architecture. -->`,
  '## 模块划分': `<!-- PURPOSE: Principles and patterns for decomposing a system into modules with clear boundaries, high cohesion, and low coupling. -->`,
  '## 依赖管理': `<!-- PURPOSE: Rules for managing dependency direction (high→low, abstract→concrete) and preventing circular dependencies. -->`,
  '## 数据架构': `<!-- PURPOSE: Decision framework for data ownership, consistency models, and schema evolution strategies. -->`,
  '## 接口设计': `<!-- PURPOSE: Architecture-level interface principles (minimality, no internal leakage, version compatibility). Detailed API design lives in bp-component-design. -->`,
  '## 反模式': `<!-- PURPOSE: Common architectural mistakes and their corrections. Each entry: anti-pattern → why it's bad → recommended fix. -->`,

  // bp-coding-best-practices
  '## 命名': `<!-- PURPOSE: Naming conventions that maximize readability: self-explanatory names, no magic numbers, boolean naming patterns, scope-appropriate length. -->`,
  '## 函数设计': `<!-- PURPOSE: Function-level design rules: single responsibility, parameter count limits, const correctness. -->`,
  '## 控制流': `<!-- PURPOSE: Control flow patterns that reduce nesting and improve readability: guard clauses, early returns. -->`,
  '## 资源安全': `<!-- PURPOSE: Resource lifecycle management: RAII, explicit ownership, narrow scope, contract checking on new return paths. -->`,
  '## 注释': `<!-- PURPOSE: When and what to comment: focus on WHY not WHAT, complex algorithms, public APIs, TODOs with context. -->`,
  '## 可观测性（日志）': `<!-- PURPOSE: Logging best practices: branch coverage, log level selection, minimum context per log entry. -->`,

  // bp-component-design
  '## 4.2.1 核心类/模块设计': `<!-- PURPOSE: Class/module-level design principles: SOLID, composition over inheritance, common design patterns with applicability guidance. -->`,
  '## 4.2.2 接口设计': `<!-- PURPOSE: Public API design: minimality, consistency, backward compatibility, self-describing signatures, version strategies. -->`,
  '## 4.2.3 数据模型': `<!-- PURPOSE: Schema design: field definition, indexing, encoding format, storage location, schema evolution and migration plans. -->`,
  '## 4.2.4 并发模型': `<!-- PURPOSE: Concurrency design: thread model, shared state identification, synchronization mechanisms, deadlock prevention. -->`,
  '## 4.2.5 错误处理': `<!-- PURPOSE: Error handling design: failure modes classification (retryable vs fatal), representation, retry strategies, recovery mechanisms. -->`,

  // bp-distributed-systems
  '## 13 条 Best Practices': `<!-- PURPOSE: 13 distributed systems best practices mapped to classical fallacies. Each entry: fallacy → reality → practice → key design points. -->`,
  '## SDLC 各阶段 Checklist': `<!-- PURPOSE: Phase-specific checklists (requirements, design, coding, testing, review, troubleshooting) with distributed systems concerns. -->`,

  // bp-performance-optimization
  '## 前置检查': `<!-- PURPOSE: Pre-optimization gate: ensure optimization target, measurement method, and profiling data are established before applying any rules. -->`,
  '## 核心理念': `<!-- PURPOSE: The fundamental philosophy — optimization is simplification. Complexity is the enemy of performance. -->`,
  '## 方法论': `<!-- PURPOSE: 5-phase optimization methodology: define goals → evaluate design → profile → optimize algorithms → apply specific rules. -->`,
  '## 设计原则': `<!-- PURPOSE: Design-level performance principles: simplicity, contiguity, directness, exclusivity, flatness, early binding, modularity. -->`,
  '## 优化规则速查': `<!-- PURPOSE: Categorized optimization techniques (space-for-time, time-for-space, loop/logic/procedure/expression rules, cache/memory, modern C++ tricks). -->`,
  '## Code Review 检查清单': `<!-- PURPOSE: Performance-focused code review checklist covering design-level and implementation-level concerns. -->`,
};

// ─── PURPOSE definitions for special-purpose skills ─────────────────────────
const SPECIAL_PURPOSES = {
  // self-refinement
  '## 核心定位': `<!-- PURPOSE: Defines the skill's core mission: converting unstructured error experiences into structured persistent context (Rules/Skills) to prevent cross-session repetition. -->`,
  '## 触发模式': `<!-- PURPOSE: Defines when self-refinement activates: automatic (after user correction) vs manual (/reflect command). -->`,
  '## 核心闭环': `<!-- PURPOSE: The 6-step refinement loop: identify error → diagnose root cause → search existing knowledge → generate suggestions → user confirmation → execute updates. -->`,
  '## 分级自主权机制 (Tiered Autonomy)': `<!-- PURPOSE: Risk-tiered autonomy: LOW (auto-execute appends to safe sections), MEDIUM (suggest + confirm), HIGH (must confirm for new files/global changes). -->`,
  '## 强制规则': `<!-- PURPOSE: Hard rules governing self-refinement behavior: don't interrupt, lightweight suggestions, user confirmation required for MEDIUM/HIGH. -->`,

  // workflow-orchestration
  '## Overview': `<!-- PURPOSE: High-level summary of the 7-stage pipeline (INIT→ANALYSE→ARCHITECT→PLAN→CODE→TEST→FINISHED) and inter-agent communication model. -->`,
  '## Pre-conditions': `<!-- PURPOSE: Prerequisites that must be satisfied before the workflow can start (manifest, user requirement, writable output dir, LLM availability). -->`,
  '## Steps': `<!-- PURPOSE: Detailed step-by-step SOP for each stage: actor, inputs, actions, outputs, hooks, and state transitions. -->`,
  '## Coding Principles': `<!-- PURPOSE: 7 coding principles that all code produced by agents must follow: no over-engineering, reuse, minimal change, incremental delivery, study first, pragmatic, clear intent. -->`,
  '## Error Handling': `<!-- PURPOSE: Error handling matrix: boundary violations, LLM failures, missing files, human review timeouts — with prescribed actions for each. -->`,
  '## Artifacts Produced': `<!-- PURPOSE: Complete artifact manifest: file name, producer agent, consumer agent — for traceability and debugging. -->`,

  // spec-template — this is a template, not a regular skill. It has numbered sections.
  // We'll add a single top-level PURPOSE.
};

// ─── Main injection logic ───────────────────────────────────────────────────

function injectPurpose(content, purposeMap) {
  const lines = content.split('\n');
  const result = [];
  let injected = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    result.push(line);

    // Check if this line is a ## heading that matches our PURPOSE map
    const trimmed = line.trim();
    if (!trimmed.startsWith('## ')) continue;

    // Find matching PURPOSE (prefix match to handle headings like "## 4.2.1 核心类/模块设计")
    let purposeComment = null;
    for (const [heading, purpose] of Object.entries(purposeMap)) {
      if (trimmed === heading || trimmed.startsWith(heading)) {
        purposeComment = purpose;
        break;
      }
    }

    if (!purposeComment) continue; // No PURPOSE defined for this heading, or it's null (like Evolution History)

    // Check if next non-empty line is already a PURPOSE comment
    const nextIdx = i + 1;
    if (nextIdx < lines.length && lines[nextIdx].trim().startsWith('<!-- PURPOSE:')) {
      continue; // Already has PURPOSE
    }

    // Inject PURPOSE comment after the heading
    result.push(purposeComment);
    injected++;
  }

  return { content: result.join('\n'), injected };
}

function getPurposeMapForFile(filename, content) {
  // Determine which PURPOSE map to use based on filename and content
  if (filename === 'troubleshooting.md') return TROUBLESHOOTING_PURPOSES;
  if (filename === 'standards.md') return STANDARDS_PURPOSES;
  if (filename.startsWith('bp-')) return BP_PURPOSES;
  if (filename === 'self-refinement.md') return SPECIAL_PURPOSES;
  if (filename === 'workflow-orchestration.md') return SPECIAL_PURPOSES;
  if (filename === 'spec-template.md') return {}; // Template — no PURPOSE injection needed

  // Default: standard 5-section skill
  return STANDARD_PURPOSES;
}

function computeThinness(content, filename) {
  // Compute a comprehensive "richness score" for P2 prioritization.
  // Higher score = richer content. Lower score = needs enrichment.
  //
  // Scoring dimensions (v2 — fixed to count ALL content types):
  //   D1: Structured items (rules, numbered lists, bullets)  — high value
  //   D2: Table rows (data-dense knowledge)                  — medium value
  //   D3: Prose paragraphs (explanatory text)                — base value
  //   D4: Checklists (verification items)                    — high value
  //   D5: Code blocks (examples)                             — medium value
  //   Penalty: placeholder sections                          — negative
  const lines = content.split('\n');

  // D1: Structured items — numbered items (with or without bold), dash-bold items
  const numberedBoldItems = (content.match(/^\d+\.\s+\*\*/gm) || []).length;
  const numberedPlainItems = (content.match(/^\d+\.\s+[^*\s]/gm) || []).length;
  const dashBoldItems = (content.match(/^- \*\*/gm) || []).length;
  const dashPlainItems = (content.match(/^- [^[*\s-]/gm) || []).length;
  const structuredItems = numberedBoldItems + numberedPlainItems + dashBoldItems + dashPlainItems;

  // D2: Table rows (exclude header separators like |---|)
  const tableRows = lines.filter(l => {
    const t = l.trim();
    return t.startsWith('|') && t.endsWith('|') && !(/^\|[\s-|]+\|$/.test(t));
  }).length;

  // D3: Prose paragraphs (non-empty, non-structural lines)
  const proseLines = lines.filter(l => {
    const t = l.trim();
    return t.length > 20 // meaningful prose, not just a short label
      && !t.startsWith('#')
      && !t.startsWith('---')
      && !t.startsWith('|')
      && !t.startsWith('<!-- ')
      && !t.startsWith('_No ')
      && !t.startsWith('```')
      && !t.startsWith('>')
      && !/^\d+\.\s/.test(t)
      && !t.startsWith('- ');
  }).length;

  // D4: Checklists
  const checkboxItems = (content.match(/^- \[[ x]\]/gm) || []).length;

  // D5: Code blocks
  const codeBlocks = (content.match(/^```/gm) || []).length / 2; // pairs

  // Penalty: placeholder sections
  const placeholderCount = (content.match(/_No .+? defined yet/g) || []).length
    + (content.match(/_No .+? documented yet/g) || []).length;

  // Section count
  const substantiveSections = (content.match(/^## /gm) || []).length;

  // Weighted score formula:
  //   structuredItems × 3  (highest value: independently verifiable rules/practices)
  //   checkboxItems × 2.5  (high value: actionable verification)
  //   tableRows × 1.5      (medium value: data-dense but less actionable)
  //   codeBlocks × 2       (medium-high: concrete examples)
  //   proseLines × 0.5     (base: explanatory but less structured)
  //   placeholders × -15   (penalty)
  const score = Math.round(
    (structuredItems * 3)
    + (checkboxItems * 2.5)
    + (tableRows * 1.5)
    + (codeBlocks * 2)
    + (proseLines * 0.5)
    - (placeholderCount * 15)
  );

  const totalItems = structuredItems + checkboxItems + tableRows + Math.floor(codeBlocks);

  return {
    filename,
    contentLines: proseLines + structuredItems + tableRows + checkboxItems,
    placeholderCount,
    substantiveSections,
    itemCount: totalItems,
    score,
    sizeKB: (Buffer.byteLength(content, 'utf-8') / 1024).toFixed(1),
  };
}

// ─── Execute ────────────────────────────────────────────────────────────────

function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  P1: Batch inject PURPOSE comments into Skill files`);
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (no files modified)' : 'LIVE'}`);
  console.log(`${'═'.repeat(60)}\n`);

  const files = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.md')).sort();
  const thinnessReport = [];
  let totalInjected = 0;
  let filesModified = 0;

  for (const filename of files) {
    const filePath = path.join(SKILLS_DIR, filename);
    const content = fs.readFileSync(filePath, 'utf-8');
    const purposeMap = getPurposeMapForFile(filename, content);

    if (Object.keys(purposeMap).length === 0) {
      console.log(`  ⏭  ${filename} — skipped (template/no PURPOSE map)`);
      thinnessReport.push(computeThinness(content, filename));
      continue;
    }

    const { content: newContent, injected } = injectPurpose(content, purposeMap);

    if (injected > 0) {
      if (!DRY_RUN) {
        // Atomic write
        const tmpPath = filePath + '.tmp';
        fs.writeFileSync(tmpPath, newContent, 'utf-8');
        fs.renameSync(tmpPath, filePath);
      }
      console.log(`  ✅ ${filename} — ${injected} PURPOSE comment(s) injected`);
      totalInjected += injected;
      filesModified++;
    } else {
      console.log(`  ✔  ${filename} — already has all PURPOSE comments`);
    }

    thinnessReport.push(computeThinness(newContent || content, filename));
  }

  // ─── P2: Thinness Report ──────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  P2: Skill Thinness Report (lower score = needs enrichment)`);
  console.log(`${'═'.repeat(60)}\n`);

  // Sort by score ascending (thinnest first)
  thinnessReport.sort((a, b) => a.score - b.score);

  console.log(`  ${'Skill'.padEnd(35)} ${'Size'.padStart(6)} ${'Lines'.padStart(6)} ${'Items'.padStart(6)} ${'Empty'.padStart(6)} ${'Score'.padStart(6)}`);
  console.log(`  ${'─'.repeat(35)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(6)}`);

  for (const r of thinnessReport) {
    const flag = r.score < 50 ? ' ⚠️ ' : r.score < 80 ? ' 🔶' : ' ✅';
    console.log(`${flag} ${r.filename.padEnd(35)} ${(r.sizeKB + 'KB').padStart(6)} ${String(r.contentLines).padStart(6)} ${String(r.itemCount).padStart(6)} ${String(r.placeholderCount).padStart(6)} ${String(r.score).padStart(6)}`);
  }

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Summary`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  Total files:     ${files.length}`);
  console.log(`  Files modified:  ${filesModified}`);
  console.log(`  PURPOSE injected: ${totalInjected}`);
  console.log(`  P2 candidates:   ${thinnessReport.filter(r => r.score < 50).length} (score < 50, marked ⚠️)`);
  console.log(`  P2 borderline:   ${thinnessReport.filter(r => r.score >= 50 && r.score < 80).length} (score 50-79, marked 🔶)`);
  console.log(`  P2 healthy:      ${thinnessReport.filter(r => r.score >= 80).length} (score >= 80, marked ✅)`);
  console.log();
}

main();
