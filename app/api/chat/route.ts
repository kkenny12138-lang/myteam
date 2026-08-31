/**
 * POST /api/chat — 单聊/群聊调用（Phase 0 改造）。
 *
 * 改造要点（docs Phase 0）：
 * - 优先接收 employeeId，服务端按权威数据读取员工档案（employees / employee_profiles）
 * - 员工的优点、缺点、不擅长、Skill 进入 system prompt（经 Prompt Builder 组装）
 * - 模型调用统一走 Model Gateway；浏览器不能通过伪造姓名改变 Agent 身份
 * - 向后兼容：仍支持传 employee:{name,role,department}（无档案时降级为旧行为）
 */
import { getEmployeeProfile } from '@/lib/agent/context-builder';
import { buildSystemPrompt } from '@/lib/agent/prompt-builder';
import { getAgentByEmployeeId } from '@/lib/repositories/agents';
import { listAgentSkills } from '@/lib/repositories/skills';
import { listMemories } from '@/lib/repositories/memories';
import { getAttachmentBytes, getAttachments } from '@/lib/repositories/attachments';
import { defaultModel, generate, modelCapabilities } from '@/lib/models/gateway';
import { ensureSchema, getPool, isDbConfigured } from '@/lib/db';
import type { AttachmentRecord, ChatMessage, MessageContentPart, ModelProvider } from '@/lib/agent/types';

type IncomingMessage = { sender: 'me' | 'employee'; text: string };
type AnswerMode = 'fast' | 'deep';
type ChatRequest = {
  model: ModelProvider;
  mode?: AnswerMode;
  employee?: { name?: string; role?: string; department?: string };
  employeeId?: string;
  messages: IncomingMessage[];
  attachmentIds?: string[];
  groupId?: string;
  experts?: Array<{ name: string; domain: string }>;
  group?: { name: string; members: Array<{ name: string; role: string }> };
};

export async function POST(request: Request) {
  try {
    const body = await request.json() as ChatRequest;
    if (!body.messages || !Array.isArray(body.messages) || !(body.model === 'kimi' || body.model === 'deepseek')) {
      return Response.json({ error: '请求格式不正确' }, { status: 400 });
    }

    // ---- 服务端按权威 ID 加载员工身份与档案 ----
    let name = body.employee?.name || '';
    let role = body.employee?.role || '';
    let department = body.employee?.department || '';
    let profile = null;
    let employeeId: string | null = null;
    let agent = null;
    let skills: Awaited<ReturnType<typeof listAgentSkills>> = [];
    let memories: Awaited<ReturnType<typeof listMemories>> = [];

    if (body.employeeId) {
      employeeId = body.employeeId;
      if (isDbConfigured()) {
        await ensureSchema();
        const rows = await getPool().query(
          'SELECT id, name, role, department FROM employees WHERE id = ? LIMIT 1',
          [employeeId]
        ) as Array<Record<string, unknown>>;
        const emp = rows[0];
        if (emp) {
          name = String(emp.name);
          role = String(emp.role);
          department = String(emp.department);
        }
        profile = await getEmployeeProfile(employeeId);
        agent = await getAgentByEmployeeId(employeeId);
        if (agent) {
          skills = (await listAgentSkills(agent.id)).filter((s) => s.status === 'published');
          memories = await listMemories(agent.id, undefined, 10);
        }
      }
    }

    const history: ChatMessage[] = body.messages.slice(-20).map((m) => ({
      role: m.sender === 'me' ? 'user' : 'assistant',
      content: m.text,
    }));

    // ---- 加载并校验附件（归属会话 = 单聊员工 或 群聊群组） ----
    const attachmentIds = Array.isArray(body.attachmentIds)
      ? body.attachmentIds.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, 5)
      : [];
    const ownerType: 'single' | 'group' = body.groupId ? 'group' : 'single';
    const ownerId = body.groupId || employeeId || '';
    const attachments: AttachmentRecord[] = await loadAndValidateAttachments(attachmentIds, ownerType, ownerId);

    // ---- 组装 system prompt（Prompt Builder 固定顺序） ----
    let extra = '';
    const provider = body.model;
    const modelName = defaultModel(provider);
    const caps = modelCapabilities(provider, modelName);
    const personas: Record<string, string> = {
      马斯克: '使用第一性原理，敢于挑战假设，强调速度、工程可行性和可衡量结果。给出直接、结构清楚且可执行的建议。',
      巴菲特: '坚持价值投资、长期主义和安全边际。优先分析现金流、风险、机会成本和可持续回报，不追逐短期噪音。',
      芒格: '使用多元思维模型和逆向思考，主动指出认知偏差、关键风险和二阶效应。表达简洁但有洞察。',
      乔布斯: '从用户体验与产品本质出发，追求聚焦、简洁和卓越。敢于砍掉不重要的功能，并明确产品取舍。',
    };
    if (personas[name]) extra += `\n【人格偏好】${personas[name]}`;
    if (body.experts?.length) {
      const expertList = body.experts.map((e) => `@${e.name}（${e.domain}）`).join('、');
      extra += `\n你是团队调度者：收到任务后先解析问题本质，判断应由哪位专家负责，并在回复中直接 @ 该专家（例如 @巴菲特），方便用户一键跳转。可用专家：${expertList}。需要时可同时 @ 多位专家；若属于你自己能直接处理的战略层问题，可自行给出方案，并在结尾说明是否需要交给某人跟进。@ 的名字必须与专家清单完全一致，不要杜撰。`;
    }
    if (body.group?.name && Array.isArray(body.group.members)) {
      const members = body.group.members.map((m) => m.name).join('、');
      extra += `\n你正在群“${body.group.name}”中回答（成员包括：${members}，以及用户本人）。回复时用“@名字”提及或指派相关成员；如果某个更适合处理此事的同事不在群里，直接在回复中 @ 他的名字，系统会自动把 TA 拉进群。@ 的名字必须是上述成员或可用专家中的真实名字。`;
    }
    if (attachments.some((a) => a.category === 'image') && !caps.imageInput) {
      extra += '\n注意：用户本次上传了图片，但当前模型不支持直接识别图片内容。请在回复开头明确说明你无法查看图片，并请用户用文字描述图片内容或改用支持视觉的模型；不要假装已经看懂图片。';
    }

    // 员工 Agent 已存在 → 用它的权威配置 + Prompt Builder
    let system: string;
    if (agent) {
      system = buildSystemPrompt({ agent, profile, skills, memories, extra });
    } else if (profile) {
      // 档案存在但没有 Agent 记录：用档案组装（兼容期）
      system = buildSystemPrompt({
        agent: {
          id: `legacy_${employeeId ?? name}`,
          agentType: 'employee',
          employeeId,
          name,
          systemInstructions: '',
          modelProvider: body.model,
          modelName: '',
          config: { role, department },
          status: 'active',
          version: 1,
        },
        profile,
        skills: [],
        memories: [],
        extra,
      });
    } else {
      // 完全无档案：降级为旧行为
      system = `你是用户公司里的 AI 员工“${name}”，职位是“${role}”，所属“${department}”。${personas[name] || '以该职位的专业能力思考并回复，给出具体、可靠、可执行的建议。'}\n始终使用中文，以真实同事对话的口吻回复。不要声称自己是真人，不编造已经执行过的工作。信息不足时先提出最关键的澄清问题。回复适合聊天窗口阅读：使用简短段落；有多个要点时使用 Markdown 列表；只在必要时使用小标题和加粗；避免大段连续文字。${extra}`;
    }

    const mode: AnswerMode = body.mode === 'deep' ? 'deep' : 'fast';
    // 全局领先：模型名一律按用户所选供应商解析，忽略 Agent 自身的 modelProvider/modelName。
    const messages = await buildMessagesWithAttachments(history, attachments, caps);
    const result = await generate({
      provider,
      model: modelName,
      system,
      messages,
      temperature: agent?.config?.temperature ?? 0.6,
      maxTokens: mode === 'deep' ? 6000 : 1600,
    });

    return Response.json({ text: result.text, provider: body.model, model: result.modelName, usage: result.usage });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '服务暂时不可用' }, { status: 500 });
  }
}

/** 校验附件归属与状态（文档 §7.4 处理顺序 1-3） */
async function loadAndValidateAttachments(
  ids: string[],
  ownerType: 'single' | 'group',
  ownerId: string
): Promise<AttachmentRecord[]> {
  if (!ids.length) return [];
  if (!ownerId) throw new Error('无法确定附件归属会话');
  const attachments = await getAttachments(ids);
  const byId = new Map(attachments.map((a) => [a.id, a]));
  const result: AttachmentRecord[] = [];
  for (const id of ids) {
    const att = byId.get(id);
    if (!att || att.status === 'deleted') throw new Error('附件不存在或已删除');
    if (att.status !== 'ready') throw new Error(`附件「${att.originalName}」尚未就绪`);
    if (att.ownerType !== ownerType || att.ownerId !== ownerId) throw new Error('附件不属于当前会话');
    result.push(att);
  }
  return result;
}

/** 把附件内容并入最后一条用户消息（文档 §7.4 处理顺序 4-5） */
async function buildMessagesWithAttachments(
  history: ChatMessage[],
  attachments: AttachmentRecord[],
  caps: ReturnType<typeof modelCapabilities>
): Promise<ChatMessage[]> {
  if (!attachments.length) return history;
  let lastUserIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user') { lastUserIdx = i; break; }
  }
  const lastContent = lastUserIdx >= 0 ? history[lastUserIdx].content : '';
  const baseText = typeof lastContent === 'string' ? lastContent : '';
  const parts: MessageContentPart[] = [];
  if (baseText.trim()) parts.push({ type: 'text', text: baseText.trim() });
  for (const att of attachments) {
    if (att.category === 'image') {
      if (caps.imageInput) {
        const file = await getAttachmentBytes(att.id);
        if (file && file.bytes.length <= 8 * 1024 * 1024) {
          parts.push({ type: 'image', attachmentId: att.id, mimeType: att.mimeType, url: bytesToDataUrl(att.mimeType, file.bytes) });
        } else if (file) {
          parts.push({ type: 'text', text: `[图片附件「${att.originalName}」过大，未能发送给模型识别，请压缩后重试]` });
        } else {
          parts.push({ type: 'text', text: `[图片附件「${att.originalName}」已无法读取]` });
        }
      } else {
        parts.push({ type: 'text', text: `[用户上传了图片「${att.originalName}」]` });
      }
    } else {
      const text = (att.extractedText || '').trim();
      if (text) {
        parts.push({ type: 'text', text: `【附件：${att.originalName}】\n${text.slice(0, 6000)}` });
      } else {
        const note = String(att.extractionMeta?.note || att.errorMessage || '（该附件暂不支持在线解析文本）');
        parts.push({ type: 'text', text: `【附件：${att.originalName}】${note}` });
      }
    }
  }
  const singleText = parts.length === 1 && parts[0].type === 'text' ? parts[0].text : null;
  const content: string | MessageContentPart[] = singleText !== null ? singleText : parts;
  if (lastUserIdx >= 0) {
    history[lastUserIdx] = { role: 'user', content };
  } else if (parts.length) {
    history.push({ role: 'user', content });
  }
  return history;
}

function bytesToDataUrl(mimeType: string, bytes: Uint8Array): string {
  // Node 环境（生产）下使用 Buffer；必要时回退到逐块 btoa
  if (typeof Buffer !== 'undefined') {
    return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
  }
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}
