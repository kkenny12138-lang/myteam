import { ACTIVE_TENANT_COOKIE, requireTenantContext } from '@/lib/auth/context';
import { sessionCookieSecure } from '@/lib/auth/session';

/** 选择当前租户，供兼容旧 API 的页面安全切换数据上下文。 */
export async function POST(request: Request) {
  try {
    const ctx = await requireTenantContext(request);
    const cookie = [
      `${ACTIVE_TENANT_COOKIE}=${encodeURIComponent(ctx.tenantSlug)}`,
      'HttpOnly',
      sessionCookieSecure() ? 'Secure' : null,
      'SameSite=Lax',
      'Path=/',
      `Max-Age=${30 * 24 * 60 * 60}`,
    ].filter(Boolean).join('; ');
    return Response.json({ ok: true, tenant: ctx }, { headers: { 'Set-Cookie': cookie } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '切换租户失败' }, { status: 500 });
  }
}
