/**
 * GET/DELETE /api/attachments/[id] — 查询附件元数据 / 删除附件。
 * 不返回文件二进制与任何永久公开地址（文档 §7.2 / §7.3）。
 */
import { isDbConfigured } from '@/lib/db';
import { deleteAttachment, getAttachment } from '@/lib/repositories/attachments';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isDbConfigured()) return Response.json({ error: '数据库未配置' }, { status: 503 });
    const { id } = await params;
    const attachment = await getAttachment(id);
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

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isDbConfigured()) return Response.json({ error: '数据库未配置' }, { status: 503 });
    const { id } = await params;
    const attachment = await getAttachment(id);
    if (!attachment) return Response.json({ error: '附件不存在' }, { status: 404 });
    const removed = await deleteAttachment(id);
    return Response.json({ ok: true, removed });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '删除失败' }, { status: 500 });
  }
}
