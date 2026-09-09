/**
 * GET/POST /api/v2/conversations — 会话列表（游标分页）/ 创建独立会话（S0）。
 * 错误统一结构 { requestId, code, message }。
 */
import { createConversation, listConversations } from '@/lib/repositories/conversations';
import { requireLegacyTenantContext, requireRole } from '@/lib/auth/context';
import { ApiError, errorBody, newRequestId } from '@/lib/agent/validators';

export async function GET(request: Request) {
  const requestId = newRequestId();
  try {
    const ctx = await requireLegacyTenantContext(request);
    const url = new URL(request.url);
    const cursor = url.searchParams.get('cursor');
    const limit = Number(url.searchParams.get('limit') || 50);
    const page = await listConversations(ctx.tenantId, { cursor, limit: Number.isFinite(limit) ? limit : 50 });
    return Response.json({ requestId, conversations: page.items, nextCursor: page.nextCursor });
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    return Response.json(errorBody(error instanceof Error ? error : new Error('服务暂时不可用'), requestId), { status });
  }
}

export async function POST(request: Request) {
  const requestId = newRequestId();
  try {
    const ctx = await requireLegacyTenantContext(request);
    requireRole(ctx, 'owner', 'admin', 'member');
    const body = await request.json().catch(() => null) as { type?: string; employeeId?: string; groupId?: string; title?: string } | null;
    if (!body || typeof body !== 'object') throw new ApiError('invalid_request', '请求体必须是 JSON 对象');
    const conversation = await createConversation(ctx.tenantId, {
      type: (body.type === 'group' ? 'group' : 'single') as 'single' | 'group',
      employeeId: body.employeeId ?? null,
      groupId: body.groupId ?? null,
      title: body.title || '',
    });
    return Response.json({ requestId, conversation }, { status: 201 });
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    return Response.json(errorBody(error instanceof Error ? error : new Error('服务暂时不可用'), requestId), { status });
  }
}
