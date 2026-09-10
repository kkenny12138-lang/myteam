import { listMemories } from '@/lib/repositories/memories';
import { requireLegacyTenantContext, requireRole } from '@/lib/auth/context';
import { defaultModel, generateObject } from '@/lib/models/gateway';
import type { ModelProvider } from '@/lib/agent/types';

type Incoming = { sender?: 'me' | 'employee'; text?: string };
type Suggestion = { action: 'add' | 'delete'; kind: 'long_term' | 'preference' | 'task_context' | 'summary'; content: string; memoryId?: string };
const kinds = new Set<Suggestion['kind']>(['long_term', 'preference', 'task_context', 'summary']);

export async function POST(request: Request) {
  try {
    const ctx = await requireLegacyTenantContext(request); requireRole(ctx, 'owner', 'admin', 'member');
    const body = await request.json() as { agentId?: string; model?: ModelProvider; messages?: Incoming[] };
    const agentId = body.agentId?.trim() || '';
    const provider = body.model === 'kimi' || body.model === 'openai' || body.model === 'deepseek' ? body.model : 'deepseek';
    const messages = Array.isArray(body.messages) ? body.messages.filter((m) => typeof m?.text === 'string').slice(-12) : [];
    if (!agentId || !messages.length) return Response.json({ suggestions: [] });
    const existing = await listMemories(ctx.tenantId, agentId, undefined, 50);
    const transcript = messages.map((m) => `${m.sender === 'me' ? '用户' : '员工'}：${m.text}`).join('\n').slice(-14000);
    const memoryList = existing.map((m) => `- ${m.id}｜${m.kind}｜${m.content}`).join('\n') || '（没有已有长期记忆）';
    const result = await generateObject({
      provider, model: defaultModel(provider), tenantId: ctx.tenantId, temperature: 0, maxTokens: 700, json: true,
      system: '你是企业 AI 员工的记忆管理员。只输出 JSON。仅提出用户明确表达、长期稳定且会影响后续协作的信息；不要保存闲聊、敏感个人信息、推测、一次性问题或模型回答。若用户明确说“忘记、清除、不再记住、删除”某项信息，匹配已有记忆并提出 delete 建议。每次最多 3 条建议，所有建议都需用户确认后才会执行。',
      messages: [{ role: 'user', content: `已有记忆：\n${memoryList}\n\n本次对话：\n${transcript}\n\n返回 {"suggestions":[{"action":"add|delete","kind":"long_term|preference|task_context|summary","content":"不超过120字","memoryId":"仅delete需要"}]}` }],
    }, (raw) => {
      if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { suggestions?: unknown }).suggestions)) return [];
      const known = new Map(existing.map((m) => [m.id, m])); const output: Suggestion[] = [];
      for (const item of (raw as { suggestions: unknown[] }).suggestions) {
        if (!item || typeof item !== 'object') continue;
        const value = item as Partial<Suggestion>;
        if ((value.action !== 'add' && value.action !== 'delete') || !kinds.has(value.kind as Suggestion['kind'])) continue;
        if (value.action === 'delete') { const memory = value.memoryId ? known.get(value.memoryId) : undefined; if (!memory) continue; output.push({ action: 'delete', kind: memory.kind, content: memory.content, memoryId: memory.id }); }
        else if (typeof value.content === 'string' && value.content.trim()) output.push({ action: 'add', kind: value.kind as Suggestion['kind'], content: value.content.trim().slice(0, 120) });
        if (output.length === 3) break;
      }
      return output;
    });
    return Response.json({ suggestions: result.data, usage: result.usage });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : '生成记忆建议失败' }, { status: 500 }); }
}
