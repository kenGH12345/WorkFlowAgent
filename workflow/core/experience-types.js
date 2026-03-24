/**
 * Experience Types & Categories – Shared constants for the experience system
 *
 * Extracted to avoid circular dependencies between experience-store.js,
 * experience-query.js, experience-evolution.js, and experience-transfer.js.
 */

'use strict';

// ─── Experience Types ─────────────────────────────────────────────────────────

const ExperienceType = {
  POSITIVE: 'positive',
  NEGATIVE: 'negative',
};

// ─── Experience Categories ────────────────────────────────────────────────────

const ExperienceCategory = {
  // ── Original categories ──
  MODULE_USAGE:      'module_usage',
  FRAMEWORK_LIMIT:   'framework_limit',
  STABLE_PATTERN:    'stable_pattern',
  PITFALL:           'pitfall',
  PERFORMANCE:       'performance',
  DEBUG_TECHNIQUE:   'debug_technique',
  ARCHITECTURE:      'architecture',
  ENGINE_API:        'engine_api',
  // ── Extended categories for code scanning ──
  UTILITY_CLASS:     'utility_class',
  INTERFACE_DEF:     'interface_def',
  COMPONENT:         'component',
  WORKFLOW_PROCESS:  'workflow_process',
  FRAMEWORK_MODULE:  'framework_module',
  DATA_STRUCTURE:    'data_structure',
  PROCEDURE:         'procedure',
  NETWORK_PROTOCOL:  'network_protocol',
  CONFIG_SYSTEM:     'config_system',
  OBJECT_POOL:       'object_pool',
  EVENT_SYSTEM:      'event_system',
  RESOURCE_LOAD:     'resource_load',
  UI_PATTERN:        'ui_pattern',
  SOUND_SYSTEM:      'sound_system',
  ENTITY_SYSTEM:     'entity_system',
  LUA_PATTERN:       'lua_pattern',
  CSHARP_PATTERN:    'csharp_pattern',
  // ── P1 Code Snippets: category for reusable code patterns ──
  CODE_SNIPPET:      'code_snippet',
};

// ─── Universal (Project-Agnostic) Categories ──────────────────────────────────

const UNIVERSAL_CATEGORIES = new Set([
  ExperienceCategory.STABLE_PATTERN,
  ExperienceCategory.PERFORMANCE,
  ExperienceCategory.DEBUG_TECHNIQUE,
  ExperienceCategory.ARCHITECTURE,
  ExperienceCategory.PITFALL,
  ExperienceCategory.WORKFLOW_PROCESS,
  ExperienceCategory.INTERFACE_DEF,
  ExperienceCategory.DATA_STRUCTURE,
]);

// ─── Category Specificity Classification (for adaptive evolution threshold) ──

const GENERIC_CATEGORIES = new Set([
  ExperienceCategory.STABLE_PATTERN,
  ExperienceCategory.PERFORMANCE,
  ExperienceCategory.DEBUG_TECHNIQUE,
  ExperienceCategory.ARCHITECTURE,
  ExperienceCategory.PITFALL,
  ExperienceCategory.WORKFLOW_PROCESS,
  ExperienceCategory.CODE_SNIPPET,
]);

const FRAMEWORK_CATEGORIES = new Set([
  ExperienceCategory.FRAMEWORK_LIMIT,
  ExperienceCategory.FRAMEWORK_MODULE,
  ExperienceCategory.ENGINE_API,
  ExperienceCategory.MODULE_USAGE,
]);

// ─── Knowledge Layers (ADR-43) ─────────────────────────────────────────────

/**
 * Knowledge Layer Classification
 *
 * Inspired by the insight that knowledge has different ownership and maintenance patterns:
 * - PLATFORM: Component/platform knowledge (maintained by platform teams, not local experiences)
 * - DOMAIN: Business domain knowledge (maintained by domain experts, may be project-specific)
 * - PRACTICE: Practical experience knowledge (captured from real sessions, most valuable)
 *
 * This stratification prevents the experience store from being flooded with:
 * - Framework documentation (belongs in PLATFORM layer)
 * - API references (belongs in PLATFORM layer)
 * - Business rules (belongs in DOMAIN layer)
 *
 * And focuses on capturing:
 * - Pitfalls encountered (PRACTICE layer)
 * - Debug techniques discovered (PRACTICE layer)
 * - Workarounds found (PRACTICE layer)
 */
const KnowledgeLayer = {
  /** Component/platform knowledge: frameworks, libraries, APIs, tools */
  PLATFORM: 'platform',
  /** Business domain knowledge: rules, workflows, project-specific patterns */
  DOMAIN: 'domain',
  /** Practical experience: pitfalls, debug techniques, workarounds */
  PRACTICE: 'practice',
};

/**
 * Category → Layer mapping
 * Used to automatically classify experiences into layers.
 */
const CATEGORY_TO_LAYER = {
  // PLATFORM layer: framework/engine specific
  [ExperienceCategory.FRAMEWORK_LIMIT]: KnowledgeLayer.PLATFORM,
  [ExperienceCategory.FRAMEWORK_MODULE]: KnowledgeLayer.PLATFORM,
  [ExperienceCategory.ENGINE_API]: KnowledgeLayer.PLATFORM,
  [ExperienceCategory.MODULE_USAGE]: KnowledgeLayer.PLATFORM,
  [ExperienceCategory.UTILITY_CLASS]: KnowledgeLayer.PLATFORM,
  [ExperienceCategory.INTERFACE_DEF]: KnowledgeLayer.PLATFORM,
  [ExperienceCategory.COMPONENT]: KnowledgeLayer.PLATFORM,
  [ExperienceCategory.NETWORK_PROTOCOL]: KnowledgeLayer.PLATFORM,
  [ExperienceCategory.EVENT_SYSTEM]: KnowledgeLayer.PLATFORM,
  [ExperienceCategory.RESOURCE_LOAD]: KnowledgeLayer.PLATFORM,
  [ExperienceCategory.UI_PATTERN]: KnowledgeLayer.PLATFORM,
  [ExperienceCategory.SOUND_SYSTEM]: KnowledgeLayer.PLATFORM,
  [ExperienceCategory.ENTITY_SYSTEM]: KnowledgeLayer.PLATFORM,
  [ExperienceCategory.LUA_PATTERN]: KnowledgeLayer.PLATFORM,
  [ExperienceCategory.CSHARP_PATTERN]: KnowledgeLayer.PLATFORM,

  // DOMAIN layer: project/business specific
  [ExperienceCategory.WORKFLOW_PROCESS]: KnowledgeLayer.DOMAIN,
  [ExperienceCategory.CONFIG_SYSTEM]: KnowledgeLayer.DOMAIN,
  [ExperienceCategory.OBJECT_POOL]: KnowledgeLayer.DOMAIN,
  [ExperienceCategory.DATA_STRUCTURE]: KnowledgeLayer.DOMAIN,
  [ExperienceCategory.ARCHITECTURE]: KnowledgeLayer.DOMAIN,

  // PRACTICE layer: actionable experience
  [ExperienceCategory.PITFALL]: KnowledgeLayer.PRACTICE,
  [ExperienceCategory.DEBUG_TECHNIQUE]: KnowledgeLayer.PRACTICE,
  [ExperienceCategory.STABLE_PATTERN]: KnowledgeLayer.PRACTICE,
  [ExperienceCategory.PERFORMANCE]: KnowledgeLayer.PRACTICE,
  [ExperienceCategory.CODE_SNIPPET]: KnowledgeLayer.PRACTICE,
  [ExperienceCategory.PROCEDURE]: KnowledgeLayer.PRACTICE,
};

/**
 * Get the knowledge layer for a given category.
 * @param {string} category - ExperienceCategory value
 * @returns {string} KnowledgeLayer value
 */
function getLayerForCategory(category) {
  return CATEGORY_TO_LAYER[category] || KnowledgeLayer.PRACTICE;
}

/**
 * Categories that are preferred for experience capture.
 * Experiences in these categories are more likely to be actionable.
 */
const PREFERRED_CAPTURE_CATEGORIES = new Set([
  ExperienceCategory.PITFALL,
  ExperienceCategory.DEBUG_TECHNIQUE,
  ExperienceCategory.STABLE_PATTERN,
  ExperienceCategory.PERFORMANCE,
]);

module.exports = {
  ExperienceType,
  ExperienceCategory,
  UNIVERSAL_CATEGORIES,
  GENERIC_CATEGORIES,
  FRAMEWORK_CATEGORIES,
  // ADR-43: Knowledge Layer
  KnowledgeLayer,
  CATEGORY_TO_LAYER,
  getLayerForCategory,
  PREFERRED_CAPTURE_CATEGORIES,
};
