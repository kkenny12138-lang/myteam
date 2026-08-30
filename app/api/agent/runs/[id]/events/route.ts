/**
 * GET /api/agent/runs/[id]/events — SSE 执行事件流（docs §5.1 / §8）。
 * 先回放已有事件；若 run 未结束，则轮询新事件直到完成或连接关闭。
 */
import { errorBody, newRequestId } from '@/lib/agent/validators';
import { getRun, listRunEvents } from '@/lib/repositories/runs';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  const { id } = await params;
  try {
    const run = await getRun(id);
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
          const events = await listRunEvents(id, after);
          for (const e of events) {
            send('run_event', { id: e.id, type: e.eventType, payload: e.payload, createdAt: e.createdAt });
            lastId = Math.max(lastId, e.id);
          }
          return events.length;
        };

        // 回放已有事件
        await flush();
        send('run_status', { status: run.status });

        // 若未结束，轮询新事件（直到完成 / 客户端断开）
        const aborted = request.signal;
        let current = run;
        while (!TERMINAL.has(current.status)) {
          if (aborted.aborted) break;
          await new Promise((resolve) => setTimeout(resolve, 1200));
          const latest = await getRun(id);
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
