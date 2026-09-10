import { addMemory, deleteMemory, listMemories, updateMemory } from '@/lib/repositories/memories';
import { requireLegacyTenantContext, requireRole } from '@/lib/auth/context';
import { ApiError } from '@/lib/agent/validators';

const kinds = ['long_term', 'preference', 'task_context', 'summary'] as const;
type MemoryKind = typeof kinds[number];
const isKind = (value: unknown): value is MemoryKind => typeof value === 'string' && kinds.includes(value as MemoryKind);

function statusOf(error: unknown): number { return error instanceof ApiError ? error.status : 500; }

export async function GET(request: Request) {
  try {
    const ctx = await requireLegacyTenantContext(request);
    const url = new URL(request.url);
    const agentId = url.searchParams.get('agentId') || '';
    if (!agentId) return Response.json({ error: '缺少 agentId' }, { status: 400 });
    const memories = await listMemories(ctx.tenantId, agentId, undefined, 100);
    return Response.json({ memories });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : '读取长期记忆失败' }, { status: statusOf(error) }); }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireLegacyTenantContext(request); requireRole(ctx, 'owner', 'admin', 'member');
    const body = await request.json() as { agentId?: string; kind?: unknown; content?: string; metadata?: Record<string, unknown> };
    const agentId = body.agentId?.trim() || ''; const content = body.content?.trim() || '';
    if (!agentId || !isKind(body.kind) || !content || content.length > 2000) return Response.json({ error: '记忆内容或类型不正确' }, { status: 400 });
    const id = await addMemory(ctx.tenantId, { agentId, kind: body.kind, content, metadata: body.metadata });
    return Response.json({ memory: { id, agentId, kind: body.kind, content, metadata: body.metadata || null } }, { status: 201 });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : '保存长期记忆失败' }, { status: statusOf(error) }); }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireLegacyTenantContext(request); requireRole(ctx, 'owner', 'admin', 'member');
    const body = await request.json() as { id?: string; kind?: unknown; content?: string };
    const id = body.id?.trim() || ''; const content = body.content?.trim() || '';
    if (!id || !isKind(body.kind) || !content || content.length > 2000) return Response.json({ error: '记忆内容或类型不正确' }, { status: 400 });
    if (!await updateMemory(ctx.tenantId, id, { kind: body.kind, content })) return Response.json({ error: '记忆不存在' }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : '更新长期记忆失败' }, { status: statusOf(error) }); }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireLegacyTenantContext(request); requireRole(ctx, 'owner', 'admin', 'member');
    const id = new URL(request.url).searchParams.get('id') || '';
    if (!id) return Response.json({ error: '缺少记忆 ID' }, { status: 400 });
    await deleteMemory(ctx.tenantId, id);
    return Response.json({ ok: true });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : '删除长期记忆失败' }, { status: statusOf(error) }); }
}
