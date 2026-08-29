import { ensureSchema, getPool, isDbConfigured } from '@/lib/db';

type Group = { id: string; name: string; members: string[] };

const parseMembers = (v: unknown): string[] => {
  if (!v) return [];
  try {
    const parsed = JSON.parse(String(v));
    return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === 'string') : [];
  } catch {
    return [];
  }
};

/** GET /api/groups — 返回全部群 */
export async function GET() {
  try {
    if (!isDbConfigured()) return Response.json({ groups: null }, { status: 503 });
    await ensureSchema();
    const rows = await getPool().query('SELECT id, name, members FROM chat_groups ORDER BY created_at ASC, id ASC') as Array<Record<string, unknown>>;
    const groups = rows.map((r) => ({ id: String(r.id), name: String(r.name || ''), members: parseMembers(r.members) }));
    return Response.json({ groups });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '数据库访问失败' }, { status: 500 });
  }
}

/** PUT /api/groups — 整体替换群列表 */
export async function PUT(request: Request) {
  try {
    const body = await request.json() as { groups?: Group[] };
    const groups = Array.isArray(body.groups) ? body.groups : null;
    if (!groups) return Response.json({ error: '参数不正确：缺少 groups' }, { status: 400 });
    if (!isDbConfigured()) return Response.json({ error: '数据库未配置' }, { status: 503 });
    const pool = getPool();
    await ensureSchema();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query('DELETE FROM chat_groups');
      for (const g of groups) {
        if (!g?.id || !g.name) continue;
        await connection.query('INSERT INTO chat_groups (id, name, members) VALUES (?, ?, ?)', [g.id, g.name, JSON.stringify(g.members || [])]);
      }
      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
    return Response.json({ ok: true, count: groups.length });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '保存失败' }, { status: 500 });
  }
}

/** DELETE /api/groups?id=xxx — 删除群及其消息 */
export async function DELETE(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return Response.json({ error: '参数不正确：缺少 id' }, { status: 400 });
    if (!isDbConfigured()) return Response.json({ error: '数据库未配置' }, { status: 503 });
    await ensureSchema();
    const pool = getPool();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query('DELETE FROM chat_groups WHERE id = ?', [id]);
      await connection.query('DELETE FROM group_messages WHERE group_id = ?', [id]);
      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '删除失败' }, { status: 500 });
  }
}
