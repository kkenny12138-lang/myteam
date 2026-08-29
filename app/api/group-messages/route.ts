import { ensureSchema, getPool, isDbConfigured } from '@/lib/db';

type GroupMessage = { id: string; sender: 'me' | 'employee'; senderName: string; text: string; time: string; tokens?: number };
type GroupMessageMap = Record<string, GroupMessage[]>;

/** GET /api/group-messages — 返回全部群消息（按群 id 分组） */
export async function GET() {
  try {
    if (!isDbConfigured()) return Response.json({ groupMessages: null }, { status: 503 });
    await ensureSchema();
    const rows = await getPool().query(
      'SELECT id, group_id, sender, sender_name, text, time, tokens FROM group_messages ORDER BY group_id ASC, created_at ASC, id ASC'
    ) as Array<Record<string, unknown>>;
    const groupMessages: GroupMessageMap = {};
    for (const r of rows) {
      const groupId = String(r.group_id);
      (groupMessages[groupId] ||= []).push({
        id: String(r.id),
        sender: r.sender === 'me' ? 'me' : 'employee',
        senderName: String(r.sender_name || ''),
        text: String(r.text || ''),
        time: String(r.time || ''),
        tokens: r.tokens ? Number(r.tokens) : undefined,
      });
    }
    return Response.json({ groupMessages });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '数据库访问失败' }, { status: 500 });
  }
}

/** PUT /api/group-messages — 整体替换群消息 */
export async function PUT(request: Request) {
  try {
    const body = await request.json() as { groupMessages?: GroupMessageMap };
    const groupMessages = body.groupMessages && typeof body.groupMessages === 'object' ? body.groupMessages : null;
    if (!groupMessages) return Response.json({ error: '参数不正确：缺少 groupMessages' }, { status: 400 });
    if (!isDbConfigured()) return Response.json({ error: '数据库未配置' }, { status: 503 });
    const pool = getPool();
    await ensureSchema();
    const connection = await pool.getConnection();
    const values: Array<[string, string, string, string, string, string, number]> = [];
    try {
      await connection.beginTransaction();
      await connection.query('DELETE FROM group_messages');
      for (const [groupId, list] of Object.entries(groupMessages)) {
        for (const m of list) {
          if (!m?.id) continue;
          values.push([m.id, groupId, m.sender === 'me' ? 'me' : 'employee', m.senderName || '', m.text || '', m.time || '', m.tokens || 0]);
        }
      }
      if (values.length) {
        await connection.batch('INSERT INTO group_messages (id, group_id, sender, sender_name, text, time, tokens) VALUES (?, ?, ?, ?, ?, ?, ?)', values);
      }
      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
    return Response.json({ ok: true, count: values.length });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '保存失败' }, { status: 500 });
  }
}

/** DELETE /api/group-messages?group=xxx — 清空某个群的消息 */
export async function DELETE(request: Request) {
  try {
    const group = new URL(request.url).searchParams.get('group');
    if (!group) return Response.json({ error: '参数不正确：缺少 group' }, { status: 400 });
    if (!isDbConfigured()) return Response.json({ error: '数据库未配置' }, { status: 503 });
    await ensureSchema();
    await getPool().query('DELETE FROM group_messages WHERE group_id = ?', [group]);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '删除失败' }, { status: 500 });
  }
}
