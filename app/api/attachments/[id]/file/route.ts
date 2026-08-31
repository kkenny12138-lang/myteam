/**
 * GET /api/attachments/[id]/file — 下载/预览附件原始文件。
 * 仅返回二进制流与 Content-Type，前端用于图片预览与文档下载。
 */
import { isDbConfigured } from '@/lib/db';
import { getAttachmentBytes } from '@/lib/repositories/attachments';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isDbConfigured()) return Response.json({ error: '数据库未配置' }, { status: 503 });
    const { id } = await params;
    const file = await getAttachmentBytes(id);
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
