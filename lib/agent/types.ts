/**
 * Agent 平台共享类型定义。
 * 文档依据：docs/AGENT_PLATFORM_TECHNICAL_DESIGN.md
 * 概念：平台 Agent（company）、员工 Agent（employee）、Skill、Run、Event。
 */

export type AgentType = 'company' | 'employee';
export type AgentStatus = 'draft' | 'active' | 'disabled';
export type SkillStatus = 'draft' | 'published' | 'disabled';
export type RunStatus =
  | 'queued'
  | 'planning'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type ChatRole = 'system' | 'user' | 'assistant';

/** 模型提供商 */
export type ModelProvider = 'kimi' | 'deepseek';

/** 单个模型消息（与供应商无关的规范格式） */
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** Agent 记录（对应 agents 表） */
export interface AgentRecord {
  id: string;
  agentType: AgentType;
  employeeId: string | null;
  name: string;
  systemInstructions: string;
  modelProvider: ModelProvider;
  modelName: string;
  config: AgentConfig;
  status: AgentStatus;
  version: number;
  createdAt?: string;
  updatedAt?: string;
}

/** Agent 运行时配置（config_json） */
export interface AgentConfig {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** 成本/Token 上限（本次根任务内） */
  maxPromptTokens?: number;
  /** 单任务最大委派子任务数 */
  maxDelegations?: number;
  /** 优点使用策略（可选覆盖） */
  strengthStrategy?: string;
  /** 缺点/不擅长对应的行为约束 */
  weaknessGuards?: string[];
  keywords?: string[];
  department?: string;
  role?: string;
}

/** 员工档案（兼容读取 employee_profiles） */
export interface EmployeeProfile {
  summary: string;
  traits: string[];
  expertise: string;
  strengths: string[];
  weaknesses: string[];
  bestFor: string[];
  skills: LegacySkill[];
  nationality?: string;
  age?: number | '';
  keywords?: string[];
  notGoodAt?: string[];
  career?: string[];
}

/** 旧档案里的 Skill 项 */
export interface LegacySkill {
  name: string;
  description?: string;
  desc: string;
}

/** Skill 记录（对应 skills 表） */
export interface SkillRecord {
  id: string;
  name: string;
  summary: string;
  instructions: string;
  inputSchema?: Record<string, unknown> | null;
  outputSchema?: Record<string, unknown> | null;
  examples?: SkillExample[] | null;
  status: SkillStatus;
  version: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface SkillExample {
  input: string;
  output: string;
}

/** agent_skills 关联 */
export interface AgentSkillLink {
  agentId: string;
  skillId: string;
  priority: number;
  customInstructions: string | null;
  enabled: boolean;
}

/** Run 记录（对应 agent_runs 表） */
export interface AgentRun {
  id: string;
  parentRunId: string | null;
  rootRunId: string;
  conversationId: string;
  agentId: string;
  skillId: string | null;
  status: RunStatus;
  inputText: string;
  outputText: string | null;
  errorText: string | null;
  modelName: string | null;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  createdAt?: string;
  finishedAt?: string | null;
}

/** 一次 Run 的事件（对应 agent_run_events 表） */
export interface AgentRunEvent {
  id: number;
  runId: string;
  eventType: string;
  payload: Record<string, unknown> | null;
  createdAt?: string;
}

/** 结构化 Plan：平台 Agent 规划器的输出 */
export type PlanAction = 'answer' | 'ask' | 'delegate';

export interface PlanAssignment {
  agentId: string;
  skillId?: string;
  task: string;
  dependsOn: string[];
}

export interface Plan {
  action: PlanAction;
  reason: string;
  /** 直接回答（answer）时的答复要点 */
  draftAnswer?: string;
  /** 追问（ask）时的问题 */
  question?: string;
  /** 委派（delegate）时的子任务 */
  assignments: PlanAssignment[];
  /** 委派时建议的群名（前端据此自动拉群，用户可改名） */
  groupName?: string;
  /** 委派后是否需要在最后做一次汇总发言；false 时跳过汇总模型调用以省 Token */
  synthesize?: boolean;
}

/** 员工候选（候选召回结果） */
export interface CandidateAgent {
  agentId: string;
  name: string;
  role: string;
  department: string;
  keywords: string[];
  skillNames: string[];
  summary: string;
}

/** 一次模型调用统计 */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** 模型生成结果 */
export interface GenerateResult {
  text: string;
  usage: Usage;
  modelName: string;
}

/** 工具定义（Phase 3） */
export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  permission: 'read' | 'write';
  enabled: boolean;
}

/** 记忆记录（Phase 3） */
export interface MemoryRecord {
  id: string;
  agentId: string;
  kind: 'long_term' | 'preference' | 'task_context' | 'summary';
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt?: string;
}
