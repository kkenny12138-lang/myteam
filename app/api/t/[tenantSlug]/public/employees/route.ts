/**
 * GET /api/t/[tenantSlug]/public/employees — 公共员工角色（租户只读，所有租户共享）。
 */
import { ensureSchema, getPool, isDbConfigured } from '@/lib/db';
import { requireTenantContext } from '@/lib/auth/context';

export async function GET(request: Request) {
  try {
    await requireTenantContext(request);
    if (!isDbConfigured()) return Response.json({ employees: null }, { status: 503 });
    await ensureSchema();
    const rows = await getPool().query(
      'SELECT id, name, role, department, initials, color, online FROM employees ORDER BY sort_order ASC, id ASC'
    ) as Array<Record<string, unknown>>;
    const employees = rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      role: String(r.role),
      department: String(r.department),
      initials: String(r.initials),
      color: String(r.color),
      online: Boolean(r.online),
    }));
    return Response.json({ employees });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '数据库访问失败' }, { status: 500 });
  }
}
