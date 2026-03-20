/**
 * TypeScript Type Declarations for CodexForge Workflow (P1-6, Verou)
 *
 * Provides type declarations for the public API surface of the workflow module.
 * Enables TypeScript users to get IntelliSense, type checking, and auto-completion
 * when integrating CodexForge into their projects.
 *
 * Covers: Orchestrator, HookSystem, LlmRouter, StateMachine, CommandRouter, Logger
 */

// ─── Core Types ──────────────────────────────────────────────────────────────

export type WorkflowState = 'INIT' | 'ANALYSE' | 'ARCHITECT' | 'PLAN' | 'CODE' | 'TEST' | 'FINISHED';
export type AgentRole = 'ANALYST' | 'ARCHITECT' | 'PLANNER' | 'DEVELOPER' | 'TESTER';
export type ExperienceType = 'positive' | 'negative';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type ComplaintSeverity = 'frustrating' | 'annoying' | 'minor';
export type ComplaintTarget = 'experience' | 'skill' | 'workflow' | 'tool';
export type RiskLevel = 'low' | 'medium' | 'high';

// ─── Manifest ────────────────────────────────────────────────────────────────

export interface ManifestArtifacts {
  requirementDoc: string | null;
  architectureDoc: string | null;
  executionPlanMd: string | null;
  codeDiff: string | null;
  testReport: string | null;
  [key: string]: string | null;
}

export interface HistoryEntry {
  fromState: WorkflowState;
  toState: WorkflowState;
  timestamp: string;
  artifactPath: string | null;
  note: string;
}

export interface Risk {
  level: RiskLevel;
  message: string;
  timestamp: string;
}

export interface Manifest {
  projectId: string;
  version: string;
  currentState: WorkflowState;
  artifacts: ManifestArtifacts;
  history: HistoryEntry[];
  risks: Risk[];
  createdAt: string;
  updatedAt: string;
  lastRollback: { fromState: WorkflowState; toState: WorkflowState; reason: string; timestamp: string } | null;
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

export interface OrchestratorOptions {
  projectId: string;
  llmCall: (prompt: string) => Promise<string>;
  projectRoot?: string;
  manifestPath?: string;
  outputDir?: string;
  hooks?: HookDefinition[];
  mcpAdapters?: any[];
  config?: Record<string, any>;
}

export interface TaskDef {
  id: string;
  title: string;
  deps: string[];
}

export declare class Orchestrator {
  constructor(opts: OrchestratorOptions);

  /** Run full sequential pipeline: ANALYSE → ARCHITECT → PLAN → CODE → TEST */
  run(requirement: string): Promise<void>;

  /** Smart auto-dispatch: LLM decides sequential vs parallel */
  runAuto(requirement: string, concurrency?: number): Promise<void>;

  /** Run via parallel task-based execution */
  runTaskBased(goal: string, taskDefs: TaskDef[], concurrency?: number): Promise<void>;

  /** Get system status summary */
  getSystemStatus(): string;

  /** Record an experience */
  recordExperience(exp: {
    type: ExperienceType;
    category: string;
    title: string;
    content: string;
    skill?: string | null;
  }): { id: string; title: string };

  /** File a complaint */
  fileComplaint(complaint: {
    targetType: ComplaintTarget;
    targetId: string;
    severity: ComplaintSeverity;
    description: string;
    suggestion: string;
  }): { id: string; severity: string; description: string };

  readonly experienceStore: ExperienceStore;
  readonly skillEvolution: SkillEvolution;
  readonly complaintWall: ComplaintWall;
  readonly taskManager: TaskManager;
  readonly mcpRegistry: any;
}

// ─── State Machine ───────────────────────────────────────────────────────────

export declare class StateMachine {
  constructor(opts: { projectId: string; hookEmitter?: (event: string, data: any) => Promise<void>; manifestPath?: string });

  getState(): WorkflowState;
  getNextState(): WorkflowState | null;
  getPreviousState(): WorkflowState | null;
  transition(artifactPath?: string | null, note?: string): Promise<WorkflowState>;
  rollback(reason?: string): Promise<WorkflowState>;
  jumpTo(targetState: WorkflowState, reason?: string): Promise<WorkflowState>;
  isTerminal(): boolean;
  recordRisk(level: RiskLevel, message: string, flush?: boolean): void;
  flushRisks(): void;

  readonly manifest: Manifest;
}

// ─── Hook System ─────────────────────────────────────────────────────────────

export interface HookDefinition {
  event: string;
  handler: (data: any) => Promise<void>;
  priority?: number;
}

export declare class HookSystem {
  register(event: string, handler: (data: any) => Promise<void>, priority?: number): void;
  emit(event: string, data: any): Promise<void>;
  listRegistered(): Array<{ event: string; count: number }>;
}

// ─── LLM Router ──────────────────────────────────────────────────────────────

export interface LlmRouterOptions {
  llmCall: (prompt: string) => Promise<string>;
  tierConfig?: Record<string, { model?: string; temperature?: number; maxTokens?: number }>;
}

export declare class LlmRouter {
  constructor(opts: LlmRouterOptions);
  route(prompt: string, opts?: { tier?: string; temperature?: number }): Promise<string>;
}

// ─── Command Router ──────────────────────────────────────────────────────────

export interface Command {
  name: string;
  description: string;
  handler: (args: string, context: Record<string, any>) => Promise<string>;
}

export declare function dispatch(input: string, context?: Record<string, any>): Promise<string>;
export declare function registerCommand(name: string, description: string, handler: Command['handler']): void;
export declare const COMMANDS: Record<string, Command>;

// ─── Logger ──────────────────────────────────────────────────────────────────

export interface LoggerOptions {
  outputDir?: string;
  minLevel?: LogLevel;
  jsonMode?: boolean;
  fileLogging?: boolean;
  sessionId?: string;
}

export declare class Logger {
  constructor(opts?: LoggerOptions);
  setOutputDir(outputDir: string): void;
  setSessionId(sessionId: string): void;
  debug(component: string, message: string, data?: Record<string, any>): void;
  info(component: string, message: string, data?: Record<string, any>): void;
  warn(component: string, message: string, data?: Record<string, any>): void;
  error(component: string, message: string, data?: Record<string, any>): void;
  flush(): number;
  getStats(): { entryCount: number; sessionId: string | null; minLevel: string; jsonMode: boolean; fileLogging: boolean };
}

export declare const logger: Logger;

// ─── Experience Store ────────────────────────────────────────────────────────

export interface Experience {
  id: string;
  type: ExperienceType;
  category: string;
  title: string;
  content: string;
  skill: string | null;
  tags: string[];
  hitCount: number;
  sourceFile?: string;
}

export interface ExperienceStore {
  search(opts: { keyword?: string; category?: string; skill?: string; type?: string; limit?: number; scoreSort?: boolean }): Experience[];
  getStats(): { total: number; positive: number; negative: number };
  getSynonymStats(): { entryCount: number; totalHits: number; coldStartPct: number; topEntries: any[] };
}

// ─── Skill Evolution ─────────────────────────────────────────────────────────

export interface Skill {
  name: string;
  version: number;
  description: string;
  evolutionCount: number;
  exportable?: boolean;
}

export interface SkillEvolution {
  listSkills(): Skill[];
}

// ─── Complaint Wall ──────────────────────────────────────────────────────────

export interface ComplaintWall {
  getSummaryText(): string;
}

// ─── Task Manager ────────────────────────────────────────────────────────────

export interface Task {
  id: string;
  title: string;
  status: 'done' | 'running' | 'pending' | 'blocked' | 'failed' | 'interrupted' | 'exhausted';
  deps: string[];
}

export interface TaskManager {
  getAllTasks(): Task[];
}

// ─── Manifest Migration ─────────────────────────────────────────────────────

export interface MigrationResult {
  manifest: Manifest;
  migrated: boolean;
  fromVersion: string;
  toVersion: string;
  appliedMigrations: string[];
}

export declare function migrateManifest(manifest: Manifest, opts?: { manifestPath?: string; backup?: boolean }): MigrationResult;
export declare function getCurrentVersion(): string;
export declare function listMigrations(): Array<{ from: string; to: string; description: string }>;

// ─── Negotiation Engine (P1-2) ───────────────────────────────────────────────

export type ConcernType = 'interface_mismatch' | 'tech_constraint' | 'scope_overflow' | 'quality_threshold';
export type Resolution = 'auto_approve' | 'targeted_rollback' | 'human_review' | 'suggestion_applied' | 'negotiation_failed';

export interface NegotiationRequest {
  fromStage: string;
  toStage: string;
  concernType: ConcernType;
  description: string;
  suggestion?: string;
  context?: Record<string, any>;
}

export interface NegotiationResult {
  resolution: Resolution;
  action: string;
  detail: string;
}

export interface NegotiationLogEntry {
  timestamp: string;
  fromStage: string;
  toStage: string;
  round: number;
  concernType: ConcernType;
  description: string;
  suggestion: string | null;
  result: NegotiationResult;
}

export declare class NegotiationEngine {
  constructor(opts?: { outputDir?: string; maxRounds?: number });
  negotiate(request: NegotiationRequest): NegotiationResult;
  getLog(): NegotiationLogEntry[];
  flush(): void;
  reset(): void;
}

// ─── Experience Router (P2-1) ────────────────────────────────────────────────

export interface ProjectRegistryEntry {
  projectId: string;
  projectRoot: string;
  techStack: string[];
  experiencePath: string;
  experienceCount: number;
  lastUpdated: string;
  qualityScore: number;
}

export interface DiscoveredExperiences {
  project: string;
  score: number;
  experienceCount: number;
  techStack: string[];
  experiences: Experience[];
}

export declare class ExperienceRouter {
  constructor(opts: {
    projectId: string;
    projectRoot: string;
    techStack?: string[];
    experienceStore?: ExperienceStore;
    registryPath?: string;
  });

  registerProject(opts: { experiencePath: string; experienceCount: number; qualityScore?: number }): void;
  discoverRelevant(opts?: { threshold?: number; maxResults?: number }): DiscoveredExperiences[];
  autoImport(opts?: { threshold?: number; maxImport?: number; conflictStrategy?: string }): { imported: number; sources: string[]; skipped: number };
  publish(opts?: { minHitCount?: number; outputDir?: string }): { published: number; path: string | null };
  getRegistrySummary(): { totalProjects: number; currentProject: string; techStack: string[]; projects: any[] };
}

// ─── Workflow Server (P2-3) ──────────────────────────────────────────────────

export type ServiceStatus = 'starting' | 'ready' | 'busy' | 'draining' | 'stopped';

export declare class WorkflowServer {
  constructor(opts: {
    port?: number;
    host?: string;
    orchestratorFactory: (opts: any) => Orchestrator;
    defaultOrchestratorOpts?: Record<string, any>;
  });

  start(): Promise<void>;
  stop(): Promise<void>;
  readonly status: ServiceStatus;
  readonly port: number;
}

// ─── Contracts (P2-4) ───────────────────────────────────────────────────────

export interface MethodSpec {
  name: string;
  minArity?: number;
  maxArity?: number;
  optional?: boolean;
}

export interface PropertySpec {
  name: string;
  type?: string;
  optional?: boolean;
}

export interface ContractSpec {
  name: string;
  description: string;
  methods: MethodSpec[];
  properties?: PropertySpec[];
}

export declare function assertContract(contract: ContractSpec, instance: any, opts?: { strict?: boolean }): { valid: boolean; violations: string[] };
export declare function validateContract(contractName: string, instance: any, opts?: { strict?: boolean }): { valid: boolean; violations: string[] };
export declare function listContracts(): string[];

// ─── Stage Context Store (updated P2-2) ─────────────────────────────────────

export interface StageContextStoreOptions {
  outputDir?: string;
  verbose?: boolean;
  maxEntries?: number;
  maxTotalChars?: number;
}

export interface LruStats {
  entries: number;
  totalChars: number;
  maxEntries: number;
  maxTotalChars: number;
}
