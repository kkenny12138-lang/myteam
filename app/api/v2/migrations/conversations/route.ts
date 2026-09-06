/**
 * GET/POST /api/v2/migrations/conversations — 显式触发/验证历史会话迁移（S0）。
 * 迁移也可作为部署命令执行：npm run migrate:conversations（scripts/migrations/migrate-conversations.mjs）。
 * 这里提供 HTTP 入口，便于在无 shell 的环境下运行与验证；不会在聊天请求中自动触发。
 */
import { errorBody, newRequestId } from '@/lib/agent/validators';
import { migrateToConversations, verifyConversationMigration } from '@/lib/agent/conversation-migrate';

export async function GET() {
  const requestId = newRequestId();
  try {
    const verification = await verifyConversationMigration();
    return Response.json({ requestId, verification });
  } catch (error) {
    return Response.json(errorBody(error instanceof Error ? error : new Error('校验失败'), requestId), { status: 500 });
  }
}

export async function POST() {
  const requestId = newRequestId();
  try {
    const report = await migrateToConversations();
    return Response.json({ requestId, ok: report.verified, report });
  } catch (error) {
    return Response.json(errorBody(error instanceof Error ? error : new Error('迁移失败'), requestId), { status: 500 });
  }
}
