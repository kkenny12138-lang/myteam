/**
 * GET/POST /api/t/[tenantSlug]/members — 租户成员列表 / 添加成员（owner/admin）。
 */
import { requireRole, requireTenantContext } from '@/lib/auth/context';
import { listTenantMembers, upsertTenantMember } from '@/lib/repositories/tenants';
import type { TenantRole } from '@/lib/auth/context';

export async function GET(request: Request) {
  try {
    const ctx = await requireTenantContext(request);
    requireRole(ctx, 'owner', 'admin');
    const members = await listTenantMembers(ctx.tenantId);
    return Response.json({ members });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '读取失败' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireTenantContext(request);
    requireRole(ctx, 'owner', 'admin');
    const body = await request.json() as { email?: string; displayName?: string; role?: string };
    const email = body.email?.trim().toLowerCase() || '';
    const role = body.role;
    if (!email) return Response.json({ error: '缺少 email' }, { status: 400 });
    if (role !== 'owner' && role !== 'admin' && role !== 'member' && role !== 'viewer') {
      return Response.json({ error: 'role 必须是 owner/admin/member/viewer' }, { status: 400 });
    }
    // 仅 owner 可授予 owner / admin
    if ((role === 'owner' || role === 'admin') && ctx.role !== 'owner') {
      return Response.json({ error: '只有 owner 能授予 owner/admin 角色' }, { status: 403 });
    }
    const member = await upsertTenantMember(ctx.tenantId, { email, displayName: body.displayName, role: role as TenantRole });
    return Response.json({ member }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '添加失败' }, { status: 500 });
  }
}
