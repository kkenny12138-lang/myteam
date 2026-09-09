/**
 * POST /api/t/[tenantSlug]/agent/runs/[id]/cancel — 取消任务（租户隔离，跨租户返回 404）。
 */
import { requireRole, requireTenantContext } from '@/lib/auth/context';
import { ApiError, errorBody, newRequestId } from '@/lib/agent/validators';
import { appendRunEvent, finishRun, getRun } from '@/lib/repositories/runs';

export async function POST(request: Request, { params }: { params: Promise<{ tenantSlug: string; id: string }> }) {
  const requestId = newRequestId();
  try {
    const ctx = await requireTenantContext(request);
    requireRole(ctx, 'owner', 'admin', 'member');
    const { id } = await params;
    const run = await getRun(ctx.tenantId, id);
    if (!run) throw new ApiError('run_not_found', `运行记录不存在: ${id}`, 404);
    if (run.status === 'queued' || run.status === 'waiting' || run.status === 'planning') {
      await finishRun(ctx.tenantId, id, { status: 'cancelled', errorText: '用户主动取消' });
      await appendRunEvent(ctx.tenantId, id, 'cancelled', { by: 'user' });
    }
    return Response.json({ requestId, runId: id, status: (await getRun(ctx.tenantId, id))?.status });
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    return Response.json(errorBody(error instanceof Error ? error : new Error('服务暂时不可用'), requestId), { status });
  }
}
