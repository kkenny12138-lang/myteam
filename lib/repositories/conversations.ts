/**
 * conversations / conversation_messages / conversation_message_attachments 数据访问层。
 * S0 交付（docs/FEATURE_DEVELOPMENT_ROADMAP.md §4.2）：
 * - 独立会话（conversationId 不再等于员工 ID）
 * - 服务端增量消息（按 conversationId 追加 + 游标分页，不再整体删除重插）
 * - 消息与附件关联在同一事务内完成，任一关联失败则整体回滚
 */
import { ensureSchema, getPool, isDbConfigured } from '@/lib/db';
import { ApiError } from '@/lib/agent/validators';
import type { AttachmentRef, AttachmentRecord } from '@/lib/agent/types';
import type { PoolConnection } from 'mariadb';

export type ConversationType = 'single' | 'group';

export interface ConversationRecord {
  id: string;
  type: ConversationType;
  employeeId: string | null;
  groupId: string | null;
  title: string;
  version: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  seq: number;
  sender: 'me' | 'employee';
  senderName: string;
  text: string;
  tokens: number;
  runId: string | null;
  createdAt?: string;
  attachments: AttachmentRef[];
}

export interface AppendMessageInput {
  conversationId: string;
  id?: string;
  sender: 'me' | 'employee';
  senderName?: string;
  text: string;
  tokens?: number;
  runId?: string | null;
  attachmentIds?: string[];
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** 迁移/默认会话的确定性 ID（历史单聊按员工、群聊按群映射） */
export function defaultConversationId(type: ConversationType, ownerId: string): string {
  return type === 'single' ? `dm_${ownerId}` : `grp_${ownerId}`;
}

function mapConversation(r: Record<string, unknown>): ConversationRecord {
  return {
    id: String(r.id),
    type: r.type as ConversationType,
    employeeId: r.employee_id === null || r.employee_id === undefined ? null : String(r.employee_id),
    groupId: r.group_id === null || r.group_id === undefined ? null : String(r.group_id),
    title: String(r.title || ''),
    version: Number(r.version || 1),
    createdAt: r.created_at ? String(r.created_at) : undefined,
    updatedAt: r.updated_at ? String(r.updated_at) : undefined,
  };
}

function toRef(a: AttachmentRecord): AttachmentRef {
  return {
    id: a.id,
    originalName: a.originalName,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    category: a.category,
    status: a.status,
  };
}

function newId(prefix: string): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${rnd}`;
}

export async function createConversation(input: {
  type: ConversationType;
  employeeId?: string | null;
  groupId?: string | null;
  title?: string;
}): Promise<ConversationRecord> {
  if (!isDbConfigured()) throw new ApiError('db_unavailable', '数据库未配置', 503);
  await ensureSchema();
  if (input.type !== 'single' && input.type !== 'group') throw new ApiError('invalid_type', 'type 必须是 single 或 group');
  if (input.type === 'single' && !input.employeeId) throw new ApiError('invalid_owner', '单聊会话必须提供 employeeId');
  if (input.type === 'group' && !input.groupId) throw new ApiError('invalid_owner', '群聊会话必须提供 groupId');

  const id = newId('c');
  await getPool().query(
    'INSERT INTO conversations (id, type, employee_id, group_id, title, version) VALUES (?, ?, ?, ?, ?, 1)',
    [id, input.type, input.employeeId ?? null, input.groupId ?? null, input.title || '']
  );
  return (await getConversation(id))!;
}

export async function getConversation(id: string): Promise<ConversationRecord | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const rows = await getPool().query(
    'SELECT id, type, employee_id, group_id, title, version, created_at, updated_at FROM conversations WHERE id = ? LIMIT 1',
    [id]
  ) as Array<Record<string, unknown>>;
  return rows[0] ? mapConversation(rows[0]) : null;
}

/** 按归属查默认会话（用于旧数据映射后查找） */
export async function getConversationByOwner(type: ConversationType, ownerId: string): Promise<ConversationRecord | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const col = type === 'single' ? 'employee_id' : 'group_id';
  const rows = await getPool().query(
    `SELECT id, type, employee_id, group_id, title, version, created_at, updated_at FROM conversations WHERE ${col} = ? ORDER BY created_at ASC, id ASC LIMIT 1`,
    [ownerId]
  ) as Array<Record<string, unknown>>;
  return rows[0] ? mapConversation(rows[0]) : null;
}

/** 列表（游标分页，按 updated_at DESC, id DESC 键集） */
export async function listConversations(opts: { cursor?: string | null; limit?: number } = {}): Promise<Page<ConversationRecord>> {
  if (!isDbConfigured()) return { items: [], nextCursor: null };
  await ensureSchema();
  const limit = Math.min(Math.max(opts.limit || 50, 1), 200);
  const params: Array<string | number> = [];
  let where = '';
  if (opts.cursor) {
    const decoded = decodeConversationCursor(opts.cursor);
    where = 'WHERE (UNIX_TIMESTAMP(updated_at) < ? OR (UNIX_TIMESTAMP(updated_at) = ? AND id < ?))';
    params.push(decoded.ts, decoded.ts, decoded.id);
  }
  const rows = await getPool().query(
    `SELECT id, type, employee_id, group_id, title, version, created_at, updated_at
     FROM conversations ${where}
     ORDER BY updated_at DESC, id DESC
     LIMIT ?`,
    [...params, limit + 1]
  ) as Array<Record<string, unknown>>;
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(mapConversation);
  const nextCursor = hasMore && items.length ? encodeConversationCursor(items[items.length - 1]) : null;
  return { items, nextCursor };
}

function encodeConversationCursor(c: ConversationRecord): string {
  const ts = c.updatedAt ? Math.floor(new Date(c.updatedAt).getTime() / 1000) : 0;
  return `${ts}_${c.id}`;
}

function decodeConversationCursor(cursor: string): { ts: number; id: string } {
  const idx = cursor.indexOf('_');
  const ts = Number(cursor.slice(0, idx >= 0 ? idx : cursor.length)) || 0;
  const id = idx >= 0 ? cursor.slice(idx + 1) : '';
  return { ts, id };
}

/**
 * 追加一条消息 + 附件关联，整体在同一事务内完成。
 * 附件归属与状态在事务内校验；任一关联失败会连同消息一起回滚。
 */
export async function appendMessage(input: AppendMessageInput): Promise<ConversationMessage> {
  if (!isDbConfigured()) throw new ApiError('db_unavailable', '数据库未配置', 503);
  await ensureSchema();
  if (input.sender !== 'me' && input.sender !== 'employee') throw new ApiError('invalid_sender', 'sender 必须是 me 或 employee');
  if (!input.text) throw new ApiError('invalid_text', 'text 不能为空');

  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();

    const convRows = await connection.query(
      'SELECT id, type, employee_id, group_id, title, version FROM conversations WHERE id = ? LIMIT 1',
      [input.conversationId]
    ) as Array<Record<string, unknown>>;
    const conv = convRows[0];
    if (!conv) throw new ApiError('conversation_not_found', `会话不存在: ${input.conversationId}`, 404);
    const type = conv.type as ConversationType;
    const ownerId = type === 'single' ? (conv.employee_id === null ? '' : String(conv.employee_id)) : (conv.group_id === null ? '' : String(conv.group_id));

    const attachmentIds = (Array.isArray(input.attachmentIds) ? input.attachmentIds : [])
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .slice(0, 5);

    // 附件归属校验（在事务内执行，失败即回滚）
    const attachments: AttachmentRecord[] = [];
    for (const attId of attachmentIds) {
      const attRows = await connection.query(
        'SELECT id, owner_type, owner_id, original_name, mime_type, size_bytes, category, status FROM attachments WHERE id = ? LIMIT 1',
        [attId]
      ) as Array<Record<string, unknown>>;
      const att = attRows[0];
      if (!att || String(att.status) === 'deleted') throw new ApiError('attachment_not_found', `附件不存在或已删除: ${attId}`, 400);
      if (String(att.status) !== 'ready') throw new ApiError('attachment_not_ready', `附件尚未就绪: ${attId}`, 400);
      if (String(att.owner_type) !== type || String(att.owner_id) !== ownerId) {
        throw new ApiError('attachment_not_owned', `附件不属于当前会话: ${attId}`, 400);
      }
      attachments.push({
        id: String(att.id),
        ownerType: String(att.owner_type) as AttachmentRecord['ownerType'],
        ownerId: String(att.owner_id),
        originalName: String(att.original_name),
        mimeType: String(att.mime_type),
        sizeBytes: Number(att.size_bytes),
        category: String(att.category) as AttachmentRecord['category'],
        status: String(att.status) as AttachmentRecord['status'],
      });
    }

    const id = input.id || newId('m');
    await connection.query(
      'INSERT INTO conversation_messages (id, conversation_id, sender, sender_name, text, tokens, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, input.conversationId, input.sender, input.senderName || '', input.text, input.tokens || 0, input.runId || null]
    );

    for (let i = 0; i < attachmentIds.length; i++) {
      await connection.query(
        'INSERT INTO conversation_message_attachments (message_id, attachment_id, sort_order) VALUES (?, ?, ?)',
        [id, attachmentIds[i], i]
      );
    }

    await connection.query('UPDATE conversations SET version = version + 1 WHERE id = ?', [input.conversationId]);
    await connection.commit();

    const created = await connection.query(
      'SELECT seq, created_at FROM conversation_messages WHERE id = ? LIMIT 1',
      [id]
    ) as Array<Record<string, unknown>>;
    const row = created[0] || {};
    return {
      id,
      conversationId: input.conversationId,
      seq: Number(row.seq || 0),
      sender: input.sender,
      senderName: input.senderName || '',
      text: input.text,
      tokens: input.tokens || 0,
      runId: input.runId ?? null,
      createdAt: row.created_at ? String(row.created_at) : undefined,
      attachments: attachments.map(toRef),
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/** 按会话分页取消息（seq 游标，含附件），seq 由自增保证并发追加不重不漏 */
export async function listMessages(conversationId: string, opts: { cursor?: string | null; limit?: number } = {}): Promise<Page<ConversationMessage>> {
  if (!isDbConfigured()) return { items: [], nextCursor: null };
  await ensureSchema();
  const limit = Math.min(Math.max(opts.limit || 50, 1), 200);
  const cursor = opts.cursor ? Number(opts.cursor) : 0;
  const rows = await getPool().query(
    'SELECT id, conversation_id, seq, sender, sender_name, text, tokens, run_id, created_at FROM conversation_messages WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
    [conversationId, Number.isFinite(cursor) ? cursor : 0, limit + 1]
  ) as Array<Record<string, unknown>>;
  const hasMore = rows.length > limit;
  const slice = rows.slice(0, limit);
  const attMap = await listAttachmentsForConversationMessages(slice.map((r) => String(r.id)));
  const items: ConversationMessage[] = slice.map((r) => {
    const id = String(r.id);
    const atts = attMap[id] || [];
    return {
      id,
      conversationId: String(r.conversation_id),
      seq: Number(r.seq),
      sender: r.sender === 'me' ? 'me' : 'employee',
      senderName: String(r.sender_name || ''),
      text: String(r.text || ''),
      tokens: Number(r.tokens || 0),
      runId: r.run_id === null || r.run_id === undefined ? null : String(r.run_id),
      createdAt: r.created_at ? String(r.created_at) : undefined,
      attachments: atts.map(toRef),
    };
  });
  const nextCursor = hasMore && items.length ? String(items[items.length - 1].seq) : null;
  return { items, nextCursor };
}

async function listAttachmentsForConversationMessages(messageIds: string[]): Promise<Record<string, AttachmentRecord[]>> {
  const result: Record<string, AttachmentRecord[]> = {};
  if (!messageIds.length) return result;
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = await getPool().query(
    `SELECT a.id, a.owner_type, a.owner_id, a.original_name, a.mime_type, a.size_bytes, a.category, a.status,
            a.extracted_text, a.extraction_meta, a.error_message, a.created_at, ma.message_id, ma.sort_order
     FROM attachments a
     JOIN conversation_message_attachments ma ON ma.attachment_id = a.id
     WHERE ma.message_id IN (${placeholders})
     ORDER BY ma.sort_order ASC, a.created_at ASC`,
    messageIds
  ) as Array<Record<string, unknown>>;
  for (const row of rows) {
    const messageId = String(row.message_id);
    (result[messageId] ||= []).push({
      id: String(row.id),
      ownerType: String(row.owner_type) as AttachmentRecord['ownerType'],
      ownerId: String(row.owner_id),
      originalName: String(row.original_name),
      mimeType: String(row.mime_type),
      sizeBytes: Number(row.size_bytes),
      category: String(row.category) as AttachmentRecord['category'],
      status: String(row.status) as AttachmentRecord['status'],
      extractedText: row.extracted_text === null || row.extracted_text === undefined ? null : String(row.extracted_text),
      extractionMeta: row.extraction_meta === null || row.extraction_meta === undefined ? null : (typeof row.extraction_meta === 'object' ? row.extraction_meta as Record<string, unknown> : null),
      errorMessage: row.error_message === null || row.error_message === undefined ? null : String(row.error_message),
      createdAt: row.created_at ? String(row.created_at) : undefined,
    });
  }
  return result;
}

/** 迁移内部使用：在给定连接上幂等插入一条会话消息（跳过已存在 ID） */
export async function insertMessageIgnoring(
  connection: PoolConnection,
  input: { id: string; conversationId: string; sender: 'me' | 'employee'; senderName?: string; text: string; tokens?: number }
): Promise<boolean> {
  const result = await connection.query(
    'INSERT IGNORE INTO conversation_messages (id, conversation_id, sender, sender_name, text, tokens) VALUES (?, ?, ?, ?, ?, ?)',
    [input.id, input.conversationId, input.sender, input.senderName || '', input.text, input.tokens || 0]
  ) as { affectedRows?: number };
  return (result.affectedRows || 0) > 0;
}

/** 迁移内部使用：在给定连接上幂等插入一条消息-附件关联 */
export async function insertAttachmentLinkIgnoring(
  connection: PoolConnection,
  messageId: string,
  attachmentId: string,
  sortOrder: number
): Promise<boolean> {
  const result = await connection.query(
    'INSERT IGNORE INTO conversation_message_attachments (message_id, attachment_id, sort_order) VALUES (?, ?, ?)',
    [messageId, attachmentId, sortOrder]
  ) as { affectedRows?: number };
  return (result.affectedRows || 0) > 0;
}
