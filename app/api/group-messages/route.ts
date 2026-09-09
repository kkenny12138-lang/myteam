import { ensureSchema, getPool, isDbConfigured } from '@/lib/db';
import { clearMessageAttachments, linkMessageAttachment, listAttachmentsForMessages } from '@/lib/repositories/attachments';
import { requireLegacyTenantContext } from '@/lib/auth/context';
import type { AttachmentRecord, AttachmentRef } from '@/lib/agent/types';

type GroupMessage = { id: string; sender: 'me' | 'employee'; senderName: string; text: string; time: string; tokens?: number; attachments?: AttachmentRef[] };
type GroupMessageMap = Record<string, GroupMessage[]>;

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

/** GET /api/group-messages — 返回全部群消息（按群 id 分组，含附件） */
export async function GET(request: Request) {
  try {
    const ctx = await requireLegacyTenantContext(request);
    if (!isDbConfigured()) return Response.json({ groupMessages: null }, { status: 503 });
    await ensureSchema();
    const rows = await getPool().query(
      'SELECT id, group_id, sender, sender_name, text, time, tokens FROM group_messages WHERE tenant_id = ? ORDER BY group_id ASC, created_at ASC, id ASC',
      [ctx.tenantId]
    ) as Array<Record<string, unknown>>;
    const groupMessages: GroupMessageMap = {};
    const ids: string[] = [];
    for (const r of rows) {
      const groupId = String(r.group_id);
      const id = String(r.id);
      ids.push(id);
      (groupMessages[groupId] ||= []).push({
        id,
        sender: r.sender === 'me' ? 'me' : 'employee',
        senderName: String(r.sender_name || ''),
        text: String(r.text || ''),
        time: String(r.time || ''),
        tokens: r.tokens ? Number(r.tokens) : undefined,
        attachments: [],
      });
    }
    const attMap = await listAttachmentsForMessages(ctx.tenantId, 'group', ids);
    for (const list of Object.values(groupMessages)) {
      for (const m of list) {
        const atts = attMap[m.id];
        if (atts?.length) m.attachments = atts.map(toRef);
      }
    }
    return Response.json({ groupMessages });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '数据库访问失败' }, { status: 500 });
  }
}

/** PUT /api/group-messages — 整体替换群消息 */
export async function PUT(request: Request) {
  try {
    const ctx = await requireLegacyTenantContext(request);
    const body = await request.json() as { groupMessages?: GroupMessageMap };
    const groupMessages = body.groupMessages && typeof body.groupMessages === 'object' ? body.groupMessages : null;
    if (!groupMessages) return Response.json({ error: '参数不正确：缺少 groupMessages' }, { status: 400 });
    if (!isDbConfigured()) return Response.json({ error: '数据库未配置' }, { status: 503 });
    const pool = getPool();
    await ensureSchema();
    const connection = await pool.getConnection();
    const values: Array<[string, string, string, string, string, string, number]> = [];
    const relations: Array<[string, string, number]> = [];
    try {
      await connection.beginTransaction();
      await connection.query('DELETE FROM group_messages WHERE tenant_id = ?', [ctx.tenantId]);
      for (const [groupId, list] of Object.entries(groupMessages)) {
        for (const m of list) {
          if (!m?.id) continue;
          values.push([m.id, groupId, m.sender === 'me' ? 'me' : 'employee', m.senderName || '', m.text || '', m.time || '', m.tokens || 0]);
          for (const att of m.attachments || []) {
            if (att?.id) relations.push([m.id, att.id, 0]);
          }
        }
      }
      if (values.length) {
        await connection.batch('INSERT INTO group_messages (id, tenant_id, group_id, sender, sender_name, text, time, tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', values.map((v) => [v[0], ctx.tenantId, v[1], v[2], v[3], v[4], v[5], v[6]]));
      }
      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
    try {
      await clearMessageAttachments(ctx.tenantId, 'group');
      for (const [messageId, attachmentId, sortOrder] of relations) {
        await linkMessageAttachment(ctx.tenantId, 'group', messageId, attachmentId, sortOrder);
      }
    } catch {
      // 关联写入失败不阻断消息保存
    }
    return Response.json({ ok: true, count: values.length });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '保存失败' }, { status: 500 });
  }
}

/** DELETE /api/group-messages?group=xxx — 清空某个群的消息 */
export async function DELETE(request: Request) {
  try {
    const ctx = await requireLegacyTenantContext(request);
    const group = new URL(request.url).searchParams.get('group');
    if (!group) return Response.json({ error: '参数不正确：缺少 group' }, { status: 400 });
    if (!isDbConfigured()) return Response.json({ error: '数据库未配置' }, { status: 503 });
    await ensureSchema();
    await getPool().query('DELETE FROM group_messages WHERE tenant_id = ? AND group_id = ?', [ctx.tenantId, group]);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '删除失败' }, { status: 500 });
  }
}
