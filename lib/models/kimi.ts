/**
 * Kimi（月之暗面 Moonshot）模型 Adapter。
 * 只允许在这里出现 Kimi 专有字段（endpoint / thinking 等）。
 */
import type { GenerateResult, MessageContentPart, Usage } from '@/lib/agent/types';
import { FatalError, RetryableError } from '@/lib/models/gateway';

const ENDPOINT = 'https://api.moonshot.cn/v1/chat/completions';

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

/** 把统一内容块转成 Kimi 的 OpenAI 兼容格式（图片 → image_url，文档 → 文本） */
function toProviderContent(content: string | MessageContentPart[]) {
  if (typeof content === 'string') return content;
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image') return { type: 'image_url', image_url: { url: part.url } };
    return { type: 'text', text: `【附件：${part.name}】\n${part.text}` };
  });
}

export async function generateKimi(params: GenerateParamsLike): Promise<GenerateResult> {
  const apiKey = process.env.KIMI_API_KEY;
  if (!apiKey) throw new FatalError('本地尚未配置 KIMI_API_KEY');
  // kimi-k2 系列是推理模型，只允许 temperature=1；其它模型沿用调用方传入值
  const isReasoningModel = /^kimi-k2/i.test(params.model);
  const body: Record<string, unknown> = {
    model: params.model,
    messages: [{ role: 'system', content: params.system }, ...params.messages.map((m) => ({ role: m.role, content: toProviderContent(m.content) }))],
    stream: false,
    temperature: isReasoningModel ? 1 : (params.temperature ?? 0.6),
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
    throw new RetryableError(`Kimi 网络请求失败: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    const message = data?.error?.message || `Kimi 请求失败 (${response.status})`;
    if (response.status === 429 || response.status >= 500) throw new RetryableError(message);
    throw new FatalError(message);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  let text = data.choices?.[0]?.message?.content;
  // Kimi deep 模式可能只返回空内容，关闭 thinking 重试一次
  if (!text) {
    body.thinking = { type: 'disabled' };
    body.max_tokens = 2000;
    const retry = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: params.signal,
    });
    if (!retry.ok) throw new FatalError(`Kimi 请求失败 (${retry.status})`);
    const retryData = (await retry.json()) as typeof data;
    text = retryData.choices?.[0]?.message?.content;
  }
  if (!text) throw new FatalError('Kimi 没有返回文本内容');
  const usage: Usage = {
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
    totalTokens: data.usage?.total_tokens ?? 0,
  };
  return { text, usage, modelName: params.model };
}

const FILES_ENDPOINT = 'https://api.moonshot.cn/v1/files';

function sleepKimi(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 用 Kimi Files API 抽取文档文本（purpose=file-extract）。
 * 支持 pdf / doc / docx / xls / xlsx / ppt / pptx / txt / csv / md 等文本类格式。
 * 失败（无 key / 网络错误 / 不支持 / 并发限流）时返回 null，由调用方回退到本地解析。
 */
export async function extractKimiFile(
  bytes: Uint8Array,
  filename: string,
  mimeType: string
): Promise<string | null> {
  const apiKey = process.env.KIMI_API_KEY;
  if (!apiKey) return null;
  try {
    const form = new FormData();
    form.append('purpose', 'file-extract');
    form.append('file', new File([bytes as BlobPart], filename || 'attachment', { type: mimeType || 'application/octet-stream' }));
    const upload = await fetch(FILES_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!upload.ok) return null;
    const fileObj = (await upload.json().catch(() => null)) as { id?: string } | null;
    const fileId = fileObj?.id;
    if (!fileId) return null;
    // 拉取抽取内容（file-extract 通常即时就绪；未就绪则短暂重试）
    let raw = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const content = await fetch(`${FILES_ENDPOINT}/${fileId}/content`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (content.ok) {
        raw = await content.text();
        if (raw.trim()) break;
      }
      await sleepKimi(600 * (attempt + 1));
    }
    if (!raw.trim()) return null;
    // 响应可能是 JSON（{ "content": "..." }）或纯文本
    try {
      const parsed = JSON.parse(raw) as { content?: unknown };
      if (typeof parsed.content === 'string' && parsed.content.trim()) {
        return parsed.content.trim();
      }
    } catch {
      /* 非 JSON，按纯文本返回 */
    }
    return raw.trim();
  } catch {
    return null;
  }
}
