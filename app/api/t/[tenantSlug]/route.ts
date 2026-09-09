/**
 * GET/DELETE /api/t/[tenantSlug] — 租户信息 / 删除租户（仅 owner）。
 */
import { requireRole, requireTenantContext } from '@/lib/auth/context';
import { deleteTenant, getTenantBySlug } from '@/lib/repositories/tenants';

export async function GET(request: Request) {
  try {
    const ctx = await requireTenantContext(request);
    const tenant = await getTenantBySlug(ctx.tenantSlug);
    return Response.json({ tenant, role: ctx.role });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '读取失败' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireTenantContext(request);
    requireRole(ctx, 'owner');
    const removed = await deleteTenant(ctx.tenantId);
    return Response.json({ ok: true, removed });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '删除失败' }, { status: 500 });
  }
}
