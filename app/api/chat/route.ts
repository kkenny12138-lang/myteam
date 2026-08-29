type IncomingMessage = { sender: 'me' | 'employee'; text: string };
type ChatModel = 'kimi' | 'deepseek';
type AnswerMode = 'fast' | 'deep';
type ChatRequest = { model: ChatModel; mode?: AnswerMode; employee: { name: string; role: string; department: string }; messages: IncomingMessage[]; experts?: Array<{ name: string; domain: string }>; group?: { name: string; members: Array<{ name: string; role: string }> } };

const providers = {
  kimi: { endpoint: 'https://api.moonshot.cn/v1/chat/completions', keyName: 'KIMI_API_KEY', model: () => process.env.KIMI_MODEL || 'kimi-k2.6' },
  deepseek: { endpoint: 'https://api.deepseek.com/chat/completions', keyName: 'DEEPSEEK_API_KEY', model: () => process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash' },
} as const;

const personas: Record<string, string> = {
  马斯克: '使用第一性原理，敢于挑战假设，强调速度、工程可行性和可衡量结果。给出直接、结构清楚且可执行的建议。',
  巴菲特: '坚持价值投资、长期主义和安全边际。优先分析现金流、风险、机会成本和可持续回报，不追逐短期噪音。',
  芒格: '使用多元思维模型和逆向思考，主动指出认知偏差、关键风险和二阶效应。表达简洁但有洞察。',
  乔布斯: '从用户体验与产品本质出发，追求聚焦、简洁和卓越。敢于砍掉不重要的功能，并明确产品取舍。',
};

export async function POST(request: Request) {
  try {
    const body = await request.json() as ChatRequest;
    if (!body.employee?.name || !Array.isArray(body.messages) || !(body.model in providers)) return Response.json({ error: '请求格式不正确' }, { status: 400 });
    const provider = providers[body.model];
    const apiKey = process.env[provider.keyName];
    if (!apiKey) return Response.json({ error: `本地尚未配置 ${provider.keyName}` }, { status: 503 });
    const history = body.messages.slice(-20).map((message) => ({ role: message.sender === 'me' ? 'user' : 'assistant', content: message.text }));
    let instructions = `你是用户公司里的 AI 员工“${body.employee.name}”，职位是“${body.employee.role}”，所属“${body.employee.department}”。${personas[body.employee.name] || '以该职位的专业能力思考并回复，给出具体、可靠、可执行的建议。'}\n始终使用中文，以真实同事对话的口吻回复。不要声称自己是真人，不编造已经执行过的工作。信息不足时先提出最关键的澄清问题。回复适合聊天窗口阅读：使用简短段落；有多个要点时使用 Markdown 列表；只在必要时使用小标题和加粗；避免大段连续文字。`;
    if (body.experts?.length) {
      const expertList = body.experts.map((e) => `@${e.name}（${e.domain}）`).join('、');
      instructions += `\n你是团队调度者：收到任务后先解析问题本质，判断应由哪位专家负责，并在回复中直接 @ 该专家（例如 @巴菲特），方便用户一键跳转。可用专家：${expertList}。需要时可同时 @ 多位专家；若属于你自己能直接处理的战略层问题，可自行给出方案，并在结尾说明是否需要交给某人跟进。@ 的名字必须与专家清单完全一致，不要杜撰。`;
    }
    if (body.group?.name && Array.isArray(body.group.members)) {
      const members = body.group.members.map((m) => m.name).join('、');
      instructions += `\n你正在群“${body.group.name}”中回答（成员包括：${members}，以及用户本人）。回复时用“@名字”提及或指派相关成员；如果某个更适合处理此事的同事不在群里，直接在回复中 @ 他的名字，系统会自动把 TA 拉进群。@ 的名字必须是上述成员或可用专家中的真实名字。`;
    }
    const mode: AnswerMode = body.mode === 'deep' ? 'deep' : 'fast';
    const requestBody: Record<string, unknown> = { model: provider.model(), messages: [{ role: 'system', content: instructions }, ...history], stream: false, max_tokens: mode === 'deep' ? 6000 : 1600 };
    if (body.model === 'kimi') requestBody.thinking = { type: mode === 'deep' ? 'enabled' : 'disabled' };
    let response = await fetch(provider.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) });
    let data = await response.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string }; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
    if (!response.ok) return Response.json({ error: data.error?.message || '模型服务请求失败' }, { status: response.status });
    let text = data.choices?.[0]?.message?.content;
    let usage = data.usage;
    if (!text && body.model === 'kimi' && mode === 'deep') {
      requestBody.thinking = { type: 'disabled' };
      requestBody.max_tokens = 1600;
      response = await fetch(provider.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) });
      data = await response.json() as typeof data;
      if (!response.ok) return Response.json({ error: data.error?.message || '模型服务请求失败' }, { status: response.status });
      text = data.choices?.[0]?.message?.content;
      usage = data.usage;
    }
    if (!text) return Response.json({ error: '模型没有返回文本内容' }, { status: 502 });
    return Response.json({ text, provider: body.model, model: provider.model(), usage });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : '服务暂时不可用' }, { status: 500 }); }
}
