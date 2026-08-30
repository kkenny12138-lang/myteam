/**
 * Executor：执行单个 Agent 的一次调用（docs §5.5 执行保护）。
 * - 加载权威上下文、组装 prompt、调用 Model Gateway
 * - 记录 usage / latency / events
 * - 超时、Token 上限、失败重试（仅可重试错误，最多 1 次）
 */
import { loadAgentContext } from '@/lib/agent/context-builder';
import { buildSystemPrompt } from '@/lib/agent/prompt-builder';
import type { AgentRun, ChatMessage, ModelProvider, Usage } from '@/lib/agent/types';
import { defaultModel, FatalError, generate, isRetryableError } from '@/lib/models/gateway';
import { appendRunEvent, createRun, finishRun } from '@/lib/repositories/runs';
import { ApiError, assertAgentRunnable, newRunId, requireAvailableSkill } from '@/lib/agent/validators';

export interface ExecuteInput {
  runId?: string;
  agentId: string;
  conversationId: string;
  inputText: string;
  history?: ChatMessage[];
  taskContext?: string;
  mode?: 'fast' | 'deep';
  parentRunId?: string | null;
  rootRunId?: string;
  skillId?: string | null;
  /** 预览/测试模式：允许 draft Agent 执行 */
  preview?: boolean;
  /** 全局模型优先：指定后覆盖该 Agent 的 modelProvider/modelName */
  model?: ModelProvider;
}

export interface ExecuteResult {
  runId: string;
  agentId: string;
  text: string;
  usage: Usage;
  modelName: string;
  latencyMs: number;
}

/** 执行单个 Agent 的文本生成，创建/更新 run 记录并写轨迹事件。 */
export async function executeSingle(input: ExecuteInput): Promise<ExecuteResult> {
  const runId = input.runId ?? newRunId();
  const start = Date.now();
  const rootRunId = input.rootRunId ?? runId;

  await ensureRunRecord(runId, {
    parentRunId: input.parentRunId ?? null,
    rootRunId,
    conversationId: input.conversationId,
    agentId: input.agentId,
    skillId: input.skillId ?? null,
    inputText: input.inputText,
  });

  await appendRunEvent(runId, 'running', { agentId: input.agentId });
  try {
    const ctx = await loadAgentContext(input.agentId, { skillId: input.skillId });
    if (!ctx) throw new ApiError('agent_not_found', `Agent 不存在: ${input.agentId}`, 404);
    assertAgentRunnable(ctx.agent.status, input.preview);
    if (input.skillId) {
      requireAvailableSkill(ctx.skills[0], input.skillId);
      await appendRunEvent(runId, 'skill_selected', { skillId: input.skillId, name: ctx.skills[0]?.name });
    }

    const system = buildSystemPrompt({
      agent: ctx.agent,
      profile: ctx.profile,
      skills: ctx.skills,
      memories: ctx.memories,
      taskContext: input.taskContext,
    });

    const maxTokens = ctx.agent.config.maxTokens ?? (input.mode === 'deep' ? 6000 : 1600);
    const timeoutMs = ctx.agent.config.timeoutMs ?? 120_000;
    const provider = input.model ?? ctx.agent.modelProvider;
    const modelName = input.model ? defaultModel(input.model) : (ctx.agent.modelName || defaultModel(ctx.agent.modelProvider));

    const history = (input.history ?? []).slice(-20).map((m) => ({ role: m.role, content: m.content }));

    // 失败只重试可重试错误，最多 1 次
    let result: Awaited<ReturnType<typeof generate>> | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        result = await generate(
          {
            provider,
            model: modelName,
            system,
            messages: [...history, { role: 'user', content: input.inputText }],
            temperature: ctx.agent.config.temperature ?? 0.6,
            maxTokens,
          },
          { signal: AbortSignal.timeout(timeoutMs) }
        );
        break;
      } catch (error) {
        if (attempt === 0 && isRetryableError(error)) {
          await appendRunEvent(runId, 'retry', { reason: error instanceof Error ? error.message : String(error) });
          continue;
        }
        throw error;
      }
    }
    if (!result) throw new FatalError('模型调用未返回结果');

    const latencyMs = Date.now() - start;
    await appendRunEvent(runId, 'token', {
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      totalTokens: result.usage.totalTokens,
    });
    await finishRun(runId, {
      status: 'succeeded',
      outputText: result.text,
      modelName: modelName,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      latencyMs,
    });
    await appendRunEvent(runId, 'completed', { latencyMs });
    return { runId, agentId: input.agentId, text: result.text, usage: result.usage, modelName, latencyMs };
  } catch (error) {
    const latencyMs = Date.now() - start;
    const message = error instanceof Error ? error.message : String(error);
    await finishRun(runId, { status: 'failed', errorText: message, latencyMs });
    await appendRunEvent(runId, 'failed', { error: message });
    throw error;
  }
}

async function ensureRunRecord(
  runId: string,
  data: Pick<AgentRun, 'parentRunId' | 'rootRunId' | 'conversationId' | 'agentId' | 'skillId' | 'inputText'>
): Promise<void> {
  await createRun({
    id: runId,
    parentRunId: data.parentRunId,
    rootRunId: data.rootRunId,
    conversationId: data.conversationId,
    agentId: data.agentId,
    skillId: data.skillId,
    inputText: data.inputText,
    status: 'queued',
  });
}
