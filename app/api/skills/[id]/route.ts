/**
 * GET/PATCH /api/skills/[id] — 长文本 Skill 编辑 / 版本更新（docs §6.2）。
 * PATCH 使用乐观锁：WHERE id=? AND version=?。
 */
import { getSkillById, updateSkill } from '@/lib/repositories/skills';
import { ApiError, errorBody, newRequestId, validateSkillPayload } from '@/lib/agent/validators';
import type { SkillRecord } from '@/lib/agent/types';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    const { id } = await params;
    const skill = await getSkillById(id);
    if (!skill) throw new ApiError('skill_not_found', `Skill 不存在: ${id}`, 404);
    return Response.json({ requestId, skill });
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
    const payload = validateSkillPayload(body, false);
    const existing = await getSkillById(id);
    if (!existing) throw new ApiError('skill_not_found', `Skill 不存在: ${id}`, 404);
    const expectedVersion = payload.version ?? existing.version;
    const ok = await updateSkill(
      id,
      {
        name: payload.name,
        summary: payload.summary,
        instructions: payload.instructions,
        inputSchema: payload.inputSchema,
        outputSchema: payload.outputSchema,
        examples: payload.examples,
        status: payload.status as SkillRecord['status'] | undefined,
      },
      expectedVersion
    );
    if (!ok) throw new ApiError('version_conflict', '版本冲突：该 Skill 已被他人更新，请刷新后重试', 409);
    const skill = await getSkillById(id);
    return Response.json({ requestId, skill });
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    return Response.json(errorBody(error instanceof Error ? error : new Error('服务暂时不可用'), requestId), { status });
  }
}
