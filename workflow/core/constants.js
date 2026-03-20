/**
 * Global constants for the multi-agent workflow system.
 */

const path = require('path');

// ─── Directory Layout ──────────────────────────────────────────────────────────

/** Root directory of the workflow system (resolved at runtime) */
const WORKFLOW_ROOT = path.resolve(__dirname, '..');

const PATHS = {
  /** Persistent checkpoint file – written on every state transition */
  MANIFEST: path.join(WORKFLOW_ROOT, 'manifest.json'),
  /** All agent-produced artifact files land here */
  OUTPUT_DIR: path.join(WORKFLOW_ROOT, 'output'),
  /** Agent implementation modules */
  AGENTS_DIR: path.join(WORKFLOW_ROOT, 'agents'),
  /** Skills SOP markdown files */
  SKILLS_DIR: path.join(WORKFLOW_ROOT, 'skills'),
  /** Command handler modules */
  COMMANDS_DIR: path.join(WORKFLOW_ROOT, 'commands'),
  /** Hook handler modules */
  HOOKS_DIR: path.join(WORKFLOW_ROOT, 'hooks'),
  /** Thin/thick tool adapters */
  TOOLS_DIR: path.join(WORKFLOW_ROOT, 'tools'),
  /** Global memory context file */
  AGENTS_MD: path.join(WORKFLOW_ROOT, '..', 'AGENTS.md'),
  /** AgentFlow: persistent task list */
  TASKS_JSON: path.join(WORKFLOW_ROOT, 'output', 'tasks.json'),
  /** AgentFlow: persistent experience store */
  EXPERIENCES_JSON: path.join(WORKFLOW_ROOT, 'output', 'experiences.json'),
  /** AgentFlow: complaint wall */
  COMPLAINTS_JSON: path.join(WORKFLOW_ROOT, 'output', 'complaints.json'),
  /** AgentFlow: skill registry */
  SKILL_REGISTRY_JSON: path.join(WORKFLOW_ROOT, 'output', 'skill-registry.json'),
  /** Cross-session metrics history (JSONL) */
  METRICS_HISTORY_JSONL: path.join(WORKFLOW_ROOT, 'output', 'metrics-history.jsonl'),
  /** Structured code graph index */
  CODE_GRAPH_JSON: path.join(WORKFLOW_ROOT, 'output', 'code-graph.json'),
  /** Code graph markdown summary */
  CODE_GRAPH_MD: path.join(WORKFLOW_ROOT, 'output', 'code-graph.md'),
  /** Git PR description file (written by GitIntegration.createPR) */
  PR_DESCRIPTION_MD: path.join(WORKFLOW_ROOT, 'output', 'pr-description.md'),
  /** Dry-run sandbox report (written when dryRun: true) */
  DRYRUN_REPORT_MD: path.join(WORKFLOW_ROOT, 'output', 'dry-run-report.md'),
  /** HTML session report (interactive visualisation) */
  HTML_REPORT: path.join(WORKFLOW_ROOT, 'output', 'session-report.html'),
  /** LLM query expansion synonym/alias table (auto-accumulated, persistent) */
  SYNONYM_TABLE_JSON: path.join(WORKFLOW_ROOT, 'output', 'synonym-table.json'),
  /** Prompt A/B variant registry (auto-managed by PromptSlotManager) */
  PROMPT_VARIANTS_JSON: path.join(WORKFLOW_ROOT, 'output', 'prompt-variants.json'),
};

// ─── Output Artifact File Names ────────────────────────────────────────────────

const ARTIFACTS = {
  REQUIREMENT_MD: 'requirement.md',
  ARCHITECTURE_MD: 'architecture.md',
  EXECUTION_PLAN_MD: 'execution-plan.md',
  CODE_DIFF: 'code.diff',
  TEST_REPORT_MD: 'test-report.md',
};

// ─── LLM / Token Thresholds ────────────────────────────────────────────────────

const LLM = {
  /**
   * Token count above which a hallucination-risk warning is emitted.
   *
   * Rationale (R1-1 audit): previously 8000, which was far too conservative for
   * modern 128K–200K context-window models. At 8K, the degradation logic in
   * prompt-builder.js frequently stripped valuable skill/ADR context, reducing
   * output quality. 16K keeps a healthy safety margin while allowing the full
   * 3-layer skill injection + ADR digest + code graph to fit without degradation.
   */
  HALLUCINATION_RISK_THRESHOLD: 16000,
  /** Approximate chars-per-token ratio used for quick estimation */
  CHARS_PER_TOKEN: 4,
};

// ─── Project Scale Thresholds ─────────────────────────────────────────────────

const PROJECT_SCALE = {
  /** File count above which the project is treated as a large Monorepo */
  MONOREPO_FILE_THRESHOLD: 500,
};

// ─── Hook Event Names ─────────────────────────────────────────────────────────

const HOOK_EVENTS = {
  BEFORE_STATE_TRANSITION: 'before_state_transition',
  AFTER_STATE_TRANSITION: 'after_state_transition',
  AGENT_BOUNDARY_VIOLATION: 'agent_boundary_violation',
  HUMAN_REVIEW_REQUIRED: 'human_review_required',
  WORKFLOW_COMPLETE: 'workflow_complete',
  WORKFLOW_ERROR: 'workflow_error',
  // AgentFlow events
  TASK_CLAIMED:       'task_claimed',        // An agent claimed a task
  TASK_COMPLETED:     'task_completed',      // A task was completed
  TASK_FAILED:        'task_failed',         // A task failed
  TASK_INTERRUPTED:   'task_interrupted',    // A task was interrupted
  EXPERIENCE_RECORDED:'experience_recorded', // A new experience was saved
  SKILL_EVOLVED:      'skill_evolved',       // A skill was evolved
  SKILL_AUTO_CREATED:  'skill_auto_created',  // A new skill was auto-created from orphan experience (P1)
  COMPLAINT_FILED:    'complaint_filed',     // A complaint was filed
  COMPLAINT_RESOLVED: 'complaint_resolved',  // A complaint was resolved
  // Observability events
  STAGE_STARTED:      'stage_started',       // A workflow stage started
  STAGE_ENDED:        'stage_ended',         // A workflow stage ended
  STAGE_ARTIFACT_PRODUCED: 'stage_artifact_produced', // A stage produced an output artifact
  LLM_CALL_RECORDED:  'llm_call_recorded',   // An LLM call was recorded
  // CI integration events
  CI_PIPELINE_STARTED:  'ci_pipeline_started',
  CI_PIPELINE_COMPLETE: 'ci_pipeline_complete',
  CI_PIPELINE_FAILED:   'ci_pipeline_failed',
  // Code graph events
  CODE_GRAPH_BUILT:     'code_graph_built',
  CODE_GRAPH_QUERIED:   'code_graph_queried',
  // Git PR workflow events
  GIT_BRANCH_CREATED:   'git_branch_created',   // A feature branch was created
  GIT_BRANCH_PUSHED:    'git_branch_pushed',     // Branch pushed to remote
  GIT_PR_CREATED:       'git_pr_created',        // PR/MR created (or description saved)
  GIT_PR_MERGED:        'git_pr_merged',         // PR/MR merged
  // Dry-run / sandbox events
  DRYRUN_STARTED:       'dryrun_started',        // Dry-run mode activated
  DRYRUN_OP_RECORDED:   'dryrun_op_recorded',    // A file operation was intercepted
  DRYRUN_REPORT_SAVED:  'dryrun_report_saved',   // Dry-run report written to disk
  DRYRUN_APPLIED:       'dryrun_applied',        // Pending ops applied to real FS
  // Prompt A/B testing events
  PROMPT_VARIANT_PROMOTED:  'prompt_variant_promoted',   // A variant outperformed the active and was promoted
  PROMPT_VARIANT_ROLLEDBACK:'prompt_variant_rolledback', // Active variant rolled back to baseline after failures
  // HTML report events
  HTML_REPORT_GENERATED:    'html_report_generated',     // HTML session report generated
  // Optimistic lock events
  FILE_LOCK_CONFLICT:       'file_lock_conflict',        // Optimistic lock conflict detected during parallel edit
  // Agent Negotiation Protocol events (P1-2, ADR-40)
  NEGOTIATE_REQUEST:        'negotiate_request',         // Downstream agent raises a concern about upstream artifact
  NEGOTIATE_RESPONSE:       'negotiate_response',        // Orchestrator responds with a resolution
};

module.exports = {
  WORKFLOW_ROOT,
  PATHS,
  ARTIFACTS,
  LLM,
  PROJECT_SCALE,
  HOOK_EVENTS,
};
