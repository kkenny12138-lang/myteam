/**
 * GET /api/t/[tenantSlug]/public/skills — 公共 Skill 列表（租户只读，所有租户共享）。
 */
import { listSkills } from '@/lib/repositories/skills';
import { requireTenantContext } from '@/lib/auth/context';
import { errorBody, newRequestId } from '@/lib/agent/validators';
import type { SkillRecord } from '@/lib/agent/types';

export async function GET(request: Request) {
  const requestId = newRequestId();
  try {
    await requireTenantContext(request);
    const url = new URL(request.url);
    const status = url.searchParams.get('status') as SkillRecord['status'] | null;
    const skills = status && ['draft', 'published', 'disabled'].includes(status) ? await listSkills(status) : await listSkills();
    return Response.json({ requestId, skills });
  } catch (error) {
    return Response.json(errorBody(error instanceof Error ? error : new Error('服务暂时不可用'), requestId), { status: 500 });
  }
}
