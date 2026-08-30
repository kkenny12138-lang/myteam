/**
 * Agent Runtime：平台 Agent 状态机（docs §5.2）。
 *
 *   RECEIVE → LOAD_CONTEXT → PLAN
 *     ├─ ask       → WAITING
 *     ├─ answer    → SYNTHESIZE
 *     └─ delegate  → EXECUTE_CHILD_RUNS → SYNTHESIZE
 *   → SAVE_TRACE → COMPLETE / FAIL
 *
 * 同一 Agent 同一任务禁止重复调用；递归深度固定为 1（平台→员工），员工不再调员工。
 */
import { candidateSearch, loadAgentContext } from '@/lib/agent/context-builder';
import { executeSingle } from '@/lib/agent/executor';
import { planTask } from '@/lib/agent/planner';
import type { AgentRun, AgentRunEvent, ChatMessage, ModelProvider, Plan, RunStatus, Usage } from '@/lib/agent/types';
import { getAgentById } from '@/lib/repositories/agents';
import { appendRunEvent, finishRun, listChildRuns, createRun, listRunEvents, getRun } from '@/lib/repositories/runs';
import { ApiError, assertAgentRunnable, newRunId, sumUsage } from '@/lib/agent/validators';
import { defaultModel, generate } from '@/lib/models/gateway';
import { buildSystemPrompt } from '@/lib/agent/prompt-builder';

export interface RunInput {
  conversationId: string;
  agentId: string;
  message: string;
  mode?: 'fast' | 'deep';
  history?: ChatMessage[];
  /** 预览/测试模式：允许 draft Agent 执行 */
  preview?: boolean;
  /** 对外发言的人设；后台调度不会改变聊天对象的身份。 */
  personaAgentId?: string;
  /** 全局模型优先：指定后覆盖所有 Agent（含子任务/规划/汇总）的 modelProvider/modelName */
  model?: ModelProvider;
}

export interface RunOutcome {
  rootRun: AgentRun;
  status: RunStatus;
  answerText: string | null;
  plan: Plan | null;
  childRuns: AgentRun[];
  usage: Usage;
  events: AgentRunEvent[];
}

function emptyUsage(): Usage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/** 启动一次 Agent 任务（根任务）。 */
export async function startRun(input: RunInput): Promise<RunOutcome> {
  const agent = await getAgentById(input.agentId);
  if (!agent) throw new ApiError('agent_not_found', `Agent 不存在: ${input.agentId}`, 404);
  assertAgentRunnable(agent.status, input.preview);
  const persona = input.personaAgentId ? await loadAgentContext(input.personaAgentId) : null;
  const responseAgent = persona?.agent ?? agent;

  const rootRunId = newRunId();
  const conversationId = input.conversationId;
  const usage = emptyUsage();

  await createRun({
    id: rootRunId,
    parentRunId: null,
    rootRunId,
    conversationId,
    agentId: agent.id,
    skillId: null,
    inputText: input.message,
    status: 'queued',
  });
  await appendRunEvent(rootRunId, 'planning', { agentId: agent.id, agentType: agent.agentType });

  try {
    // ---- 单员工对话：直接执行（Phase 1） ----
    if (agent.agentType === 'employee') {
      const result = await executeSingle({
        runId: rootRunId,
        agentId: agent.id,
        conversationId,
        inputText: input.message,
        history: input.history,
        mode: input.mode,
        model: input.model,
      });
      const finalRun = await getRunOrThrow(rootRunId);
      return {
        rootRun: finalRun,
        status: finalRun.status,
        answerText: result.text,
        plan: null,
        childRuns: [],
        usage: result.usage,
        events: await listRunEvents(rootRunId),
      };
    }

    // ---- 平台 Agent：规划 → 委派 → 汇总 ----
    const candidates = await candidateSearch(input.message, 8);
    const planResult = await planTask({
      companyAgent: agent,
      candidates,
      userMessage: input.message,
      history: input.history,
      model: input.model,
    });
    const plan = planResult.plan;
    const rootUsage = addUsage(usage, planResult.usage);
    await appendRunEvent(rootRunId, 'planned', { action: plan.action, assignments: plan.assignments, reason: plan.reason });

    if (plan.action === 'ask') {
      await finishRun(rootRunId, { status: 'waiting', outputText: plan.question ?? null, latencyMs: 0 });
      await appendRunEvent(rootRunId, 'waiting', { question: plan.question ?? '' });
      return {
        rootRun: await getRunOrThrow(rootRunId),
        status: 'waiting',
        answerText: plan.question ?? null,
        plan,
        childRuns: [],
        usage: rootUsage,
        events: await listRunEvents(rootRunId),
      };
    }

    if (plan.action === 'answer') {
      // DIRECT_ANSWER → SYNTHESIZE：Company Agent 直接给出答复
      const system = buildSystemPrompt({
        agent: responseAgent,
        profile: persona?.profile ?? null,
        skills: persona?.skills ?? [],
        memories: persona?.memories ?? [],
        taskContext: plan.draftAnswer ? `请围绕以下要点组织最终答复：${plan.draftAnswer}` : undefined,
        dispatcherContext: persona ? `后台规划已经完成。直接以“${responseAgent.name}”本人身份回答；不要提及后台规划、平台总控、Agent、调度或编排。` : '直接回应用户的问题。',
      });
      const provider = input.model ?? responseAgent.modelProvider;
      const modelName = input.model ? defaultModel(input.model) : (responseAgent.modelName || defaultModel(responseAgent.modelProvider));
      const result = await generate({
        provider,
        model: modelName,
        system,
        messages: [...(input.history ?? []).slice(-10), { role: 'user', content: input.message }],
        temperature: responseAgent.config.temperature ?? 0.6,
        maxTokens: responseAgent.config.maxTokens ?? (input.mode === 'deep' ? 4000 : 1600),
      });
      const totalUsage = addUsage(rootUsage, result.usage);
      await finishRun(rootRunId, {
        status: 'succeeded',
        outputText: result.text,
        modelName,
        promptTokens: totalUsage.promptTokens,
        completionTokens: totalUsage.completionTokens,
        latencyMs: 0,
      });
      await appendRunEvent(rootRunId, 'completed', { action: 'answer' });
      return {
        rootRun: await getRunOrThrow(rootRunId),
        status: 'succeeded',
        answerText: result.text,
        plan,
        childRuns: [],
        usage: totalUsage,
        events: await listRunEvents(rootRunId),
      };
    }

    // ---- delegate：执行子任务（考虑 dependsOn，同级可并行） ----
    const childRuns: AgentRun[] = [];
    const maxDelegations = agent.config.maxDelegations ?? 5;
    const assignments = plan.assignments.slice(0, maxDelegations);

    type SubRunResult = { agentId: string; name: string; text: string; ok: boolean; error?: string; usage: Usage };

    // 每个 Promise 返回独立结果，不共享可变状态；最终再确定性汇总（docs 2.4）
    const runOne = async (a: { agentId: string; skillId?: string; task: string }): Promise<SubRunResult> => {
      await appendRunEvent(rootRunId, 'delegated', { agentId: a.agentId, task: a.task.slice(0, 200) });
      try {
        const res = await executeSingle({
          agentId: a.agentId,
          conversationId,
          inputText: a.task,
          skillId: a.skillId ?? null,
          parentRunId: rootRunId,
          rootRunId,
          taskContext: `根任务：${input.message.slice(0, 1000)}`,
          mode: input.mode,
          preview: input.preview,
          model: input.model,
        });
        await appendRunEvent(rootRunId, 'child_completed', { agentId: a.agentId });
        return { agentId: a.agentId, name: a.agentId, text: res.text, ok: true, usage: res.usage };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await appendRunEvent(rootRunId, 'child_failed', { agentId: a.agentId, error: message });
        return { agentId: a.agentId, name: a.agentId, text: '', ok: false, error: message, usage: emptyUsage() };
      }
    };

    // 简单依赖执行：dependsOn 为空或依赖已完成的先执行
    const remaining = [...assignments];
    const resultsByAgent = new Map<string, SubRunResult>();
    while (remaining.length) {
      const batch = remaining.filter((a) => a.dependsOn.every((d) => resultsByAgent.has(d)));
      if (!batch.length) {
        // 死锁保护：把剩下全部按无依赖处理
        batch.push(...remaining);
      }
      const results = await Promise.all(batch.map(runOne));
      for (const r of results) resultsByAgent.set(r.agentId, r);
      for (const a of batch) remaining.splice(remaining.indexOf(a), 1);
    }

    childRuns.push(...(await listChildRuns(rootRunId)));

    // 确定性汇总：按 assignments 顺序合并结果，usage 用纯函数 reduce 求和
    const subResults: SubRunResult[] = assignments.map((a) => resultsByAgent.get(a.agentId) ?? { agentId: a.agentId, name: a.agentId, text: '', ok: false, error: '未执行', usage: emptyUsage() });
    const execUsage = sumUsage(subResults.map((r) => r.usage));

    // ---- SYNTHESIZE：平台 Agent 汇总所有子结果 ----
    // 若 Planner 决定无需汇总（synthesize=false），跳过这次模型调用，省 Token（docs「马斯克可以总结也可以不总结」）。
    const parts = subResults
      .map((r, i) => `【${i + 1}. ${r.name}】\n${r.ok ? r.text : `（该员工执行失败：${r.error}）`}`)
      .join('\n\n');
    let finalText: string | null;
    let finalUsage = execUsage;
    const synProvider = input.model ?? responseAgent.modelProvider;
    const synModel = input.model ? defaultModel(input.model) : (responseAgent.modelName || defaultModel(responseAgent.modelProvider));
    if (plan.synthesize === false) {
      finalText = null;
    } else {
      const synSystem = buildSystemPrompt({
        agent: responseAgent,
        profile: persona?.profile ?? null,
        skills: persona?.skills ?? [],
        memories: persona?.memories ?? [],
        taskContext: `以下是已委派员工的执行结果，请汇总为一份完整、结构清晰的最终答复；若有部分失败，请如实说明并尽量基于已有结果给出结论。\n\n${parts.slice(0, 20_000)}`,
        dispatcherContext: persona ? `这些材料只供你在后台参考。最终必须以“${responseAgent.name}”本人身份自然作答，不得提及平台总控、Agent、调度、编排或后台角色。` : '汇总多个员工的结果，处理冲突，向用户输出最终答案。',
      });
      try {
        const syn = await generate({
          provider: synProvider,
          model: synModel,
          system: synSystem,
          messages: [{ role: 'user', content: input.message }],
          temperature: 0.5,
          maxTokens: responseAgent.config.maxTokens ?? (input.mode === 'deep' ? 6000 : 3000),
        });
        finalText = syn.text;
        finalUsage = addUsage(finalUsage, syn.usage);
      } catch {
        // 汇总失败：退化为拼接子结果
        finalText = `（汇总时模型调用失败，以下为各员工结果：）\n\n${parts}`;
      }
    }

    const totalUsage = addUsage(rootUsage, finalUsage);
    await finishRun(rootRunId, {
      status: 'succeeded',
      outputText: finalText,
      modelName: synModel,
      promptTokens: totalUsage.promptTokens,
      completionTokens: totalUsage.completionTokens,
      latencyMs: 0,
    });
    await appendRunEvent(rootRunId, 'completed', { action: 'delegate', childCount: childRuns.length, synthesized: plan.synthesize !== false });
    return {
      rootRun: await getRunOrThrow(rootRunId),
      status: 'succeeded',
      answerText: finalText,
      plan,
      childRuns,
      usage: totalUsage,
      events: await listRunEvents(rootRunId),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishRun(rootRunId, { status: 'failed', errorText: message, latencyMs: 0 });
    await appendRunEvent(rootRunId, 'failed', { error: message });
    throw error;
  }
}

async function getRunOrThrow(id: string): Promise<AgentRun> {
  const run = await getRun(id);
  if (!run) throw new ApiError('run_not_found', `运行记录不存在: ${id}`, 404);
  return run;
}
