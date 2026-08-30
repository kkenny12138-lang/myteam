/**
 * POST /api/agent/runs — 启动一次 Agent 任务（docs §5.1 / §8）。
 * 请求体：{ conversationId, agentId, message, mode?, history? }
 * 响应：根 run 的最终结果（含 events / plan / childRuns）。
 */
import { startRun, type RunInput } from '@/lib/agent/runtime';
import { ApiError, errorBody, newRequestId, validateRunRequest } from '@/lib/agent/validators';
import { migrateToAgentPlatform } from '@/lib/agent/migrate';

export async function POST(request: Request) {
  const requestId = newRequestId();
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ApiError('invalid_request', '请求体不是合法 JSON');
    }
    const input = validateRunRequest(body);

    // 首次调用自动完成旧数据迁移（幂等，schema_migrations 保证只执行一次）
    await migrateToAgentPlatform();

    const history = (body as { history?: Array<{ role: 'user' | 'assistant'; content: string }> }).history;
    const personaAgentId = (body as { personaAgentId?: unknown }).personaAgentId;
    const modelRaw = (body as { model?: unknown }).model;
    const model = modelRaw === 'kimi' || modelRaw === 'deepseek' ? modelRaw : undefined;
    const outcome = await startRun({
      conversationId: input.conversationId,
      agentId: input.agentId,
      message: input.message,
      mode: input.mode,
      preview: input.preview,
      model,
      personaAgentId: typeof personaAgentId === 'string' && personaAgentId.startsWith('emp_') ? personaAgentId : undefined,
      history: Array.isArray(history)
        ? history
            .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
            .slice(-20)
            .map((h) => ({ role: h.role, content: h.content }))
        : undefined,
    } satisfies RunInput);

    return Response.json({
      requestId,
      runId: outcome.rootRun.id,
      status: outcome.status,
      answer: outcome.answerText,
      plan: outcome.plan,
      agentId: outcome.rootRun.agentId,
      childRuns: outcome.childRuns.map((r) => ({ runId: r.id, agentId: r.agentId, status: r.status, outputText: r.outputText, errorText: r.errorText })),
      usage: outcome.usage,
      events: outcome.events.map((e) => ({ id: e.id, type: e.eventType, payload: e.payload })),
      createdAt: outcome.rootRun.createdAt,
    });
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    return Response.json(errorBody(error instanceof Error ? error : new Error('服务暂时不可用'), requestId), { status });
  }
}
