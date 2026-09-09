/**
 * POST /api/auth/logout — 注销会话并清除 Cookie。
 */
import { clearSessionCookieHeader, deleteSessionByToken, readSessionToken } from '@/lib/auth/session';

export async function POST(request: Request) {
  const token = readSessionToken(request);
  if (token) await deleteSessionByToken(token);
  return Response.json({ ok: true }, { headers: { 'Set-Cookie': clearSessionCookieHeader() } });
}
