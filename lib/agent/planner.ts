/**
 * Planner：平台 Agent 的决策规划器（docs §5.2 / §5.3）。
 * 让 Company Agent 从候选员工中返回结构化 Plan（JSON），并做服务端校验：
 * - 未知 agentId / 不在候选集中的 ID 一律丢弃（防止模型编造）
 * - 单次最多 5 个子任务，递归深度由 runtime 控制
 */
import { buildPlannerSystemPrompt } from '@/lib/agent/prompt-builder';
import type { AgentRecord, CandidateAgent, ChatMessage, ModelProvider, Plan, Usage } from '@/lib/agent/types';
import { defaultModel, generateObject } from '@/lib/models/gateway';
import { validatePlan } from '@/lib/agent/validators';

export interface PlanResult {
  plan: Plan;
  raw: string;
  usage: Usage;
}

export async function planTask(input: {
  companyAgent: AgentRecord;
  candidates: CandidateAgent[];
  userMessage: string;
  history?: ChatMessage[];
  maxDelegations?: number;
  /** 全局模型优先：指定后覆盖 companyAgent 的 modelProvider/modelName */
  model?: ModelProvider;
}): Promise<PlanResult> {
  const maxDelegations = input.companyAgent.config.maxDelegations ?? 5;
  const system = buildPlannerSystemPrompt({
    companyAgentName: input.companyAgent.name,
    candidates: input.candidates,
    maxDelegations,
  });
  const history = (input.history ?? []).slice(-10);
  const provider = input.model ?? input.companyAgent.modelProvider;
  const modelName = input.model ? defaultModel(input.model) : (input.companyAgent.modelName || defaultModel(input.companyAgent.modelProvider));
  const { data, raw, usage } = await generateObject(
    {
      provider,
      model: modelName,
      system,
      messages: [...history, { role: 'user', content: input.userMessage }],
      temperature: 0.3,
      maxTokens: 2000,
    },
    validatePlan
  );
  // 安全校验：assignments 的 agentId 必须在候选集中
  const validIds = new Set(input.candidates.map((c) => c.agentId));
  const plan: Plan = {
    ...data,
    // Planner 无法获知真实 Skill id（候选只暴露名称），一律丢弃 skillId，避免模型编造导致子任务失败
    assignments: data.assignments
      .filter((a) => validIds.has(a.agentId))
      .map((a) => ({ ...a, skillId: undefined })),
  };
  if (plan.action === 'delegate' && plan.assignments.length === 0) {
    // 模型选了无效员工 → 安全降级为追问
    plan.action = 'ask';
    plan.question = plan.question || '我暂时没有找到足够匹配的员工来完成这项任务，请补充更多上下文或换一种表达。';
  }
  return { plan, raw, usage };
}
