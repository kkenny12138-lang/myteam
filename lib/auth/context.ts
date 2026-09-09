/**
 * 租户请求上下文与鉴权（docs/MULTI_TENANCY_IMPLEMENTATION_SPEC.md §3.1）。
 *
 * tenantId 只能由服务端根据登录 session 与 URL 中的 slug 解析，
 * 绝不信任 body / query / header 传入的 tenantId。
 */
import { ensureSchema, getPool, isDbConfigured } from '@/lib/db';
import { ApiError } from '@/lib/agent/validators';
import { findSessionByToken, getUserById, readSessionToken, type SessionUser } from '@/lib/auth/session';

/** 当前租户仅由服务端写入 cookie；实际权限仍由 tenant_members 二次校验。 */
export const ACTIVE_TENANT_COOKIE = 'myteam_active_tenant';

function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get('cookie');
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0 || part.slice(0, idx).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(idx + 1).trim()); } catch { return null; }
  }
  return null;
}

export type TenantRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface TenantContext {
  tenantId: string;
  tenantSlug: string;
  userId: string;
  role: TenantRole;
}

export const TENANT_ROLES: TenantRole[] = ['owner', 'admin', 'member', 'viewer'];

/** 平台运维身份白名单（环境变量，逗号分隔邮箱；不写入 schema） */
function platformOpsEmails(): Set<string> {
  const raw = process.env.PLATFORM_OPS_EMAILS || '';
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

export function isPlatformOps(user: Pick<SessionUser, 'email'>): boolean {
  return platformOpsEmails().has(user.email.toLowerCase());
}

/** 校验请求来自平台运维身份（先 session 后白名单），否则 401/403。 */
export async function requirePlatformOps(request: Request): Promise<SessionUser> {
  const user = await requireSessionUser(request);
  if (!isPlatformOps(user)) throw new ApiError('forbidden', '仅平台运维可修改公共角色配置', 403);
  return user;
}

/** 从 URL 中解析 /api/t/:tenantSlug/... 的 slug；非租户路径返回 null。 */
export function parseTenantSlug(pathname: string): string | null {
  const match = pathname.match(/^\/api\/t\/([^/]+)(?:\/|$)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/** 读取有效 session，未登录返回 401；DB 不可用返回 503。 */
export async function requireSessionUser(request: Request): Promise<SessionUser> {
  if (!isDbConfigured()) throw new ApiError('db_unavailable', '数据库未配置', 503);
  const token = readSessionToken(request);
  if (!token) throw new ApiError('unauthenticated', '未登录或会话已过期', 401);
  const session = await findSessionByToken(token);
  if (!session) throw new ApiError('unauthenticated', '未登录或会话已过期', 401);
  const user = await getUserById(session.userId);
  if (!user) throw new ApiError('unauthenticated', '用户不存在', 401);
  if (user.status !== 'active') throw new ApiError('user_disabled', '用户已被停用', 403);
  return user;
}

/**
 * 解析并校验租户上下文：
 * 1. 校验 session cookie（401）
 * 2. 从 URL 读取 slug，查询 tenants + tenant_members（404，避免枚举租户存在性）
 * 3. 成员必须 active（403）
 */
export async function requireTenantContext(request: Request): Promise<TenantContext> {
  const user = await requireSessionUser(request);
  const url = new URL(request.url);
  const slug = parseTenantSlug(url.pathname);
  if (!slug) throw new ApiError('tenant_not_found', '租户不存在', 404);
  return await resolveTenantContext(user, slug);
}

/** 按用户 + slug 解析租户上下文（供测试 / 内部复用） */
export async function resolveTenantContext(user: SessionUser, slug: string): Promise<TenantContext> {
  await ensureSchema();
  const tenantRows = await getPool().query(
    'SELECT id, slug FROM tenants WHERE slug = ? AND status = ? LIMIT 1',
    [slug, 'active']
  ) as Array<Record<string, unknown>>;
  const tenant = tenantRows[0];
  if (!tenant) throw new ApiError('tenant_not_found', '租户不存在', 404);

  const memberRows = await getPool().query(
    'SELECT role FROM tenant_members WHERE tenant_id = ? AND user_id = ? AND status = ? LIMIT 1',
    [tenant.id, user.userId, 'active']
  ) as Array<Record<string, unknown>>;
  const member = memberRows[0];
  if (!member) throw new ApiError('tenant_access_denied', '你不是该租户的成员', 403);

  const role = String(member.role);
  if (!TENANT_ROLES.includes(role as TenantRole)) throw new ApiError('tenant_access_denied', '未知的租户角色', 403);

  return {
    tenantId: String(tenant.id),
    tenantSlug: slug,
    userId: user.userId,
    role: role as TenantRole,
  };
}

/** 校验角色：ctx.role 必须落在允许列表内，否则 403。 */
export function requireRole(ctx: TenantContext, ...roles: TenantRole[]): void {
  if (!roles.includes(ctx.role)) {
    throw new ApiError('forbidden', `需要 ${roles.join('/')} 权限`, 403);
  }
}

/** 判断角色是否足够（纯函数，供测试与 UI 使用） */
export function hasRole(ctx: TenantContext, ...roles: TenantRole[]): boolean {
  return roles.includes(ctx.role);
}

/**
 * 旧接口兼容：解析 session 后，若用户只有唯一一个 active 租户成员身份则返回该租户上下文；
 * 零个返回 403，多个返回 400（需显式指定租户）。新代码请使用 /api/t/[tenantSlug]/...。
 */
export async function requireLegacyTenantContext(request: Request): Promise<TenantContext> {
  const user = await requireSessionUser(request);
  const selectedSlug = readCookie(request, ACTIVE_TENANT_COOKIE);
  if (selectedSlug) return resolveTenantContext(user, selectedSlug);
  await ensureSchema();
  const rows = await getPool().query(
    `SELECT t.id, t.slug, tm.role FROM tenant_members tm JOIN tenants t ON t.id = tm.tenant_id
     WHERE tm.user_id = ? AND tm.status = 'active' AND t.status = 'active' ORDER BY t.created_at ASC`,
    [user.userId]
  ) as Array<Record<string, unknown>>;
  if (rows.length === 0) throw new ApiError('tenant_access_denied', '你不是任何租户的成员', 403);
  if (rows.length > 1) throw new ApiError('tenant_ambiguous', '你属于多个租户，请使用 /api/t/[tenantSlug]/... 指定租户', 400);
  const r = rows[0];
  const role = String(r.role);
  if (!TENANT_ROLES.includes(role as TenantRole)) throw new ApiError('tenant_access_denied', '未知的租户角色', 403);
  return {
    tenantId: String(r.id),
    tenantSlug: String(r.slug),
    userId: user.userId,
    role: role as TenantRole,
  };
}
