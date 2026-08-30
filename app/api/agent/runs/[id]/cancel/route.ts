/**
 * POST /api/agent/runs/[id]/cancel — 取消任务（docs §8）。
 * 当前 run 为同步执行；对 queued / waiting 状态可安全取消。
 */
import { ApiError, errorBody, newRequestId } from '@/lib/agent/validators';
import { appendRunEvent, finishRun, getRun } from '@/lib/repositories/runs';

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    const { id } = await params;
    const run = await getRun(id);
    if (!run) throw new ApiError('run_not_found', `运行记录不存在: ${id}`, 404);
    if (run.status === 'queued' || run.status === 'waiting' || run.status === 'planning') {
      await finishRun(id, { status: 'cancelled', errorText: '用户主动取消' });
      await appendRunEvent(id, 'cancelled', { by: 'user' });
    }
    return Response.json({ requestId, runId: id, status: (await getRun(id))?.status });
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    return Response.json(errorBody(error instanceof Error ? error : new Error('服务暂时不可用'), requestId), { status });
  }
}
