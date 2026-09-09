/**
 * GET/POST /api/t/[tenantSlug]/v2/conversations/[id]/messages — 租户会话消息（多租户）。
 */
import { appendMessage, listMessages } from '@/lib/repositories/conversations';
import { requireRole, requireTenantContext } from '@/lib/auth/context';
import { ApiError, errorBody, newRequestId } from '@/lib/agent/validators';

export async function GET(request: Request, { params }: { params: Promise<{ tenantSlug: string; id: string }> }) {
  const requestId = newRequestId();
  try {
    const ctx = await requireTenantContext(request);
    const { id } = await params;
    const url = new URL(request.url);
    const cursor = url.searchParams.get('cursor');
    const limit = Number(url.searchParams.get('limit') || 50);
    const page = await listMessages(ctx.tenantId, id, { cursor, limit: Number.isFinite(limit) ? limit : 50 });
    return Response.json({ requestId, messages: page.items, nextCursor: page.nextCursor });
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    return Response.json(errorBody(error instanceof Error ? error : new Error('服务暂时不可用'), requestId), { status });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ tenantSlug: string; id: string }> }) {
  const requestId = newRequestId();
  try {
    const ctx = await requireTenantContext(request);
    requireRole(ctx, 'owner', 'admin', 'member');
    const { id } = await params;
    const body = await request.json().catch(() => null) as {
      sender?: string; senderName?: string; text?: string; tokens?: number; runId?: string | null; attachmentIds?: string[];
    } | null;
    if (!body || typeof body !== 'object') throw new ApiError('invalid_request', '请求体必须是 JSON 对象');
    if (body.sender !== 'me' && body.sender !== 'employee') throw new ApiError('invalid_sender', 'sender 必须是 me 或 employee');
    if (typeof body.text !== 'string' || !body.text) throw new ApiError('invalid_text', 'text 不能为空');
    const message = await appendMessage(ctx.tenantId, {
      conversationId: id,
      sender: body.sender,
      senderName: body.senderName,
      text: body.text,
      tokens: body.tokens,
      runId: body.runId,
      attachmentIds: body.attachmentIds,
    });
    return Response.json({ requestId, message }, { status: 201 });
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    return Response.json(errorBody(error instanceof Error ? error : new Error('服务暂时不可用'), requestId), { status });
  }
}
