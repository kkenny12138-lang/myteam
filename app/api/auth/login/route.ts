/**
 * POST /api/auth/login — 邮箱 + 密码登录，返回服务端 Session Cookie。
 */
import { createSession, getUserByEmail, sessionCookieHeader, SESSION_TTL_MS } from '@/lib/auth/session';
import { verifyPassword } from '@/lib/auth/password';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as { email?: string; password?: string } | null;
    const email = body?.email?.trim().toLowerCase() || '';
    const password = body?.password || '';
    if (!email || !password) return Response.json({ error: '缺少邮箱或密码' }, { status: 400 });

    const user = await getUserByEmail(email);
    if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
      return Response.json({ error: '邮箱或密码不正确' }, { status: 401 });
    }
    if (user.status !== 'active') return Response.json({ error: '用户已被停用' }, { status: 403 });

    const { token } = await createSession(user.userId);
    return Response.json(
      { ok: true, user: { userId: user.userId, email: user.email, displayName: user.displayName } },
      { headers: { 'Set-Cookie': sessionCookieHeader(token, Math.floor(SESSION_TTL_MS / 1000)) } }
    );
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '登录失败' }, { status: 500 });
  }
}
