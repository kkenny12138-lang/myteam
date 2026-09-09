/**
 * GET /api/t/[tenantSlug]/public/agents — 公共 Agent 列表（租户只读，所有租户共享）。
 */
import { listAgents } from '@/lib/repositories/agents';
import { requireTenantContext } from '@/lib/auth/context';
import { errorBody, newRequestId } from '@/lib/agent/validators';
import type { AgentRecord } from '@/lib/agent/types';

export async function GET(request: Request) {
  const requestId = newRequestId();
  try {
    await requireTenantContext(request);
    const url = new URL(request.url);
    const status = url.searchParams.get('status') as AgentRecord['status'] | null;
    const agents = status && ['draft', 'active', 'disabled'].includes(status) ? await listAgents(status) : await listAgents();
    return Response.json({ requestId, agents });
  } catch (error) {
    return Response.json(errorBody(error instanceof Error ? error : new Error('服务暂时不可用'), requestId), { status: 500 });
  }
}
