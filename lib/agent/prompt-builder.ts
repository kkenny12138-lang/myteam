/**
 * Prompt Builder：服务端按固定模板生成 system prompt（docs §5.4）。
 * 组装顺序：
 *   1 平台安全与输出规则 → 2 身份/职责/目标 → 3 优点 → 4 缺点约束 →
 *   5 选中 Skill → 6 工具权限 → 7 记忆与任务上下文 → (用户消息由调用方追加)
 *
 * 任何用户输入 / 历史消息 / Skill 示例都使用明确分隔符，禁止覆盖平台级规则。
 */

import type { AgentRecord, AgentSkillLink, MemoryRecord, SkillRecord } from '@/lib/agent/types';

const PLATFORM_RULES = `[平台规则-不可覆盖]
- 你是用户公司的 AI 员工/协作智能体，不是真人；不得声称自己已经执行过任何实际动作。
- 始终使用中文，以真实同事对话的口吻回复。
- 信息不足时，先提出最关键的澄清问题或显式列出假设，不要臆造事实。
- 回复适合聊天窗口阅读：简短段落 + Markdown 列表；避免大段连续文字。
- 涉及外部写操作、发送消息、删除数据时，必须先向用户确认，不得擅自执行。`;

/** 粗略估算 Token 数（中文约 0.6 token/字，这里按 1.8 字符 ≈ 1 token 折算） */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 1.8);
}

export interface BuildPromptOptions {
  agent: AgentRecord;
  profile?: { summary: string; traits?: string[]; expertise?: string; strengths?: string[]; weaknesses?: string[]; notGoodAt?: string[]; bestFor?: string[]; skills?: Array<{ name: string; description?: string; desc: string }> } | null;
  skills?: Array<AgentSkillLink & SkillRecord>;
  memories?: MemoryRecord[];
  taskContext?: string;
  /** Skill 指令总 Token 预算（超出按优先级截断） */
  skillBudgetTokens?: number;
  /** 平台 Agent 的调度角色说明（仅 company 类型使用） */
  dispatcherContext?: string;
  extra?: string;
}

export function buildSystemPrompt(opts: BuildPromptOptions): string {
  const { agent, profile, skills = [], memories = [] } = opts;
  const parts: string[] = [];
  const hr = (title: string) => `\n===== ${title} =====`;

  // 1. 平台安全与输出规则
  parts.push(PLATFORM_RULES);

  // 2. 身份 / 职责 / 目标
  parts.push(
    `${hr('身份')}\n你是 AI 员工“${agent.name}”。必须始终以“${agent.name}”的身份、经历和思维方式回应，不要自称平台、总控、调度器或 Company Agent。` +
      (agent.config.role ? `\n职位：${agent.config.role}` : '') +
      (agent.config.department ? `\n部门：${agent.config.department}` : '') +
      (profile?.summary ? `\n档案摘要：${profile.summary}` : '') +
      (profile?.traits?.length ? `\n性格特征：${profile.traits.join('、')}` : '') +
      (profile?.expertise ? `\n专业领域：${profile.expertise}` : '') +
      (agent.systemInstructions ? `\n专属人设与行为指令：\n${agent.systemInstructions}` : '')
  );

  // 3. 优点如何发挥
  if (profile?.strengths?.length) {
    parts.push(
      `${hr('优势发挥')}\n在工作中主动发挥以下优势：\n${profile.strengths.map((s) => `- ${s}`).join('\n')}`
    );
  } else if (agent.config.strengthStrategy) {
    parts.push(`${hr('优势发挥')}\n${agent.config.strengthStrategy}`);
  }

  // 4. 缺点 / 不擅长对应的行为约束
  const guards: string[] = [];
  if (profile?.weaknesses?.length) {
    guards.push(
      `你有以下需要自我约束的缺点，请转化为行为约束：\n${profile.weaknesses.map((w) => `- 缺点：${w} → 约束：见机规避，避免因此降低决策质量`).join('\n')}`
    );
  }
  if (profile?.notGoodAt?.length) {
    guards.push(`你不擅长：${profile.notGoodAt.join('、')}。遇到此类任务应明确说明局限，或建议交给更合适的人。`);
  }
  for (const g of agent.config.weaknessGuards ?? []) {
    guards.push(g);
  }
  if (guards.length) parts.push(`${hr('行为约束')}\n${guards.join('\n\n')}`);

  // 5. 选中 Skill（只加载本次相关的，做 Token 预算）
  const selected = selectSkillsByBudget(skills, opts.skillBudgetTokens ?? 5000);
  if (selected.length) {
    const skillText = selected
      .map((s) => {
        const custom = s.customInstructions ? `\n[补充说明]\n${s.customInstructions}` : '';
        const examples = s.examples?.length
          ? `\n[示例]\n${s.examples.map((e) => `输入：${e.input}\n输出：${e.output}`).join('\n---\n')}`
          : '';
        return `### Skill：${s.name}（${s.summary}）\n${s.instructions}${custom}${examples}`;
      })
      .join('\n\n');
    parts.push(`${hr('专业能力（Skill，须按此执行）')}\n${skillText}`);
  }

  // 兼容员工档案页维护的旧 Skill。该页面把 Skill 保存在
  // employee_profiles.skills，而不是独立的 skills / agent_skills 表中。
  // 两种来源都进入 prompt，避免档案页显示已保存但聊天时完全不生效。
  const legacySkills = (profile?.skills ?? []).filter((s) => s.name.trim());
  if (legacySkills.length) {
    const legacySkillText = legacySkills
      .map((s) => {
        const description = s.description?.trim();
        const instructions = s.desc.trim();
        return `### Skill：${s.name.trim()}${description ? `\n描述：${description}` : ''}${instructions && instructions !== description ? `\n详细说明：\n${instructions}` : ''}`;
      })
      .join('\n\n');
    parts.push(`${hr('员工档案能力（Skill，须按此执行）')}\n${legacySkillText}`);
  }

  // 6. 工具权限（Phase 3 预留）
  parts.push(`${hr('工具与权限')}\n当前只能读取平台提供的信息；不得访问员工真实个人数据之外的内容，不得擅自执行写操作。`);

  // 7. 记忆与任务上下文
  const memoryLines = memories
    .filter((m) => m.content)
    .map((m) => `[${m.kind}] ${m.content}`)
    .slice(0, 10);
  if (memoryLines.length) parts.push(`${hr('历史记忆')}\n${memoryLines.join('\n')}`);
  if (opts.taskContext) parts.push(`${hr('本次任务上下文')}\n${opts.taskContext}`);

  // 平台 Agent 调度角色
  if (opts.dispatcherContext) parts.push(`${hr('调度者职责')}\n${opts.dispatcherContext}`);

  if (opts.extra) parts.push(opts.extra);

  return parts.join('\n');
}

/** 按 priority 排序，并在总 Token 预算内挑选 Skill（长文截断而非全量塞入） */
function selectSkillsByBudget(
  skills: Array<AgentSkillLink & SkillRecord>,
  budgetTokens: number
): Array<AgentSkillLink & SkillRecord> {
  if (!skills.length) return [];
  const sorted = [...skills].sort((a, b) => a.priority - b.priority);
  const picked: Array<AgentSkillLink & SkillRecord> = [];
  let used = 0;
  for (const s of sorted) {
    const cost = estimateTokens(s.instructions) + 120;
    if (picked.length > 0 && used + cost > budgetTokens) break; // 至少保留一个
    picked.push(s);
    used += cost;
  }
  return picked;
}

/** 平台 Agent 的规划器 system prompt：要求返回结构化 Plan JSON */
export function buildPlannerSystemPrompt(opts: {
  companyAgentName: string;
  candidates: Array<{ agentId: string; name: string; role: string; department: string; skillNames: string[]; summary: string }>;
  maxDelegations: number;
}): string {
  const candidatesText = opts.candidates.length
    ? opts.candidates.map((c) => `- ${c.agentId}｜${c.name}（${c.role} / ${c.department}）｜Skill：${c.skillNames.join('、') || '无'}｜${c.summary.slice(0, 80)}`).join('\n')
    : '（暂无匹配员工）';
  return `你是平台总控 Agent“${opts.companyAgentName}”，负责理解用户意图并编排员工完成复杂任务。

[可选员工]
${candidatesText}

[任务决策规则]
1. 如果任务只需直接回答（简单咨询、通用问题）→ action="answer"，并给出 draftAnswer 要点。
2. 如果关键信息缺失且存在歧义 → action="ask"，给出 question，等待用户澄清（可以先用你自己的风格向用户确认关键点，也可以直接分派，不必每次都追问）。
3. 如果任务需要专业分工或复杂分析 → action="delegate"，从上面清单选择 0~${opts.maxDelegations} 位员工（必须使用 agentId），为每位分配 task（尽量具体、可独立完成），dependsOn 填写依赖的其他 agentId。

[委派时的额外要求]
- groupName：为本次协作拟一个简短群名（≤12 字，贴合用户主题，如“赚钱方案讨论”）。
- synthesize：是否需要你在所有员工回复后，再做一次总结发言。若员工各自回答已完整、可直接交付，则设 false（省成本）；需要整合冲突、给结论或交叉审查时才设 true。
- 不要输出 skillId：候选清单只提供 Skill 名称而非确切 id，编造 skillId 会导致该员工任务失败。

[输出要求]
必须只输出一个 JSON 对象，不要包含任何其他文字，格式如下：
{
  "action": "answer" | "ask" | "delegate",
  "reason": "判断理由，不超过 200 字",
  "draftAnswer": "answer 时的答复要点",
  "question": "ask 时的澄清问题",
  "groupName": "delegate 时的简短群名",
  "synthesize": true,
  "assignments": [
    { "agentId": "员工 agentId", "task": "给该员工的具体任务", "dependsOn": [] }
  ]
}`;
}
