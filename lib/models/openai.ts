/**
 * OpenAI Responses API Adapter。
 * API Key 仅从服务端 OPENAI_API_KEY 读取，绝不下发到浏览器。
 */
import type { GenerateResult, MessageContentPart, Usage } from '@/lib/agent/types';
import { FatalError, RetryableError } from '@/lib/models/gateway';
import { getRuntimeModelConfig } from '@/lib/repositories/model-configs';

const ENDPOINT = 'https://api.openai.com/v1/responses';

type ProviderMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | MessageContentPart[];
};

interface GenerateParamsLike {
  model: string;
  system: string;
  messages: ProviderMessage[];
  maxTokens?: number;
  json?: boolean;
  signal?: AbortSignal;
  tenantId?: string;
}

function toInputContent(content: string | MessageContentPart[]) {
  if (typeof content === 'string') return content;
  return content.map((part) => {
    if (part.type === 'image') return { type: 'input_image', image_url: part.url };
    if (part.type === 'document') return { type: 'input_text', text: `【附件：${part.name}】\n${part.text}` };
    return { type: 'input_text', text: part.text };
  });
}

export async function generateOpenAI(params: GenerateParamsLike): Promise<GenerateResult> {
  const runtimeConfig = await getRuntimeModelConfig(params.tenantId, 'openai');
  if (!runtimeConfig.enabled) throw new FatalError('GPT 已在模型配置表中停用');
  const apiKey = runtimeConfig.apiKey;
  if (!apiKey) throw new FatalError('本地尚未配置 OPENAI_API_KEY');
  const modelName = runtimeConfig.modelName || params.model;

  const body: Record<string, unknown> = {
    model: modelName,
    instructions: params.system,
    input: params.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({ role: message.role, content: toInputContent(message.content) })),
    max_output_tokens: params.maxTokens ?? 4000,
  };
  if (params.json) body.text = { format: { type: 'json_object' } };

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: params.signal,
    });
  } catch (error) {
    throw new RetryableError(`OpenAI 网络请求失败: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    const message = data?.error?.message || `OpenAI 请求失败 (${response.status})`;
    if (response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500) {
      throw new RetryableError(message);
    }
    throw new FatalError(message);
  }

  const data = (await response.json()) as {
    model?: string;
    output_text?: string;
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  };
  const text = data.output_text || data.output
    ?.flatMap((item) => item.content ?? [])
    .filter((item) => item.type === 'output_text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('');
  if (!text) throw new FatalError('OpenAI 没有返回文本内容');

  const usage: Usage = {
    promptTokens: data.usage?.input_tokens ?? 0,
    completionTokens: data.usage?.output_tokens ?? 0,
    totalTokens: data.usage?.total_tokens ?? ((data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0)),
  };
  return { text, usage, modelName: data.model || modelName };
}
