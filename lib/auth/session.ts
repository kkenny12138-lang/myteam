/**
 * 服务端 Session Cookie 实现（docs/MULTI_TENANCY_IMPLEMENTATION_SPEC.md §3）。
 *
 * - Cookie 只存随机不透明 token（base64url），数据库只保存 SHA-256 哈希。
 * - Cookie 属性：HttpOnly、Secure、SameSite=Lax、Path=/。
 * - Session 过期由 auth_sessions.expires_at 控制，last_seen_at 每次命中时刷新。
 */
import { createHash, randomBytes } from 'node:crypto';
import { ensureSchema, getPool, isDbConfigured } from '@/lib/db';

export const SESSION_COOKIE_NAME = 'myteam_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
export const SESSION_REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 剩余不足 7 天时顺延

export interface SessionUser {
  userId: string;
  email: string;
  displayName: string;
  status: string;
}

export interface SessionInfo {
  sessionId: string;
  userId: string;
  expiresAt: string;
}

/** 生成不透明随机 token（数据库只存它的 SHA-256 哈希） */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 计算 token 的 SHA-256 十六进制摘要 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 从请求 Cookie 头中解析 session token（无则返回 null） */
export function readSessionToken(request: Request): string | null {
  const cookie = request.headers.get('cookie');
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name === SESSION_COOKIE_NAME && value) return value;
  }
  return null;
}

/** 是否在安全上下文（默认 true；本地 HTTP 开发可用 SESSION_COOKIE_SECURE=false 关闭） */
export function sessionCookieSecure(): boolean {
  return process.env.SESSION_COOKIE_SECURE !== 'false';
}

/** 构造 Set-Cookie 响应头（HttpOnly; Secure; SameSite=Lax; Path=/） */
export function sessionCookieHeader(token: string, maxAgeSeconds: number): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'HttpOnly',
    sessionCookieSecure() ? 'Secure' : null,
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
  ];
  return parts.filter(Boolean).join('; ');
}

/** 清除 session 的 Set-Cookie 响应头 */
export function clearSessionCookieHeader(): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    sessionCookieSecure() ? 'Secure' : null,
    'SameSite=Lax',
    'Path=/',
    'Max-Age=0',
  ];
  return parts.filter(Boolean).join('; ');
}

function newSessionId(): string {
  const ts = Date.now().toString(36);
  const rnd = randomBytes(9).toString('hex');
  return `${ts}${rnd}`.slice(0, 26);
}

/** 为指定用户创建一条新 session，返回明文 token（仅此一次可见）。 */
export async function createSession(userId: string): Promise<{ token: string; session: SessionInfo }> {
  if (!isDbConfigured()) throw new Error('数据库未配置，无法创建登录会话');
  await ensureSchema();
  const token = newSessionToken();
  const tokenHash = hashToken(token);
  const id = newSessionId();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await getPool().query(
    'INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)',
    [id, userId, tokenHash, expiresAt]
  );
  return { token, session: { sessionId: id, userId, expiresAt: expiresAt.toISOString() } };
}

/** 按明文 token 校验 session，命中后刷新 last_seen_at；失效/不存在返回 null。 */
export async function findSessionByToken(token: string): Promise<SessionInfo | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const tokenHash = hashToken(token);
  const rows = await getPool().query(
    'SELECT id, user_id, expires_at FROM auth_sessions WHERE token_hash = ? AND expires_at > NOW() LIMIT 1',
    [tokenHash]
  ) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  // 顺延即将过期的会话（非关键路径，失败不影响校验）
  const session: SessionInfo = {
    sessionId: String(row.id),
    userId: String(row.user_id),
    expiresAt: row.expires_at ? String(row.expires_at) : '',
  };
  void getPool().query(
    'UPDATE auth_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?',
    [session.sessionId]
  ).catch(() => undefined);
  return session;
}

/** 注销指定 token 的会话（幂等） */
export async function deleteSessionByToken(token: string): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  await getPool().query('DELETE FROM auth_sessions WHERE token_hash = ?', [hashToken(token)]);
}

/** 按用户查询其身份（供鉴权上下文使用） */
export async function getUserById(userId: string): Promise<SessionUser | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const rows = await getPool().query(
    'SELECT id, email, display_name, status FROM users WHERE id = ? LIMIT 1',
    [userId]
  ) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  return {
    userId: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    status: String(row.status),
  };
}

/** 按邮箱查询用户（含密码哈希，供登录校验使用） */
export async function getUserByEmail(email: string): Promise<(SessionUser & { passwordHash: string | null }) | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const rows = await getPool().query(
    'SELECT id, email, display_name, status, password_hash FROM users WHERE email = ? LIMIT 1',
    [email.toLowerCase()]
  ) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  return {
    userId: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    status: String(row.status),
    passwordHash: row.password_hash === null || row.password_hash === undefined ? null : String(row.password_hash),
  };
}
