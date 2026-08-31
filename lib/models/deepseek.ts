/**
 * DeepSeek 模型 Adapter。
 * 只允许在这里出现 DeepSeek 专有字段（endpoint / model / response_format 等）。
 */
import type { GenerateResult, MessageContentPart, Usage } from '@/lib/agent/types';
import { FatalError, RetryableError } from '@/lib/models/gateway';

const ENDPOINT = 'https://api.deepseek.com/chat/completions';

type ProviderMessage = { role: 'system' | 'user' | 'assistant'; content: string | MessageContentPart[] };

interface GenerateParamsLike {
  model: string;
  system: string;
  messages: ProviderMessage[];
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  signal?: AbortSignal;
}

/** 把统一内容块转成 DeepSeek 的 OpenAI 兼容格式（图片 → image_url，文档 → 文本） */
function toProviderContent(content: string | MessageContentPart[]) {
  if (typeof content === 'string') return content;
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image') return { type: 'image_url', image_url: { url: part.url } };
    return { type: 'text', text: `【附件：${part.name}】\n${part.text}` };
  });
}

export async function generateDeepSeek(params: GenerateParamsLike): Promise<GenerateResult> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new FatalError('本地尚未配置 DEEPSEEK_API_KEY');
  const body: Record<string, unknown> = {
    model: params.model,
    messages: [{ role: 'system', content: params.system }, ...params.messages.map((m) => ({ role: m.role, content: toProviderContent(m.content) }))],
    stream: false,
    temperature: params.temperature ?? 0.6,
    max_tokens: params.maxTokens ?? 4000,
  };
  if (params.json) body.response_format = { type: 'json_object' };

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: params.signal,
    });
  } catch (error) {
    throw new RetryableError(`DeepSeek 网络请求失败: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    const message = data?.error?.message || `DeepSeek 请求失败 (${response.status})`;
    if (response.status === 429 || response.status >= 500) throw new RetryableError(message);
    throw new FatalError(message);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new FatalError('DeepSeek 没有返回文本内容');
  const usage: Usage = {
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
    totalTokens: data.usage?.total_tokens ?? 0,
  };
  return { text, usage, modelName: params.model };
}
