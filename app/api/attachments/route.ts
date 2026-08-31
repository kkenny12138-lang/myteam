/**
 * POST /api/attachments — 上传附件（multipart/form-data）。
 * 文档依据：docs/MULTIMODAL_ATTACHMENT_DEVELOPMENT_PLAN.md §7.1 / §11
 * 流程：类型/大小/归属校验 → 抽取文本 → MySQL 保存元数据与二进制。
 */
import { ensureSchema, isDbConfigured } from '@/lib/db';
import { createAttachment } from '@/lib/repositories/attachments';
import {
  ATTACHMENT_MAX_FILE_BYTES,
  categoryOf,
  extractDocumentText,
} from '@/lib/agent/attachment-parser';
import type { AttachmentCategory } from '@/lib/agent/types';

function toPublic(attachment: {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  category: AttachmentCategory;
  status: string;
  extractedText?: string | null;
}) {
  return {
    id: attachment.id,
    originalName: attachment.originalName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    category: attachment.category,
    status: attachment.status,
    extractedText: attachment.extractedText ?? null,
  };
}

export async function POST(request: Request) {
  try {
    if (!isDbConfigured()) {
      return Response.json({ error: '数据库未配置，暂不支持附件上传' }, { status: 503 });
    }
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return Response.json({ error: '请求必须使用 multipart/form-data' }, { status: 400 });
    }
    const file = form.get('file');
    const ownerType = String(form.get('ownerType') || '');
    const ownerId = String(form.get('ownerId') || '').trim();
    if (!(file instanceof File)) {
      return Response.json({ error: '缺少文件字段 file' }, { status: 400 });
    }
    if ((ownerType !== 'single' && ownerType !== 'group') || !ownerId) {
      return Response.json({ error: '参数不正确：ownerType 必须为 single/group，ownerId 不能为空' }, { status: 400 });
    }
    if (file.size === 0) return Response.json({ error: '不能上传空文件' }, { status: 400 });
    if (file.size > ATTACHMENT_MAX_FILE_BYTES) {
      return Response.json({ error: `文件超过大小限制（${Math.round(ATTACHMENT_MAX_FILE_BYTES / 1024 / 1024)}MB）` }, { status: 413 });
    }
    const mimeType = file.type || 'application/octet-stream';
    const category = categoryOf(mimeType, file.name);
    if (!category) {
      return Response.json({ error: '不支持的文件类型，仅支持图片（PNG/JPEG/WEBP）与文档（PDF/DOCX/TXT/MD/CSV/XLSX）' }, { status: 415 });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const { text, meta } = await extractDocumentText(category, mimeType, bytes);
    const id = `att_${crypto.randomUUID()}`;

    await ensureSchema();
    await createAttachment({
      id,
      ownerType: ownerType as 'single' | 'group',
      ownerId,
      originalName: file.name || '未命名附件',
      mimeType,
      sizeBytes: file.size,
      category,
      status: 'ready',
      extractedText: text,
      extractionMeta: meta,
      data: bytes,
    });

    return Response.json(
      { attachment: toPublic({ id, originalName: file.name, mimeType, sizeBytes: file.size, category, status: 'ready', extractedText: text }) },
      { status: 201 }
    );
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '上传失败' }, { status: 500 });
  }
}
