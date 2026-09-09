/**
 * GET /api/auth/me — 返回当前登录用户与所属租户。
 */
import { ensureSchema, getPool } from '@/lib/db';
import { requireSessionUser } from '@/lib/auth/context';

export async function GET(request: Request) {
  try {
    const user = await requireSessionUser(request);
    await ensureSchema();
    const rows = await getPool().query(
      `SELECT t.id, t.slug, t.name, tm.role
       FROM tenant_members tm JOIN tenants t ON t.id = tm.tenant_id
       WHERE tm.user_id = ? AND tm.status = 'active' ORDER BY t.created_at ASC`,
      [user.userId]
    ) as Array<Record<string, unknown>>;
    const tenants = rows.map((r) => ({ tenantId: String(r.id), slug: String(r.slug), name: String(r.name), role: String(r.role) }));
    return Response.json({ user, tenants });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '读取失败' }, { status: 500 });
  }
}
