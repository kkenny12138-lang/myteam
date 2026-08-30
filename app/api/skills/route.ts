/**
 * GET/POST /api/skills — Skill 列表 / 创建（docs §6 / §8）。
 */
import { createSkill, listSkills } from '@/lib/repositories/skills';
import { ApiError, errorBody, newRequestId, newSkillId, validateSkillPayload } from '@/lib/agent/validators';
import type { SkillRecord } from '@/lib/agent/types';

export async function GET(request: Request) {
  const requestId = newRequestId();
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get('status') as SkillRecord['status'] | null;
    const skills = status && ['draft', 'published', 'disabled'].includes(status) ? await listSkills(status) : await listSkills();
    return Response.json({ requestId, skills });
  } catch (error) {
    return Response.json(errorBody(error instanceof Error ? error : new Error('服务暂时不可用'), requestId), { status: 500 });
  }
}

export async function POST(request: Request) {
  const requestId = newRequestId();
  try {
    const body = await request.json();
    const payload = validateSkillPayload(body, true);
    const skill: SkillRecord = {
      id: payload.id ?? newSkillId(),
      name: payload.name,
      summary: payload.summary ?? '',
      instructions: payload.instructions ?? '',
      inputSchema: payload.inputSchema ?? null,
      outputSchema: payload.outputSchema ?? null,
      examples: payload.examples ?? null,
      status: (payload.status as SkillRecord['status']) ?? 'draft',
      version: payload.version ?? 1,
    };
    await createSkill(skill);
    return Response.json({ requestId, skill }, { status: 201 });
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    return Response.json(errorBody(error instanceof Error ? error : new Error('服务暂时不可用'), requestId), { status });
  }
}
