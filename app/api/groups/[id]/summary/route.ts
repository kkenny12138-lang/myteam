import { ensureSchema, getPool } from '@/lib/db';
import { requireLegacyTenantContext, requireRole } from '@/lib/auth/context';
import { defaultModel, generate } from '@/lib/models/gateway';
import type { ModelProvider } from '@/lib/agent/types';

type SummaryRow = { summary: string; source_message_count: number; updated_at: string | Date | null };

async function requireGroup(tenantId: string, groupId: string) {
  const rows = await getPool().query('SELECT id, name FROM chat_groups WHERE id = ? AND tenant_id = ? LIMIT 1', [groupId, tenantId]) as Array<{ id: string; name: string }>;
  if (!rows[0]) throw new Error('群不存在或无权访问');
  return rows[0];
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireLegacyTenantContext(request);
    const { id } = await params;
    await ensureSchema();
    await requireGroup(ctx.tenantId, id);
    const rows = await getPool().query('SELECT summary, source_message_count, updated_at FROM group_summaries WHERE tenant_id = ? AND group_id = ? LIMIT 1', [ctx.tenantId, id]) as SummaryRow[];
    const r = rows[0];
    return Response.json({ summary: r?.summary || '', sourceMessageCount: r?.source_message_count || 0, updatedAt: r?.updated_at || null });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '读取群摘要失败' }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireLegacyTenantContext(request);
    requireRole(ctx, 'owner', 'admin', 'member');
    const { id } = await params;
    const body = await request.json().catch(() => ({})) as { model?: ModelProvider };
    const provider = body.model === 'kimi' || body.model === 'deepseek' || body.model === 'openai' ? body.model : 'deepseek';
    await ensureSchema();
    const group = await requireGroup(ctx.tenantId, id);
    const messages = await getPool().query(
      'SELECT sender, sender_name, text FROM group_messages WHERE tenant_id = ? AND group_id = ? ORDER BY created_at ASC, id ASC LIMIT 200',
      [ctx.tenantId, id]
    ) as Array<{ sender: string; sender_name: string; text: string }>;
    if (!messages.length) return Response.json({ error: '群里还没有可总结的消息' }, { status: 400 });
    const transcript = messages.map((m) => `${m.sender === 'me' ? '用户' : (m.sender_name || '群成员')}：${m.text}`).join('\n').slice(-30000);
    const result = await generate({
      provider,
      model: defaultModel(provider),
      tenantId: ctx.tenantId,
      temperature: 0.2,
      maxTokens: 1200,
      system: '你负责为企业协作群提炼可复用上下文。只用中文，输出紧凑且不超过 900 字。按以下固定栏目总结：\n【讨论主题】\n【已确认结论】\n【待决问题】\n【行动项】（负责人、事项、时间若有）\n【关键上下文/风险】\n仅基于对话内容，不补造事实。',
      messages: [{ role: 'user', content: `请总结群「${group.name}」的以下对话：\n${transcript}` }],
    });
    const summary = result.text.trim().slice(0, 5000);
    await getPool().query(
      `INSERT INTO group_summaries (tenant_id, group_id, summary, source_message_count) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE summary = VALUES(summary), source_message_count = VALUES(source_message_count), updated_at = CURRENT_TIMESTAMP`,
      [ctx.tenantId, id, summary, messages.length]
    );
    return Response.json({ summary, sourceMessageCount: messages.length, updatedAt: new Date().toISOString(), usage: result.usage });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '生成群摘要失败' }, { status: 500 });
  }
}
