/**
 * POST /api/agent/runs/[id]/cancel — 取消任务（docs §8）。
 * 当前 run 为同步执行；对 queued / waiting 状态可安全取消。
 */
import { requireLegacyTenantContext, requireRole } from '@/lib/auth/context';
import { ApiError, errorBody, newRequestId } from '@/lib/agent/validators';
import { appendRunEvent, finishRun, getRun } from '@/lib/repositories/runs';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    const ctx = await requireLegacyTenantContext(request);
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
