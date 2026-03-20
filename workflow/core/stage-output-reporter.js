/**
 * Stage Output Reporter — Transparent Stage Artifact Summaries
 *
 * Problem: During workflow execution, the ARCHITECT and PLAN stages produce
 * important artifacts (architecture.md, execution-plan.md), but users only see
 * console.log messages that disappear quickly. The process feels like a black box.
 *
 * Solution: After each stage completes, extract and display a concise summary
 * of the produced artifact so users can follow the pipeline's reasoning in real-time.
 *
 * Design:
 *   - Zero LLM calls (pure text extraction — no additional cost)
 *   - Configurable verbosity (compact / detailed)
 *   - Graceful degradation (if artifact is missing or unreadable, skip silently)
 *   - Supports all artifact types: .md, .diff, .json
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { WorkflowState } = require('./types');

// ─── Stage → Artifact Mapping ───────────────────────────────────────────────

/**
 * Maps workflow states to their expected output artifact filenames.
 * Used to locate the artifact file after a stage completes.
 */
const STAGE_ARTIFACT_MAP = {
  [WorkflowState.ANALYSE]:   'requirement.md',
  [WorkflowState.ARCHITECT]: 'architecture.md',
  [WorkflowState.PLAN]:      'execution-plan.md',
  [WorkflowState.CODE]:      'code.diff',
  [WorkflowState.TEST]:      'test-report.md',
};

// ─── Summary Extraction Strategies ──────────────────────────────────────────

/**
 * Extracts a structured summary from a Markdown artifact.
 *
 * Strategy:
 *   1. Extract JSON metadata block (if present at the top)
 *   2. Extract first-level headings (## sections) as outline
 *   3. Extract key decisions / tasks / risks sections
 *
 * @param {string} content - File content
 * @param {string} stageName - Stage name for context-specific extraction
 * @returns {{ outline: string[], keyPoints: string[], jsonMeta: object|null }}
 */
function extractMdSummary(content, stageName) {
  const result = { outline: [], keyPoints: [], jsonMeta: null };

  if (!content || content.length === 0) return result;

  // 1. Extract JSON metadata block (```json ... ``` at the top)
  const jsonMatch = content.match(/^```json\s*\n([\s\S]*?)\n```/m);
  if (jsonMatch) {
    try {
      result.jsonMeta = JSON.parse(jsonMatch[1]);
    } catch { /* ignore malformed JSON */ }
  }

  // 2. Extract outline (## headings)
  const headings = content.match(/^#{1,3}\s+.+$/gm) || [];
  result.outline = headings.slice(0, 12).map(h => h.replace(/^#+\s*/, '').trim());

  // 3. Extract key points based on stage type
  if (stageName === WorkflowState.ARCHITECT) {
    // Look for tech stack, components, data flow sections
    // FIX(Defect #5): Added comprehensive Chinese section title variants
    const techPattern = /(?:Tech(?:nology)?\s*Stack|技术栈|技术选型|技术方案)[:\s]*\n([\s\S]*?)(?=\n##|\n---|\n$)/i;
    const techMatch = content.match(techPattern);
    if (techMatch) {
      const techLines = techMatch[1].split('\n').filter(l => /^\s*[-*]/.test(l)).slice(0, 5);
      result.keyPoints.push(...techLines.map(l => l.replace(/^\s*[-*]\s*/, '').trim()));
    }

    // Extract component list
    // FIX(Defect #5): Added Chinese variants: 组件, 系统组件, 组件分解, 模块分解, 核心模块
    const compPattern = /(?:Component|Module|模块|组件|系统组件|组件分解|模块分解|核心模块)[s]?\s*[:\s]*\n([\s\S]*?)(?=\n##|\n---|\n$)/i;
    const compMatch = content.match(compPattern);
    if (compMatch) {
      const compLines = compMatch[1].split('\n').filter(l => /^\s*[-*]/.test(l)).slice(0, 6);
      result.keyPoints.push(...compLines.map(l => `[Component] ${l.replace(/^\s*[-*]\s*/, '').trim()}`));
    }

    // FIX(Defect #5): Extract data flow / architecture decisions (new for Chinese docs)
    const dataFlowPattern = /(?:数据流|数据流转|架构决策|设计决策|Data\s*Flow|Architecture\s*Decision)[s]?\s*[:\s]*\n([\s\S]*?)(?=\n##|\n---|\n$)/i;
    const dataFlowMatch = content.match(dataFlowPattern);
    if (dataFlowMatch) {
      const dfLines = dataFlowMatch[1].split('\n').filter(l => /^\s*[-*\d]/.test(l)).slice(0, 4);
      result.keyPoints.push(...dfLines.map(l => `[Decision] ${l.replace(/^\s*[-*\d.]\s*/, '').trim()}`));
    }
  } else if (stageName === WorkflowState.PLAN) {
    // Look for task breakdown, phases, dependencies
    // FIX(Defect #5): Added Chinese task header patterns: 任务 T-001, 任务一 etc.
    const taskPattern = /####?\s*(?:Task|任务)\s*(?:T-)?\d+[:\s：]*.*/gi;
    const tasks = content.match(taskPattern) || [];
    result.keyPoints.push(...tasks.slice(0, 8).map(t => t.replace(/^#+\s*/, '').trim()));

    // Extract phase headers
    // FIX(Defect #5): Added Chinese phase patterns: 阶段, 第N阶段, 阶段N
    const phasePattern = /###?\s*(?:Phase|阶段|第[一二三四五六七八九十\d]+阶段)\s*\d*[:\s：]*.*/gi;
    const phases = content.match(phasePattern) || [];
    result.keyPoints.push(...phases.slice(0, 4).map(p => `[Phase] ${p.replace(/^#+\s*/, '').trim()}`));

    // FIX(Defect #5): Extract dependency/risk info (Chinese docs often have 依赖/风险 sections)
    const depPattern = /(?:依赖关系|关键依赖|Dependencies|风险|Risk)[s]?\s*[:\s：]*\n([\s\S]*?)(?=\n##|\n---|\n$)/i;
    const depMatch = content.match(depPattern);
    if (depMatch) {
      const depLines = depMatch[1].split('\n').filter(l => /^\s*[-*\d]/.test(l)).slice(0, 3);
      result.keyPoints.push(...depLines.map(l => `[Risk/Dep] ${l.replace(/^\s*[-*\d.]\s*/, '').trim()}`));
    }
  } else if (stageName === WorkflowState.ANALYSE) {
    // Look for functional requirements, user stories
    // FIX(Defect #5): Added comprehensive Chinese requirement section title variants
    const reqPattern = /(?:Functional\s*Requirement|功能需求|需求描述|需求列表|用户故事|用户需求|User\s*Stor)[iesy]*\s*[:\s：]*\n([\s\S]*?)(?=\n##|\n---|\n$)/i;
    const reqMatch = content.match(reqPattern);
    if (reqMatch) {
      const reqLines = reqMatch[1].split('\n').filter(l => /^\s*[-*\d]/.test(l)).slice(0, 5);
      result.keyPoints.push(...reqLines.map(l => l.replace(/^\s*[-*\d.]\s*/, '').trim()));
    }

    // FIX(Defect #5): Extract acceptance criteria / non-functional requirements (Chinese)
    const acPattern = /(?:验收标准|验收条件|Acceptance\s*Criteria|非功能需求|Non.?Functional)[s]?\s*[:\s：]*\n([\s\S]*?)(?=\n##|\n---|\n$)/i;
    const acMatch = content.match(acPattern);
    if (acMatch) {
      const acLines = acMatch[1].split('\n').filter(l => /^\s*[-*\d]/.test(l)).slice(0, 4);
      result.keyPoints.push(...acLines.map(l => `[AC] ${l.replace(/^\s*[-*\d.]\s*/, '').trim()}`));
    }
  } else if (stageName === WorkflowState.TEST) {
    // Look for test summary, pass/fail counts
    // FIX(Defect #5): Added Chinese test report section variants
    const summaryPattern = /(?:Test\s*Summary|测试总结|测试概要|测试结果|执行结果|Overall\s*Result)[:\s：]*\n([\s\S]*?)(?=\n##|\n---|\n$)/i;
    const summaryMatch = content.match(summaryPattern);
    if (summaryMatch) {
      const summaryLines = summaryMatch[1].split('\n').filter(l => l.trim()).slice(0, 4);
      result.keyPoints.push(...summaryLines.map(l => l.replace(/^\s*[-*]\s*/, '').trim()));
    }

    // FIX(Defect #5): Extract pass/fail statistics from Chinese test reports
    // Match patterns like: 通过: 10, 失败: 2 or Pass: 10 / Fail: 2
    const statsPattern = /(?:通过|Pass(?:ed)?)[:\s：]*\s*(\d+)/i;
    const statsMatch = content.match(statsPattern);
    const failPattern = /(?:失败|Fail(?:ed)?)[:\s：]*\s*(\d+)/i;
    const failMatch = content.match(failPattern);
    if (statsMatch || failMatch) {
      const passed = statsMatch ? statsMatch[1] : '?';
      const failed = failMatch ? failMatch[1] : '?';
      result.keyPoints.unshift(`[Stats] Passed: ${passed} | Failed: ${failed}`);
    }
  }

  return result;
}

/**
 * Extracts a summary from a code diff artifact.
 *
 * @param {string} content - Diff content
 * @returns {{ filesChanged: string[], additions: number, deletions: number }}
 */
function extractDiffSummary(content) {
  const result = { filesChanged: [], additions: 0, deletions: 0 };
  if (!content) return result;

  // Extract changed files from diff headers
  const diffHeaders = content.match(/^(?:diff --git|---|\+\+\+)\s+[ab]?\/?(.+)$/gm) || [];
  const files = new Set();
  for (const h of diffHeaders) {
    const m = h.match(/(?:diff --git a\/|--- a\/|\+\+\+ b\/)(.+)/);
    if (m && m[1] !== '/dev/null') files.add(m[1]);
  }
  result.filesChanged = [...files].slice(0, 15);

  // Count additions and deletions
  const lines = content.split('\n');
  for (const l of lines) {
    if (l.startsWith('+') && !l.startsWith('+++')) result.additions++;
    if (l.startsWith('-') && !l.startsWith('---')) result.deletions++;
  }

  return result;
}

// ─── Reporter ───────────────────────────────────────────────────────────────

/**
 * Reports the output of a completed stage to the console.
 *
 * @param {string} stageName - WorkflowState value (e.g. 'ARCHITECT', 'PLAN')
 * @param {string} outputDir - Output directory path
 * @param {object} [opts]
 * @param {string} [opts.artifactPath] - Explicit artifact path (overrides auto-detection)
 * @param {boolean} [opts.verbose=false] - Show more detail
 * @param {Function} [opts.hookEmit] - Hook emitter function for STAGE_ARTIFACT_PRODUCED
 */
function reportStageOutput(stageName, outputDir, opts = {}) {
  try {
    const artifactName = STAGE_ARTIFACT_MAP[stageName];
    if (!artifactName) return; // Unknown stage, skip

    const artifactPath = opts.artifactPath || path.join(outputDir, artifactName);
    if (!fs.existsSync(artifactPath)) {
      console.log(`[StageReport] ⚠️  ${stageName} artifact not found: ${artifactName}`);
      return;
    }

    const content = fs.readFileSync(artifactPath, 'utf-8');
    const fileSize = Buffer.byteLength(content, 'utf-8');
    const lineCount = content.split('\n').length;

    const separator = '─'.repeat(58);
    console.log(`\n${separator}`);
    console.log(`  📄 STAGE OUTPUT: ${stageName}`);
    console.log(`  Artifact: ${artifactName} (${lineCount} lines, ${_formatSize(fileSize)})`);
    console.log(separator);

    if (artifactPath.endsWith('.diff')) {
      // ── Diff summary ──
      const diff = extractDiffSummary(content);
      console.log(`  Files changed: ${diff.filesChanged.length}`);
      console.log(`  Additions: +${diff.additions} | Deletions: -${diff.deletions}`);
      if (diff.filesChanged.length > 0) {
        console.log(`  Changed files:`);
        for (const f of diff.filesChanged.slice(0, 10)) {
          console.log(`    • ${f}`);
        }
        if (diff.filesChanged.length > 10) {
          console.log(`    ... and ${diff.filesChanged.length - 10} more`);
        }
      }
    } else {
      // ── Markdown summary ──
      const summary = extractMdSummary(content, stageName);

      // JSON metadata (if present)
      if (summary.jsonMeta) {
        const meta = summary.jsonMeta;
        const metaEntries = [];
        if (meta.title) metaEntries.push(`Title: ${meta.title}`);
        if (meta.complexity) metaEntries.push(`Complexity: ${meta.complexity}`);
        if (meta.confidence) metaEntries.push(`Confidence: ${meta.confidence}`);
        if (meta.totalTasks) metaEntries.push(`Tasks: ${meta.totalTasks}`);
        if (meta.totalPhases) metaEntries.push(`Phases: ${meta.totalPhases}`);
        if (meta.estimatedEffort) metaEntries.push(`Effort: ${meta.estimatedEffort}`);
        if (metaEntries.length > 0) {
          console.log(`  Metadata: ${metaEntries.join(' | ')}`);
        }
      }

      // Document outline
      if (summary.outline.length > 0) {
        console.log(`  Document outline:`);
        for (const h of summary.outline) {
          console.log(`    § ${h}`);
        }
      }

      // Key points
      if (summary.keyPoints.length > 0) {
        console.log(`  Key points:`);
        for (const p of summary.keyPoints) {
          console.log(`    → ${p}`);
        }
      }
    }

    // Chinese translation status
    const zhPath = artifactPath.replace(/\.md$/, '.zh.md');
    if (artifactPath.endsWith('.md') && fs.existsSync(zhPath)) {
      const zhSize = fs.statSync(zhPath).size;
      console.log(`  中文版本: ${path.basename(zhPath)} (${_formatSize(zhSize)}) ✅`);
    } else if (artifactPath.endsWith('.md')) {
      console.log(`  中文版本: generating... ⏳`);
    }

    console.log(separator);

    // Emit hook event
    if (opts.hookEmit) {
      opts.hookEmit('stage_artifact_produced', {
        stage: stageName,
        artifact: artifactName,
        path: artifactPath,
        lines: lineCount,
        size: fileSize,
      }).catch(() => {});
    }
  } catch (err) {
    // Non-fatal: don't let reporting errors break the pipeline
    console.warn(`[StageReport] ⚠️  Failed to report ${stageName} output (non-fatal): ${err.message}`);
  }
}

/**
 * Formats byte size into human-readable string.
 * @param {number} bytes
 * @returns {string}
 */
function _formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

module.exports = { reportStageOutput, extractMdSummary, extractDiffSummary, STAGE_ARTIFACT_MAP };
