/**
 * POST /api/agent/migrate — 手动触发旧数据幂等迁移（docs §4.3）。
 * 幂等：schema_migrations 记录已执行则跳过。
 */
import { errorBody, newRequestId } from '@/lib/agent/validators';
import { migrateToAgentPlatform } from '@/lib/agent/migrate';

export async function POST() {
  const requestId = newRequestId();
  try {
    const result = await migrateToAgentPlatform();
    return Response.json({ requestId, ok: true, ...result });
  } catch (error) {
    return Response.json(errorBody(error instanceof Error ? error : new Error('迁移失败'), requestId), { status: 500 });
  }
}
