/**
 * 轻量运行时校验（不引入 zod，保持零新依赖）。
 * 所有 API 使用统一错误结构 { code, message, details?, requestId }（docs §8）。
 */
import type { Plan, PlanAssignment } from '@/lib/agent/types';

/** API 统一错误 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function errorBody(error: ApiError | Error, requestId: string): { code: string; message: string; details?: unknown; requestId: string } {
  if (error instanceof ApiError) {
    return { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}), requestId };
  }
  // 未知错误：完整信息只写服务端日志，客户端只返回脱敏信息，避免泄露 SQL / 供应商 / 内部配置
  console.error(`[request ${requestId}] unhandled error:`, error);
  return { code: 'internal', message: '服务暂时不可用', requestId };
}

/** Agent 可执行性校验：生产运行只允许 active；draft 仅在 preview 模式放行；disabled 一律拒绝。 */
export function assertAgentRunnable(status: string, preview = false): void {
  if (status === 'active') return;
  if (status === 'draft' && preview) return;
  if (status === 'draft') throw new ApiError('agent_draft', '该 Agent 处于草稿状态，不能执行生产任务（需 preview 模式）', 403);
  if (status === 'disabled') throw new ApiError('agent_disabled', '该 Agent 已停用', 403);
  throw new ApiError('agent_invalid_status', `未知的 Agent 状态: ${status}`, 403);
}

/** Skill 可加载性校验：必须存在且为 published（未绑定/禁用/不存在均报结构化错误）。 */
export function requireAvailableSkill(skill: { status?: string } | null | undefined, skillId: string): void {
  if (!skill || skill.status !== 'published') {
    throw new ApiError('skill_not_available', `Skill 不存在、未发布或未启用: ${skillId}`, 400);
  }
}

/** 纯函数汇总多次调用 Token（用于并行执行后的确定性合并，避免共享状态竞争）。 */
export function sumUsage(usages: Array<{ promptTokens: number; completionTokens: number; totalTokens: number } | null | undefined>): { promptTokens: number; completionTokens: number; totalTokens: number } {
  const acc = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  for (const u of usages) {
    if (!u) continue;
    acc.promptTokens += u.promptTokens;
    acc.completionTokens += u.completionTokens;
    acc.totalTokens += u.totalTokens;
  }
  return acc;
}

export function newRequestId(): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `req_${rnd}`;
}

export function newRunId(): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `run_${rnd}`;
}

export function newSkillId(): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `sk_${rnd}`;
}

export function newAgentId(prefix: 'agent' | 'emp'): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${rnd}`;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 校验一次任务启动请求（docs §5.1） */
export function validateRunRequest(body: unknown): { conversationId: string; agentId: string; message: string; mode?: 'fast' | 'deep'; preview?: boolean } {
  if (!isPlainObject(body)) throw new ApiError('invalid_request', '请求体必须是 JSON 对象');
  const conversationId = body.conversationId;
  const agentId = body.agentId;
  const message = body.message;
  if (typeof conversationId !== 'string' || !conversationId) throw new ApiError('invalid_conversation', '缺少 conversationId');
  if (typeof agentId !== 'string' || !agentId) throw new ApiError('invalid_agent', '缺少 agentId');
  if (typeof message !== 'string' || !message.trim()) throw new ApiError('invalid_message', 'message 不能为空');
  const mode = body.mode;
  if (mode !== undefined && mode !== 'fast' && mode !== 'deep') throw new ApiError('invalid_mode', 'mode 只能是 fast 或 deep');
  const preview = body.preview === true;
  return { conversationId, agentId, message: message.slice(0, 20_000), mode, preview };
}

/** 校验 Agent 记录（创建/更新） */
export function validateAgentPayload(body: unknown, isCreate: boolean): {
  id?: string; agentType: 'company' | 'employee'; employeeId?: string | null; name: string;
  systemInstructions?: string; modelProvider?: string; modelName?: string; config?: Record<string, unknown>;
  status?: string; version?: number;
} {
  if (!isPlainObject(body)) throw new ApiError('invalid_request', '请求体必须是 JSON 对象');
  const agentType = body.agentType;
  if (agentType !== 'company' && agentType !== 'employee') throw new ApiError('invalid_agent_type', 'agentType 必须是 company 或 employee');
  const name = body.name;
  if (typeof name !== 'string' || !name.trim()) throw new ApiError('invalid_name', 'name 不能为空');
  if (body.employeeId !== undefined && body.employeeId !== null && typeof body.employeeId !== 'string') throw new ApiError('invalid_employee', 'employeeId 必须是字符串或 null');
  if (body.modelProvider !== undefined && body.modelProvider !== 'kimi' && body.modelProvider !== 'deepseek') throw new ApiError('invalid_provider', 'modelProvider 必须是 kimi 或 deepseek');
  if (body.systemInstructions !== undefined && typeof body.systemInstructions !== 'string') throw new ApiError('invalid_instructions', 'systemInstructions 必须是字符串');
  const agentStatus = typeof body.status === 'string' ? body.status : undefined;
  if (agentStatus !== undefined && !['draft', 'active', 'disabled'].includes(agentStatus)) throw new ApiError('invalid_status', 'status 必须是 draft/active/disabled');
  if (isCreate && body.id !== undefined && typeof body.id !== 'string') throw new ApiError('invalid_id', 'id 必须是字符串');
  if (body.config !== undefined && !isPlainObject(body.config)) throw new ApiError('invalid_config', 'config 必须是对象');
  if (body.version !== undefined && typeof body.version !== 'number') throw new ApiError('invalid_version', 'version 必须是数字');
  return {
    id: body.id as string | undefined,
    agentType,
    employeeId: (body.employeeId as string | null | undefined) ?? null,
    name: name.trim(),
    systemInstructions: body.systemInstructions as string | undefined,
    modelProvider: body.modelProvider as string | undefined,
    modelName: body.modelName as string | undefined,
    config: body.config as Record<string, unknown> | undefined,
    status: agentStatus,
    version: body.version as number | undefined,
  };
}

/** 校验 Skill 记录（创建/更新），含 200,000 字符上限 */
export function validateSkillPayload(body: unknown, isCreate: boolean): {
  id?: string; name: string; summary?: string; instructions?: string;
  inputSchema?: Record<string, unknown> | null; outputSchema?: Record<string, unknown> | null;
  examples?: Array<{ input: string; output: string }> | null; status?: string; version?: number;
} {
  if (!isPlainObject(body)) throw new ApiError('invalid_request', '请求体必须是 JSON 对象');
  const name = body.name;
  const summary = typeof body.summary === 'string' ? body.summary : undefined;
  const instructions = typeof body.instructions === 'string' ? body.instructions : undefined;
  if (typeof name !== 'string' || !name.trim() || name.length > 150) throw new ApiError('invalid_name', 'name 不能为空且不超过 150 字符');
  if (summary !== undefined && summary.length > 500) throw new ApiError('invalid_summary', 'summary 必须是字符串且不超过 500 字符');
  if (instructions !== undefined && instructions.length > 200_000) throw new ApiError('instructions_too_long', 'instructions 不能超过 200,000 字符');
  const skillStatus = typeof body.status === 'string' ? body.status : undefined;
  if (skillStatus !== undefined && !['draft', 'published', 'disabled'].includes(skillStatus)) throw new ApiError('invalid_status', 'status 必须是 draft/published/disabled');
  if (isCreate && body.id !== undefined && typeof body.id !== 'string') throw new ApiError('invalid_id', 'id 必须是字符串');
  if (body.inputSchema !== undefined && body.inputSchema !== null && !isPlainObject(body.inputSchema)) throw new ApiError('invalid_schema', 'inputSchema 必须是对象');
  if (body.outputSchema !== undefined && body.outputSchema !== null && !isPlainObject(body.outputSchema)) throw new ApiError('invalid_schema', 'outputSchema 必须是对象');
  if (body.examples !== undefined && body.examples !== null && !Array.isArray(body.examples)) throw new ApiError('invalid_examples', 'examples 必须是数组');
  if (body.version !== undefined && typeof body.version !== 'number') throw new ApiError('invalid_version', 'version 必须是数字');
  return {
    id: body.id as string | undefined,
    name: name.trim(),
    summary,
    instructions,
    inputSchema: body.inputSchema as Record<string, unknown> | null | undefined,
    outputSchema: body.outputSchema as Record<string, unknown> | null | undefined,
    examples: body.examples as Array<{ input: string; output: string }> | null | undefined,
    status: skillStatus,
    version: body.version as number | undefined,
  };
}

/* ---------- Plan 校验（docs §5.2） ---------- */

export function validatePlan(raw: unknown): Plan | null {
  if (!isPlainObject(raw)) return null;
  const action = raw.action;
  if (action !== 'answer' && action !== 'ask' && action !== 'delegate') return null;
  const reason = typeof raw.reason === 'string' ? raw.reason.slice(0, 1000) : '';
  const assignments: PlanAssignment[] = [];
  if (Array.isArray(raw.assignments)) {
    const seen = new Set<string>();
    for (const a of raw.assignments) {
      if (!isPlainObject(a)) continue;
      const agentId = typeof a.agentId === 'string' ? a.agentId.trim() : '';
      const task = typeof a.task === 'string' ? a.task.trim() : '';
      if (!agentId || !task || seen.has(agentId)) continue;
      seen.add(agentId);
      assignments.push({
        agentId,
        skillId: typeof a.skillId === 'string' && a.skillId ? a.skillId : undefined,
        task,
        dependsOn: Array.isArray(a.dependsOn) ? a.dependsOn.filter((d): d is string => typeof d === 'string') : [],
      });
    }
  }
  if (assignments.length > 5) assignments.length = 5; // 单次根任务最多委派 5 个子任务
  if (action === 'delegate' && assignments.length === 0) return null;
  return {
    action,
    reason,
    draftAnswer: typeof raw.draftAnswer === 'string' ? raw.draftAnswer : undefined,
    question: typeof raw.question === 'string' ? raw.question : undefined,
    assignments,
    groupName: typeof raw.groupName === 'string' ? raw.groupName.trim().slice(0, 60) : undefined,
    synthesize: typeof raw.synthesize === 'boolean' ? raw.synthesize : undefined,
  };
}
