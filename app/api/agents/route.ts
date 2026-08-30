/**
 * GET/POST /api/agents — Agent 列表 / 创建（docs §8）。
 */
import { listAgents, createAgent } from '@/lib/repositories/agents';
import { ApiError, errorBody, newAgentId, newRequestId, validateAgentPayload } from '@/lib/agent/validators';
import { defaultModel } from '@/lib/models/gateway';
import type { AgentRecord } from '@/lib/agent/types';

export async function GET(request: Request) {
  const requestId = newRequestId();
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get('status') as AgentRecord['status'] | null;
    const agents = status && ['draft', 'active', 'disabled'].includes(status) ? await listAgents(status) : await listAgents();
    return Response.json({ requestId, agents });
  } catch (error) {
    return Response.json(errorBody(error instanceof Error ? error : new Error('服务暂时不可用'), requestId), { status: 500 });
  }
}

export async function POST(request: Request) {
  const requestId = newRequestId();
  try {
    const body = await request.json();
    const payload = validateAgentPayload(body, true);
    const provider = payload.modelProvider === 'kimi' ? 'kimi' : 'deepseek';
    const id = payload.id ?? newAgentId('agent');
    const agent: AgentRecord = {
      id,
      agentType: payload.agentType,
      employeeId: payload.employeeId ?? null,
      name: payload.name,
      systemInstructions: payload.systemInstructions ?? '',
      modelProvider: provider,
      modelName: payload.modelName ?? defaultModel(provider),
      config: (payload.config as AgentRecord['config']) ?? {},
      status: (payload.status as AgentRecord['status']) ?? 'draft',
      version: payload.version ?? 1,
    };
    await createAgent(agent);
    return Response.json({ requestId, agent: { ...agent, createdAt: undefined, updatedAt: undefined } }, { status: 201 });
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    return Response.json(errorBody(error instanceof Error ? error : new Error('服务暂时不可用'), requestId), { status });
  }
}
