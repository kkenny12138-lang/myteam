/**
 * GET /api/t/[tenantSlug]/attachments/[id]/file — 下载/预览附件原始文件（租户隔离，跨租户返回 404）。
 */
import { isDbConfigured } from '@/lib/db';
import { getAttachmentBytes } from '@/lib/repositories/attachments';
import { requireTenantContext } from '@/lib/auth/context';

export async function GET(request: Request, { params }: { params: Promise<{ tenantSlug: string; id: string }> }) {
  try {
    const ctx = await requireTenantContext(request);
    if (!isDbConfigured()) return Response.json({ error: '数据库未配置' }, { status: 503 });
    const { id } = await params;
    const file = await getAttachmentBytes(ctx.tenantId, id);
    if (!file) return Response.json({ error: '附件不存在或已删除' }, { status: 404 });
    return new Response(file.bytes as BodyInit, {
      headers: {
        'Content-Type': file.mimeType || 'application/octet-stream',
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '读取失败' }, { status: 500 });
  }
}
