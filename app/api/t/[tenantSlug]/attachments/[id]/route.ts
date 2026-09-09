/**
 * GET/DELETE /api/t/[tenantSlug]/attachments/[id] — 查询附件元数据 / 删除附件（租户隔离，跨租户返回 404）。
 */
import { isDbConfigured } from '@/lib/db';
import { deleteAttachment, getAttachment } from '@/lib/repositories/attachments';
import { requireTenantContext } from '@/lib/auth/context';

export async function GET(request: Request, { params }: { params: Promise<{ tenantSlug: string; id: string }> }) {
  try {
    const ctx = await requireTenantContext(request);
    if (!isDbConfigured()) return Response.json({ error: '数据库未配置' }, { status: 503 });
    const { id } = await params;
    const attachment = await getAttachment(ctx.tenantId, id);
    if (!attachment || attachment.status === 'deleted') {
      return Response.json({ error: '附件不存在' }, { status: 404 });
    }
    return Response.json({
      attachment: {
        id: attachment.id,
        ownerType: attachment.ownerType,
        ownerId: attachment.ownerId,
        originalName: attachment.originalName,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        category: attachment.category,
        status: attachment.status,
        extractedText: attachment.extractedText ?? null,
        extractionMeta: attachment.extractionMeta ?? null,
        errorMessage: attachment.errorMessage ?? null,
      },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '查询失败' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ tenantSlug: string; id: string }> }) {
  try {
    const ctx = await requireTenantContext(request);
    if (!isDbConfigured()) return Response.json({ error: '数据库未配置' }, { status: 503 });
    const { id } = await params;
    const attachment = await getAttachment(ctx.tenantId, id);
    if (!attachment) return Response.json({ error: '附件不存在' }, { status: 404 });
    const removed = await deleteAttachment(ctx.tenantId, id);
    return Response.json({ ok: true, removed });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '删除失败' }, { status: 500 });
  }
}
