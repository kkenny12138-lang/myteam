import { dbHealth } from '@/lib/db';

/** GET /api/db — 数据库连接状态检查 */
export async function GET() {
  const status = await dbHealth();
  return Response.json({ ok: status.connected, ...status });
}
