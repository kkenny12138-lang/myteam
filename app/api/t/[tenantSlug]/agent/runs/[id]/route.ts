/**
 * GET /api/t/[tenantSlug]/agent/runs/[id] — 运行状态与最终结果（租户隔离，跨租户返回 404）。
 */
import { requireTenantContext } from '@/lib/auth/context';
import { errorBody, newRequestId } from '@/lib/agent/validators';
import { getRun, listChildRuns, listRunEvents } from '@/lib/repositories/runs';

export async function GET(request: Request, { params }: { params: Promise<{ tenantSlug: string; id: string }> }) {
  const requestId = newRequestId();
  try {
    const ctx = await requireTenantContext(request);
    const { id } = await params;
    const run = await getRun(ctx.tenantId, id);
    if (!run) return Response.json({ code: 'run_not_found', message: `运行记录不存在: ${id}`, requestId }, { status: 404 });
    const [childRuns, events] = await Promise.all([listChildRuns(ctx.tenantId, id), listRunEvents(ctx.tenantId, id)]);
    return Response.json({
      requestId,
      run,
      childRuns,
      events: events.map((e) => ({ id: e.id, type: e.eventType, payload: e.payload, createdAt: e.createdAt })),
    });
  } catch (error) {
    return Response.json(errorBody(error instanceof Error ? error : new Error('服务暂时不可用'), requestId), { status: 500 });
  }
}
