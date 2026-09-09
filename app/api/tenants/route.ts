import { createTenant, getTenantBySlug, upsertTenantMember } from '@/lib/repositories/tenants';
import { requireSessionUser } from '@/lib/auth/context';
import { ensureSchema, getPool } from '@/lib/db';

function slugify(value: string): string {
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 42) || `team-${Date.now().toString(36)}`;
}

/** 创建独立租户；创建者自动成为 owner。 */
export async function POST(request: Request) {
  try {
    const user = await requireSessionUser(request);
    const body = await request.json().catch(() => null) as { name?: string; slug?: string } | null;
    const name = body?.name?.trim() || '';
    const slug = slugify(body?.slug || name);
    if (!name || name.length > 100) return Response.json({ error: '请输入 1 到 100 个字符的租户名称' }, { status: 400 });
    if (!/^[a-z0-9\u4e00-\u9fa5-]{1,42}$/i.test(slug)) return Response.json({ error: '租户标识格式不正确' }, { status: 400 });
    if (await getTenantBySlug(slug)) return Response.json({ error: '该租户标识已被使用，请换一个名称' }, { status: 409 });
    const tenant = await createTenant({ name, slug });
    await upsertTenantMember(tenant.id, { userId: user.userId, role: 'owner' });
    return Response.json({ tenant: { tenantId: tenant.id, slug: tenant.slug, name: tenant.name, role: 'owner' } }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '创建租户失败' }, { status: 500 });
  }
}

/** 返回当前用户可切换的租户。 */
export async function GET(request: Request) {
  try {
    const user = await requireSessionUser(request);
    await ensureSchema();
    const rows = await getPool().query(
      `SELECT t.id, t.slug, t.name, tm.role FROM tenant_members tm JOIN tenants t ON t.id = tm.tenant_id
       WHERE tm.user_id = ? AND tm.status = 'active' AND t.status = 'active' ORDER BY t.created_at ASC`,
      [user.userId]
    ) as Array<Record<string, unknown>>;
    return Response.json({ tenants: rows.map((r) => ({ tenantId: String(r.id), slug: String(r.slug), name: String(r.name), role: String(r.role) })) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '读取租户失败' }, { status: 500 });
  }
}
