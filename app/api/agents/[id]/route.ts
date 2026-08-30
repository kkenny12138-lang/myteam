/**
 * GET/PATCH /api/agents/[id] — Agent 配置与版本更新（docs §8）。
 * PATCH 使用乐观锁：请求携带 version，WHERE id=? AND version=?。
 */
import { getAgentById, updateAgent } from '@/lib/repositories/agents';
import { ApiError, errorBody, newRequestId, validateAgentPayload } from '@/lib/agent/validators';
import type { AgentRecord } from '@/lib/agent/types';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    const { id } = await params;
    const agent = await getAgentById(id);
    if (!agent) throw new ApiError('agent_not_found', `Agent 不存在: ${id}`, 404);
    return Response.json({ requestId, agent });
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    return Response.json(errorBody(error instanceof Error ? error : new Error('服务暂时不可用'), requestId), { status });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    const { id } = await params;
    const body = await request.json();
    const payload = validateAgentPayload(body, false);
    const existing = await getAgentById(id);
    if (!existing) throw new ApiError('agent_not_found', `Agent 不存在: ${id}`, 404);
    const expectedVersion = payload.version ?? existing.version;
    const ok = await updateAgent(
      id,
      {
        name: payload.name,
        systemInstructions: payload.systemInstructions,
        modelProvider: payload.modelProvider as 'kimi' | 'deepseek' | undefined,
        modelName: payload.modelName,
        config: payload.config as AgentRecord['config'] | undefined,
        status: payload.status as AgentRecord['status'] | undefined,
      },
      expectedVersion
    );
    if (!ok) throw new ApiError('version_conflict', '版本冲突：该 Agent 已被他人更新，请刷新后重试', 409);
    const agent = await getAgentById(id);
    return Response.json({ requestId, agent });
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    return Response.json(errorBody(error instanceof Error ? error : new Error('服务暂时不可用'), requestId), { status });
  }
}
