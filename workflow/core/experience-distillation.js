/**
 * Experience Distillation Mixin – P2-C
 *
 * Implements experience consolidation and merging:
 *   - Identifies similar experiences by title similarity + tag overlap + category match
 *   - Merges groups of similar experiences into single high-confidence entries
 *   - Preserves the most valuable content while eliminating redundancy
 *   - Tracks distillation metadata for auditing
 *
 * Inspired by:
 *   - OpenHands' SWE-Playground "continual learning" consolidation
 *   - LangGraph's "Version your state" approach to memory management
 *   - Biological memory consolidation (short-term → long-term with compression)
 *
 * Usage:
 *   Called automatically on store load when experience count exceeds threshold,
 *   or manually via `store.distill()`.
 */

'use strict';

// ─── Similarity Computation ─────────────────────────────────────────────────

/**
 * Computes a normalised similarity score between two experience records.
 * Uses a weighted combination of:
 *   - Title similarity (bigram Jaccard, weight: 0.4)
 *   - Tag overlap (Jaccard, weight: 0.3)
 *   - Category match (exact, weight: 0.2)
 *   - Type match (positive/negative, weight: 0.1)
 *
 * @param {object} a - Experience record
 * @param {object} b - Experience record
 * @returns {number} Similarity score in [0, 1]
 */
function computeSimilarity(a, b) {
  const titleSim  = _bigramJaccard(a.title || '', b.title || '');
  const tagSim    = _setJaccard(new Set(a.tags || []), new Set(b.tags || []));
  const catMatch  = (a.category === b.category) ? 1.0 : 0.0;
  const typeMatch = (a.type === b.type) ? 1.0 : 0.0;

  return 0.4 * titleSim + 0.3 * tagSim + 0.2 * catMatch + 0.1 * typeMatch;
}

/**
 * Bigram Jaccard similarity for two strings.
 * @param {string} s1
 * @param {string} s2
 * @returns {number} in [0, 1]
 */
function _bigramJaccard(s1, s2) {
  const bg1 = _bigrams(s1.toLowerCase());
  const bg2 = _bigrams(s2.toLowerCase());
  if (bg1.size === 0 && bg2.size === 0) return 1.0;
  if (bg1.size === 0 || bg2.size === 0) return 0.0;

  let intersection = 0;
  for (const bg of bg1) {
    if (bg2.has(bg)) intersection++;
  }
  return intersection / (bg1.size + bg2.size - intersection);
}

/**
 * Extracts character bigrams from a string.
 * @param {string} s
 * @returns {Set<string>}
 */
function _bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) {
    set.add(s.slice(i, i + 2));
  }
  return set;
}

/**
 * Jaccard similarity for two sets.
 * @param {Set} a
 * @param {Set} b
 * @returns {number} in [0, 1]
 */
function _setJaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1.0;
  if (a.size === 0 || b.size === 0) return 0.0;

  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

// ─── Conflict Detection ─────────────────────────────────────────────────────

/**
 * Contradiction signal keywords. When the newer experience's content contains
 * one of these relative to the older experience, it indicates a conflict.
 * We compare whether old and new content give opposite advice.
 */
const CONTRADICTION_SIGNALS = [
  // Direct negation pairs
  ['should', 'should not'],
  ['must', 'must not'],
  ['always', 'never'],
  ['recommended', 'deprecated'],
  ['use', 'avoid'],
  ['enable', 'disable'],
  ['correct', 'incorrect'],
  ['safe', 'unsafe'],
  ['required', 'optional'],
  ['do', "don't"],
  ['do', 'do not'],
];

/**
 * Detects if two experiences in the same category have contradictory content.
 * Uses lightweight heuristic (no LLM calls):
 *   1. Both must be in the same category
 *   2. Both must have high title similarity (>= 0.5 bigram Jaccard)
 *   3. Content contains opposing signals (e.g. "use X" vs "avoid X")
 *
 * @param {object} older - Older experience record
 * @param {object} newer - Newer experience record
 * @returns {{ isConflict: boolean, reason: string }}
 */
function detectConflict(older, newer) {
  // Must be same category to be a meaningful conflict
  if (older.category !== newer.category) {
    return { isConflict: false, reason: '' };
  }

  // Title similarity check — only flag conflicts for closely related experiences
  const titleSim = _bigramJaccard(older.title || '', newer.title || '');
  if (titleSim < 0.5) {
    return { isConflict: false, reason: '' };
  }

  const olderContent = (older.content || '').toLowerCase();
  const newerContent = (newer.content || '').toLowerCase();

  // Check for contradiction signals
  for (const [positive, negative] of CONTRADICTION_SIGNALS) {
    // Case 1: old says "positive", new says "negative"
    if (olderContent.includes(positive) && newerContent.includes(negative)) {
      return {
        isConflict: true,
        reason: `Opposing advice detected: older uses "${positive}", newer uses "${negative}"`,
      };
    }
    // Case 2: old says "negative", new says "positive"
    if (olderContent.includes(negative) && newerContent.includes(positive)) {
      return {
        isConflict: true,
        reason: `Opposing advice detected: older uses "${negative}", newer uses "${positive}"`,
      };
    }
  }

  // Check for type mismatch: one positive, one negative on the same topic
  if (older.type !== newer.type && titleSim >= 0.6) {
    return {
      isConflict: true,
      reason: `Type conflict: older is ${older.type}, newer is ${newer.type} (title similarity: ${(titleSim * 100).toFixed(0)}%)`,
    };
  }

  return { isConflict: false, reason: '' };
}

// ─── Distillation Mixin ─────────────────────────────────────────────────────

const ExperienceDistillationMixin = {

  /**
   * Identifies groups of similar experiences and merges each group into
   * a single consolidated experience record.
   *
   * Algorithm:
   *   1. Group experiences by category (cheap pre-filter)
   *   2. Within each category, compute pairwise similarity
   *   3. Build clusters using greedy single-linkage at threshold
   *   4. For each cluster of size >= 2, merge into one record
   *
   * @param {object} [options]
   * @param {number} [options.similarityThreshold=0.65] - Min similarity to consider merging
   * @param {number} [options.minClusterSize=2]  - Min experiences in a cluster to trigger merge
   * @param {boolean} [options.dryRun=false]     - If true, return plan without modifying store
   * @returns {{ merged: number, removed: number, clusters: Array<{representative: string, members: string[]}> }}
   */
  distill({ similarityThreshold = 0.65, minClusterSize = 2, dryRun = false } = {}) {
    const start = Date.now();
    const experiences = this.experiences;
    if (experiences.length < minClusterSize) {
      return { merged: 0, removed: 0, clusters: [] };
    }

    // Step 1: Group by category for cheaper pairwise comparison
    const byCategory = new Map();
    for (const exp of experiences) {
      const cat = exp.category || 'unknown';
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat).push(exp);
    }

    // Step 2+3: Find clusters within each category
    // P1-1 fix: Use blocking (first 3 bigrams of title) to reduce O(N²) to O(N × B),
    // where B is the block size. Only experiences in the same block are compared.
    // P1-3 fix: Pre-compute bigram sets for all titles to avoid redundant recomputation.
    const allClusters = [];
    for (const [, catExps] of byCategory) {
      if (catExps.length < minClusterSize) continue;

      // Pre-compute bigram sets and blocking keys for this category
      const n = catExps.length;
      const bigramCache = new Array(n);
      const tagSetCache = new Array(n);
      const blocks = new Map(); // blockKey → [indices]

      for (let i = 0; i < n; i++) {
        bigramCache[i] = _bigrams((catExps[i].title || '').toLowerCase());
        tagSetCache[i] = new Set(catExps[i].tags || []);
        // Blocking: use first 3 bigrams as block keys (each experience can be in multiple blocks)
        const title = (catExps[i].title || '').toLowerCase();
        const blockKeys = new Set();
        for (let c = 0; c < Math.min(title.length - 1, 3); c++) {
          blockKeys.add(title.slice(c, c + 2));
        }
        if (blockKeys.size === 0) blockKeys.add('__default__');
        for (const key of blockKeys) {
          if (!blocks.has(key)) blocks.set(key, []);
          blocks.get(key).push(i);
        }
      }

      // Build adjacency based on similarity threshold (only within blocks)
      const visited = new Set();
      const candidatePairs = new Set(); // "i:j" strings to avoid duplicate pair checks

      for (const [, blockIndices] of blocks) {
        if (blockIndices.length < 2) continue;
        for (let bi = 0; bi < blockIndices.length; bi++) {
          for (let bj = bi + 1; bj < blockIndices.length; bj++) {
            const i = blockIndices[bi];
            const j = blockIndices[bj];
            const pairKey = i < j ? `${i}:${j}` : `${j}:${i}`;
            candidatePairs.add(pairKey);
          }
        }
      }

      // Now compute similarity only for candidate pairs and build clusters
      const adjList = new Map(); // index → Set of similar indices
      for (const pairKey of candidatePairs) {
        const [iStr, jStr] = pairKey.split(':');
        const i = Number(iStr);
        const j = Number(jStr);

        // Compute similarity using pre-cached bigrams and tag sets
        const bg1 = bigramCache[i];
        const bg2 = bigramCache[j];
        let bgIntersection = 0;
        for (const bg of bg1) { if (bg2.has(bg)) bgIntersection++; }
        const titleSim = (bg1.size === 0 && bg2.size === 0) ? 1.0
          : (bg1.size === 0 || bg2.size === 0) ? 0.0
          : bgIntersection / (bg1.size + bg2.size - bgIntersection);

        const tagSim = _setJaccard(tagSetCache[i], tagSetCache[j]);
        const catMatch = (catExps[i].category === catExps[j].category) ? 1.0 : 0.0;
        const typeMatch = (catExps[i].type === catExps[j].type) ? 1.0 : 0.0;
        const sim = 0.4 * titleSim + 0.3 * tagSim + 0.2 * catMatch + 0.1 * typeMatch;

        if (sim >= similarityThreshold) {
          if (!adjList.has(i)) adjList.set(i, new Set());
          if (!adjList.has(j)) adjList.set(j, new Set());
          adjList.get(i).add(j);
          adjList.get(j).add(i);
        }
      }

      // Greedy single-linkage clustering from adjacency list
      for (let i = 0; i < n; i++) {
        if (visited.has(i)) continue;
        const neighbors = adjList.get(i);
        if (!neighbors || neighbors.size === 0) continue;

        const cluster = [i];
        visited.add(i);
        for (const j of neighbors) {
          if (!visited.has(j)) {
            cluster.push(j);
            visited.add(j);
          }
        }

        if (cluster.length >= minClusterSize) {
          allClusters.push(cluster.map(idx => catExps[idx]));
        }
      }
    }

    if (allClusters.length === 0) {
      return { merged: 0, removed: 0, clusters: [] };
    }

    // Step 4: Conflict detection + Merge each cluster
    const clusterDetails = [];
    const idsToRemove = new Set();
    const conflicts = [];

    for (const cluster of allClusters) {
      // ── Conflict Detection (within cluster) ─────────────────────────
      // Before merging, check if any pair within the cluster has contradictory
      // content. When a conflict is detected, the NEWER experience wins
      // (recency bias: latest knowledge is most likely correct).
      const sortedByDate = [...cluster].sort(
        (a, b) => new Date(a.updatedAt || a.createdAt).getTime() - new Date(b.updatedAt || b.createdAt).getTime()
      );

      // Compare each pair within the cluster for conflicts
      for (let ci = 0; ci < sortedByDate.length; ci++) {
        for (let cj = ci + 1; cj < sortedByDate.length; cj++) {
          const older = sortedByDate[ci];
          const newer = sortedByDate[cj];
          const { isConflict, reason } = detectConflict(older, newer);
          if (isConflict) {
            conflicts.push({
              olderId: older.id,
              olderTitle: older.title,
              newerId: newer.id,
              newerTitle: newer.title,
              reason,
              resolution: 'keep-newer',
            });
            // Mark the older conflicting experience for removal (newer wins)
            idsToRemove.add(older.id);
            if (!dryRun) {
              // Annotate the newer experience with conflict resolution metadata
              if (!newer.conflictResolutions) newer.conflictResolutions = [];
              newer.conflictResolutions.push({
                timestamp: new Date().toISOString(),
                supersededId: older.id,
                supersededTitle: older.title,
                reason,
              });
              newer.updatedAt = new Date().toISOString();
              console.log(`[ExperienceStore] ⚡ Conflict detected [${older.category}]: "${older.title}" → superseded by "${newer.title}" (${reason})`);
            }
          }
        }
      }

      // Pick representative: highest hitCount, then newest
      const sorted = [...cluster].sort((a, b) => {
        if ((b.hitCount || 0) !== (a.hitCount || 0)) return (b.hitCount || 0) - (a.hitCount || 0);
        return new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime();
      });
      const representative = sorted[0];
      const others = sorted.slice(1);

      if (!dryRun) {
        // Merge content from others into representative
        const mergedContent = others.map(o =>
          `[Distilled from "${o.title}" (${o.id})] ${o.content}`
        ).join('\n\n');

        if (mergedContent) {
          representative.content = `${representative.content}\n\n--- Distilled Knowledge ---\n${mergedContent}`;
        }

        // Accumulate hitCount from all members
        representative.hitCount = (representative.hitCount || 0) +
          others.reduce((sum, o) => sum + (o.hitCount || 0), 0);

        // Merge tags (union, deduplicated)
        const allTags = new Set(representative.tags || []);
        for (const o of others) {
          for (const t of (o.tags || [])) allTags.add(t);
        }
        representative.tags = [...allTags];

        // Track distillation metadata
        if (!representative.distillation) representative.distillation = [];
        representative.distillation.push({
          timestamp: new Date().toISOString(),
          mergedIds: others.map(o => o.id),
          mergedTitles: others.map(o => o.title),
        });

        representative.updatedAt = new Date().toISOString();
        representative.evolutionCount = (representative.evolutionCount || 0) + 1;
      }

      clusterDetails.push({
        representative: representative.title,
        representativeId: representative.id,
        members: cluster.map(c => c.title),
      });

      // Mark non-representative members for removal
      for (const o of others) {
        idsToRemove.add(o.id);
      }
    }

    let removed = 0;
    if (!dryRun && idsToRemove.size > 0) {
      const before = this.experiences.length;
      this.experiences = this.experiences.filter(e => !idsToRemove.has(e.id));
      this._titleIndex = new Set(this.experiences.map(e => e.title));
      removed = before - this.experiences.length;
      this._save();
    }

    const elapsed = Date.now() - start;
    const result = {
      merged: allClusters.length,
      removed: dryRun ? idsToRemove.size : removed,
      clusters: clusterDetails,
      conflicts,
    };

    const conflictMsg = conflicts.length > 0 ? `, ${conflicts.length} conflict(s) resolved (keep-newer)` : '';
    console.log(`[ExperienceStore] 🧪 Distillation ${dryRun ? '(dry-run)' : 'complete'}: ` +
      `${result.merged} cluster(s) merged, ${result.removed} redundant record(s) removed${conflictMsg} ` +
      `(${elapsed}ms)`);

    return result;
  },

  /**
   * Automatically runs distillation if experience count exceeds capacity * threshold.
   * Called on load when the store has accumulated many entries.
   *
   * @param {object} [options]
   * @param {number} [options.triggerRatio=0.8] - Distill when count >= capacity * ratio
   */
  autoDistill({ triggerRatio = 0.8 } = {}) {
    try {
      const { EXPERIENCE } = require('./constants');
      const capacity = EXPERIENCE.MAX_CAPACITY;
      if (this.experiences.length >= capacity * triggerRatio) {
        console.log(`[ExperienceStore] 🧪 Auto-distillation triggered: ${this.experiences.length} >= ${Math.floor(capacity * triggerRatio)} (${Math.round(triggerRatio * 100)}% of ${capacity})`);
        return this.distill();
      }
    } catch (_) { /* constants not available */ }
    return { merged: 0, removed: 0, clusters: [] };
  },
};

module.exports = { ExperienceDistillationMixin, computeSimilarity, detectConflict };
