/**
 * GET /api/t/[tenantSlug]/agent/runs/[id]/events — SSE 执行事件流（租户隔离，跨租户返回 404）。
 */
import { requireTenantContext } from '@/lib/auth/context';
import { errorBody, newRequestId } from '@/lib/agent/validators';
import { getRun, listRunEvents } from '@/lib/repositories/runs';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

export async function GET(request: Request, { params }: { params: Promise<{ tenantSlug: string; id: string }> }) {
  const requestId = newRequestId();
  const { id } = await params;
  try {
    const ctx = await requireTenantContext(request);
    const run = await getRun(ctx.tenantId, id);
    if (!run) return Response.json({ code: 'run_not_found', message: `运行记录不存在: ${id}`, requestId }, { status: 404 });

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let lastId = 0;
        const send = (type: string, data: unknown) => {
          try {
            controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch { /* 客户端已断开 */ }
        };
        const flush = async (after?: number) => {
          const events = await listRunEvents(ctx.tenantId, id, after);
          for (const e of events) {
            send('run_event', { id: e.id, type: e.eventType, payload: e.payload, createdAt: e.createdAt });
            lastId = Math.max(lastId, e.id);
          }
          return events.length;
        };

        await flush();
        send('run_status', { status: run.status });

        const aborted = request.signal;
        let current = run;
        while (!TERMINAL.has(current.status)) {
          if (aborted.aborted) break;
          await new Promise((resolve) => setTimeout(resolve, 1200));
          const latest = await getRun(ctx.tenantId, id);
          if (!latest) break;
          current = latest;
          await flush(lastId);
          if (latest.status !== current.status || TERMINAL.has(latest.status)) {
            send('run_status', { status: latest.status });
          }
          current = latest;
        }
        controller.close();
      },
      cancel() { /* 连接关闭 */ },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    return Response.json(errorBody(error instanceof Error ? error : new Error('服务暂时不可用'), requestId), { status: 500 });
  }
}
