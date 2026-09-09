/**
 * PATCH/DELETE /api/t/[tenantSlug]/members/[userId] — 调整成员角色 / 移除成员（owner/admin）。
 */
import { requireRole, requireTenantContext } from '@/lib/auth/context';
import { removeTenantMember, upsertTenantMember } from '@/lib/repositories/tenants';
import type { TenantRole } from '@/lib/auth/context';

export async function PATCH(request: Request, { params }: { params: Promise<{ tenantSlug: string; userId: string }> }) {
  try {
    const ctx = await requireTenantContext(request);
    requireRole(ctx, 'owner', 'admin');
    const { userId } = await params;
    const body = await request.json() as { role?: string; status?: string };
    const role = body.role;
    if (role !== 'owner' && role !== 'admin' && role !== 'member' && role !== 'viewer') {
      return Response.json({ error: 'role 必须是 owner/admin/member/viewer' }, { status: 400 });
    }
    if ((role === 'owner' || role === 'admin') && ctx.role !== 'owner') {
      return Response.json({ error: '只有 owner 能授予 owner/admin 角色' }, { status: 403 });
    }
    const member = await upsertTenantMember(ctx.tenantId, { userId, role: role as TenantRole });
    return Response.json({ member });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '更新失败' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ tenantSlug: string; userId: string }> }) {
  try {
    const ctx = await requireTenantContext(request);
    requireRole(ctx, 'owner', 'admin');
    const { userId } = await params;
    if (userId === ctx.userId) return Response.json({ error: '不能移除自己' }, { status: 400 });
    const removed = await removeTenantMember(ctx.tenantId, userId);
    return Response.json({ ok: true, removed });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '移除失败' }, { status: 500 });
  }
}
