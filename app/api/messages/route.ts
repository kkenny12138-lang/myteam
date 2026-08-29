import { ensureSchema, getPool, isDbConfigured } from '@/lib/db';

type Message = { id: string; sender: 'me' | 'employee'; text: string; time: string; tokens?: number };
type MessageMap = Record<string, Message[]>;

/** GET /api/messages — 返回全部聊天记录（按员工分组） */
export async function GET() {
  try {
    if (!isDbConfigured()) return Response.json({ messages: null }, { status: 503 });
    await ensureSchema();
    const rows = await getPool().query(
      'SELECT id, employee_id, sender, text, time, tokens FROM messages ORDER BY employee_id ASC, created_at ASC, id ASC'
    ) as Array<Record<string, unknown>>;
    const messages: MessageMap = {};
    for (const r of rows) {
      const employeeId = String(r.employee_id);
      (messages[employeeId] ||= []).push({
        id: String(r.id),
        sender: r.sender === 'me' ? 'me' : 'employee',
        text: String(r.text),
        time: String(r.time || ''),
        tokens: r.tokens ? Number(r.tokens) : undefined,
      });
    }
    return Response.json({ messages });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '数据库访问失败' }, { status: 500 });
  }
}

/** PUT /api/messages — 整体替换聊天记录 */
export async function PUT(request: Request) {
  try {
    const body = await request.json() as { messages?: MessageMap };
    const messages = body.messages && typeof body.messages === 'object' ? body.messages : null;
    if (!messages) return Response.json({ error: '参数不正确：缺少 messages' }, { status: 400 });
    if (!isDbConfigured()) return Response.json({ error: '数据库未配置' }, { status: 503 });
    const pool = getPool();
    await ensureSchema();
    const connection = await pool.getConnection();
    const values: Array<[string, string, string, string, string, number]> = [];
    try {
      await connection.beginTransaction();
      await connection.query('DELETE FROM messages');
      for (const [employeeId, list] of Object.entries(messages)) {
        for (const m of list) {
          if (!m?.id) continue;
          values.push([m.id, employeeId, m.sender === 'me' ? 'me' : 'employee', m.text || '', m.time || '', m.tokens || 0]);
        }
      }
      if (values.length) {
        await connection.batch('INSERT INTO messages (id, employee_id, sender, text, time, tokens) VALUES (?, ?, ?, ?, ?, ?)', values);
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

/** DELETE /api/messages?employee=xxx — 清空某个员工（单聊）的聊天记录 */
export async function DELETE(request: Request) {
  try {
    const employee = new URL(request.url).searchParams.get('employee');
    if (!employee) return Response.json({ error: '参数不正确：缺少 employee' }, { status: 400 });
    if (!isDbConfigured()) return Response.json({ error: '数据库未配置' }, { status: 503 });
    await ensureSchema();
    await getPool().query('DELETE FROM messages WHERE employee_id = ?', [employee]);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '删除失败' }, { status: 500 });
  }
}
