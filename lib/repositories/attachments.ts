/**
 * attachments / message_attachments 数据访问层。
 * 文件二进制存 attachments.data（LONGBLOB），MySQL 只保存元数据、解析文本与消息关系。
 * 文档依据：docs/MULTIMODAL_ATTACHMENT_DEVELOPMENT_PLAN.md §5 / §6
 */
import { ensureSchema, getPool, isDbConfigured } from '@/lib/db';
import type {
  AttachmentCategory,
  AttachmentOwnerType,
  AttachmentRecord,
  AttachmentStatus,
} from '@/lib/agent/types';

function mapRow(r: Record<string, unknown>): AttachmentRecord {
  return {
    id: String(r.id),
    ownerType: r.owner_type as AttachmentOwnerType,
    ownerId: String(r.owner_id),
    originalName: String(r.original_name),
    mimeType: String(r.mime_type),
    sizeBytes: Number(r.size_bytes),
    category: r.category as AttachmentCategory,
    status: r.status as AttachmentStatus,
    extractedText: r.extracted_text === null || r.extracted_text === undefined ? null : String(r.extracted_text),
    extractionMeta: r.extraction_meta === null || r.extraction_meta === undefined
      ? null
      : (typeof r.extraction_meta === 'object' ? r.extraction_meta as Record<string, unknown> : safeJson(r.extraction_meta)),
    errorMessage: r.error_message === null || r.error_message === undefined ? null : String(r.error_message),
    createdAt: r.created_at ? String(r.created_at) : undefined,
  };
}

function safeJson(v: unknown): Record<string, unknown> | null {
  try { return JSON.parse(String(v)) as Record<string, unknown>; } catch { return null; }
}

export interface CreateAttachmentInput {
  id: string;
  ownerType: AttachmentOwnerType;
  ownerId: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  category: AttachmentCategory;
  status: AttachmentStatus;
  extractedText: string | null;
  extractionMeta: Record<string, unknown> | null;
  data: Uint8Array | null;
}

export async function createAttachment(input: CreateAttachmentInput): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO attachments (id, owner_type, owner_id, original_name, mime_type, size_bytes, category, status, data, extracted_text, extraction_meta, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      input.id,
      input.ownerType,
      input.ownerId,
      input.originalName,
      input.mimeType,
      input.sizeBytes,
      input.category,
      input.status,
      input.data ? Buffer.from(input.data) : null,
      input.extractedText,
      input.extractionMeta ? JSON.stringify(input.extractionMeta) : null,
    ]
  );
}

export async function getAttachment(id: string): Promise<AttachmentRecord | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const rows = await getPool().query(
    'SELECT id, owner_type, owner_id, original_name, mime_type, size_bytes, category, status, extracted_text, extraction_meta, error_message, created_at FROM attachments WHERE id = ? LIMIT 1',
    [id]
  ) as Array<Record<string, unknown>>;
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export async function getAttachments(ids: string[]): Promise<AttachmentRecord[]> {
  if (!isDbConfigured() || !ids.length) return [];
  await ensureSchema();
  const placeholders = ids.map(() => '?').join(',');
  const rows = await getPool().query(
    `SELECT id, owner_type, owner_id, original_name, mime_type, size_bytes, category, status, extracted_text, extraction_meta, error_message, created_at
     FROM attachments WHERE id IN (${placeholders})`,
    ids
  ) as Array<Record<string, unknown>>;
  return rows.map(mapRow);
}

export async function getAttachmentBytes(id: string): Promise<{ mimeType: string; bytes: Uint8Array } | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const rows = await getPool().query(
    'SELECT mime_type, data FROM attachments WHERE id = ? AND status <> ? LIMIT 1',
    [id, 'deleted']
  ) as Array<{ mime_type: string; data: Buffer | null }>;
  const row = rows[0];
  if (!row || !row.data) return null;
  return { mimeType: String(row.mime_type || 'application/octet-stream'), bytes: new Uint8Array(row.data) };
}

export async function deleteAttachment(id: string): Promise<boolean> {
  if (!isDbConfigured()) return false;
  await ensureSchema();
  await getPool().query('DELETE FROM message_attachments WHERE attachment_id = ?', [id]);
  const result = await getPool().query('DELETE FROM attachments WHERE id = ?', [id]);
  return (result as { affectedRows?: number }).affectedRows ? true : false;
}

/** 回写抽取结果（例如 Kimi Files API 抽取成功后的缓存） */
export async function updateExtractedText(
  id: string,
  extractedText: string,
  meta: Record<string, unknown>
): Promise<void> {
  await ensureSchema();
  await getPool().query(
    'UPDATE attachments SET extracted_text = ?, extraction_meta = ?, status = ? WHERE id = ?',
    [extractedText, JSON.stringify(meta), 'ready', id]
  );
}

export async function linkMessageAttachment(
  messageType: 'single' | 'group',
  messageId: string,
  attachmentId: string,
  sortOrder: number
): Promise<void> {
  await ensureSchema();
  await getPool().query(
    'INSERT INTO message_attachments (message_type, message_id, attachment_id, sort_order) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE sort_order = VALUES(sort_order)',
    [messageType, messageId, attachmentId, sortOrder]
  );
}

export async function clearMessageAttachments(messageType: 'single' | 'group'): Promise<void> {
  await ensureSchema();
  await getPool().query('DELETE FROM message_attachments WHERE message_type = ?', [messageType]);
}

/** 按消息批量取附件（不返回二进制），返回 messageId -> 附件列表 */
export async function listAttachmentsForMessages(
  messageType: 'single' | 'group',
  messageIds: string[]
): Promise<Record<string, AttachmentRecord[]>> {
  const result: Record<string, AttachmentRecord[]> = {};
  if (!isDbConfigured() || !messageIds.length) return result;
  await ensureSchema();
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = await getPool().query(
    `SELECT a.id, a.owner_type, a.owner_id, a.original_name, a.mime_type, a.size_bytes, a.category, a.status,
            a.extracted_text, a.extraction_meta, a.error_message, a.created_at, ma.message_id, ma.sort_order
     FROM attachments a
     JOIN message_attachments ma ON ma.attachment_id = a.id
     WHERE ma.message_type = ? AND ma.message_id IN (${placeholders})
     ORDER BY ma.sort_order ASC, a.created_at ASC`,
    [messageType, ...messageIds]
  ) as Array<Record<string, unknown>>;
  for (const row of rows) {
    const messageId = String(row.message_id);
    (result[messageId] ||= []).push(mapRow(row));
  }
  return result;
}
