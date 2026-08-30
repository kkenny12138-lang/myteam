/**
 * Tool Registry 与执行器（Phase 3）。
 * - 内置工具在 BUILTIN_TOOLS 注册（只读为主）
 * - write 权限工具必须显式确认（requireConfirmation）后才执行（docs §5.5）
 * - 工具调用写入 agent_run_events
 */
import { getToolById, listAgentTools } from '@/lib/repositories/tools';
import { listAgentSkills } from '@/lib/repositories/skills';
import { getEmployeeProfile } from '@/lib/agent/context-builder';
import { appendRunEvent } from '@/lib/repositories/runs';
import type { ToolDefinition } from '@/lib/agent/types';

export interface BuiltinToolHandler {
  definition: ToolDefinition;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

export interface ToolContext {
  agentId: string;
  runId?: string;
  confirmed?: boolean;
}

export interface ExecuteToolResult {
  ok: boolean;
  requiresConfirmation?: boolean;
  data?: unknown;
  error?: string;
}

/** 内置工具注册表（read） */
export const BUILTIN_TOOLS: BuiltinToolHandler[] = [
  {
    definition: {
      id: 'builtin.agent_skills',
      name: '查询员工 Skill',
      description: '查询指定 Agent 当前已发布并绑定的 Skill 清单（只读）。参数：agentId。',
      inputSchema: { type: 'object', properties: { agentId: { type: 'string' } }, required: ['agentId'] },
      permission: 'read',
      enabled: true,
    },
    handler: async (args, ctx) => {
      const agentId = String(args.agentId || ctx.agentId);
      const skills = await listAgentSkills(agentId);
      return skills.map((s) => ({ id: s.id, name: s.name, summary: s.summary, status: s.status }));
    },
  },
  {
    definition: {
      id: 'builtin.agent_profile',
      name: '查询员工档案',
      description: '查询指定员工的基础档案摘要（只读）。参数：employeeId。',
      inputSchema: { type: 'object', properties: { employeeId: { type: 'string' } }, required: ['employeeId'] },
      permission: 'read',
      enabled: true,
    },
    handler: async (args) => {
      const employeeId = String(args.employeeId);
      const profile = await getEmployeeProfile(employeeId);
      if (!profile) return null;
      return {
        summary: profile.summary,
        expertise: profile.expertise,
        strengths: profile.strengths,
        weaknesses: profile.weaknesses,
        notGoodAt: profile.notGoodAt,
      };
    },
  },
  {
    definition: {
      id: 'builtin.notify',
      name: '发送站内通知',
      description: '向用户发送一条站内通知（写操作，需要确认）。参数：title, content。',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string' }, content: { type: 'string' } },
        required: ['title', 'content'],
      },
      permission: 'write',
      enabled: true,
    },
    handler: async (args) => {
      // 实际业务可对接通知渠道；此处返回已受理标记
      return { delivered: true, title: String(args.title), content: String(args.content).slice(0, 500) };
    },
  },
];

/** 执行一个工具：写操作且未确认时返回 requiresConfirmation。 */
export async function executeTool(toolId: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ExecuteToolResult> {
  const definition = (await getToolById(toolId)) ?? BUILTIN_TOOLS.find((t) => t.definition.id === toolId)?.definition ?? null;
  if (!definition || !definition.enabled) return { ok: false, error: `工具不存在或已停用: ${toolId}` };

  if (definition.permission === 'write' && !ctx.confirmed) {
    await appendRunEvent(ctx.runId || 'n/a', 'tool_requires_confirmation', { toolId, toolName: definition.name, args });
    return { ok: false, requiresConfirmation: true, data: { toolId, toolName: definition.name } };
  }

  const handler = BUILTIN_TOOLS.find((t) => t.definition.id === toolId)?.handler;
  if (!handler) return { ok: false, error: `该工具没有可用的执行器: ${toolId}` };

  try {
    const data = await handler(args, ctx);
    await appendRunEvent(ctx.runId || 'n/a', 'tool_executed', { toolId, args, permission: definition.permission });
    return { ok: true, data };
  } catch (error) {
    await appendRunEvent(ctx.runId || 'n/a', 'tool_failed', { toolId, error: error instanceof Error ? error.message : String(error) });
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 列出某 Agent 可用的全部工具（绑定 + 内置只读工具） */
export async function listUsableTools(agentId: string): Promise<ToolDefinition[]> {
  const bound = await listAgentTools(agentId);
  const boundIds = new Set(bound.map((t) => t.id));
  const builtinRead = BUILTIN_TOOLS.map((t) => t.definition).filter((t) => t.permission === 'read');
  for (const t of builtinRead) {
    if (!boundIds.has(t.id)) bound.push(t);
  }
  return bound;
}
