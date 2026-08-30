/**
 * PUT/DELETE /api/agents/[id]/skills/[skillId] — 绑定 / 解绑 Skill（docs §6 / §8）。
 */
import { getAgentById } from '@/lib/repositories/agents';
import { getSkillById, linkSkill, unlinkSkill } from '@/lib/repositories/skills';
import { ApiError, errorBody, newRequestId } from '@/lib/agent/validators';

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; skillId: string }> }
) {
  const requestId = newRequestId();
  try {
    const { id, skillId } = await params;
    const [agent, skill] = await Promise.all([getAgentById(id), getSkillById(skillId)]);
    if (!agent) throw new ApiError('agent_not_found', `Agent 不存在: ${id}`, 404);
    if (!skill) throw new ApiError('skill_not_found', `Skill 不存在: ${skillId}`, 404);
    let priority = 100;
    let customInstructions: string | undefined;
    try {
      const body = await request.json() as { priority?: number; customInstructions?: string } | null;
      if (body && typeof body.priority === 'number') priority = body.priority;
      if (body && typeof body.customInstructions === 'string') customInstructions = body.customInstructions;
    } catch { /* 无请求体也允许 */ }
    await linkSkill(id, skillId, priority, customInstructions);
    return Response.json({ requestId, ok: true, agentId: id, skillId });
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    return Response.json(errorBody(error instanceof Error ? error : new Error('服务暂时不可用'), requestId), { status });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; skillId: string }> }
) {
  const requestId = newRequestId();
  try {
    const { id, skillId } = await params;
    await unlinkSkill(id, skillId);
    return Response.json({ requestId, ok: true });
  } catch (error) {
    return Response.json(errorBody(error instanceof Error ? error : new Error('服务暂时不可用'), requestId), { status: 500 });
  }
}
