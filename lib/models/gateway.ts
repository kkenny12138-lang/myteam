/**
 * Model Gateway：统一模型调用入口。
 * 业务层只依赖本模块的 generate / generateObject，
 * 供应商差异（DeepSeek / Kimi）全部封装在 lib/models/* 各自的 adapter 中。
 *
 * 文档依据：docs/AGENT_PLATFORM_TECHNICAL_DESIGN.md §5 / §7
 */
import type { ChatMessage, GenerateResult, ModelProvider, Usage } from '@/lib/agent/types';
import { generateDeepSeek } from '@/lib/models/deepseek';
import { generateKimi } from '@/lib/models/kimi';

export interface GenerateParams {
  provider: ModelProvider;
  model: string;
  system: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** 期望 JSON 输出（generateObject 内部使用） */
  json?: boolean;
}

/** 可重试的错误标记（超时、限流、5xx） */
export class RetryableError extends Error {
  readonly retryable = true;
}

/** 不可重试的错误标记（4xx、鉴权失败、内容为空等） */
export class FatalError extends Error {
  readonly retryable = false;
}

export interface ModelRequestOptions {
  signal?: AbortSignal;
}

const PROVIDER_MODEL_DEFAULT: Record<ModelProvider, string> = {
  deepseek: 'deepseek-v4-flash',
  kimi: 'kimi-k2.6',
};

/** 根据 provider 返回默认模型名（可被 agent.model_name 覆盖） */
export function defaultModel(provider: ModelProvider): string {
  return process.env[provider === 'deepseek' ? 'DEEPSEEK_MODEL' : 'KIMI_MODEL'] || PROVIDER_MODEL_DEFAULT[provider];
}

/** 模型能力配置（docs/MULTIMODAL_ATTACHMENT_DEVELOPMENT_PLAN.md §8） */
export interface ModelCapabilities {
  imageInput: boolean;
  nativeDocumentInput: boolean;
  maxImages: number;
  maxFileBytes: number;
}

/**
 * 读取所选模型的视觉能力。保守默认：未知模型一律不支持图片输入。
 * 可用环境变量显式开启：DEEPSEEK_IMAGE_INPUT / KIMI_IMAGE_INPUT = true|1
 */
export function modelCapabilities(provider: ModelProvider, _model: string): ModelCapabilities {
  const envImage = provider === 'deepseek' ? process.env.DEEPSEEK_IMAGE_INPUT : process.env.KIMI_IMAGE_INPUT;
  const imageInput = /^(1|true|yes)$/i.test(envImage || '');
  return {
    imageInput,
    nativeDocumentInput: false,
    maxImages: 4,
    maxFileBytes: Number(process.env.ATTACHMENT_MAX_FILE_MB || 20) * 1024 * 1024,
  };
}

/** 统一调用：普通文本生成 */
export async function generate(params: GenerateParams, options?: ModelRequestOptions): Promise<GenerateResult> {
  const opts = { ...params, ...options };
  switch (params.provider) {
    case 'deepseek':
      return generateDeepSeek(opts);
    case 'kimi':
      return generateKimi(opts);
    default:
      throw new FatalError(`不支持的模型提供商: ${String(params.provider)}`);
  }
}

/**
 * 统一调用：要求模型返回 JSON，并做解析与校验。
 * 内部使用 response_format=json_object + 最多 2 次重试，
 * 若最终仍不是合法 JSON 则抛出 FatalError（安全失败）。
 */
export async function generateObject<T>(
  params: GenerateParams,
  validate: (raw: unknown) => T | null,
  options?: ModelRequestOptions
): Promise<{ data: T; raw: string; usage: Usage }> {
  const jsonParams: GenerateParams = { ...params, json: true };
  let lastRaw = '';
  let lastUsage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await generate(jsonParams, options);
    lastRaw = result.text;
    lastUsage = result.usage;
    const parsed = parseJsonObject(lastRaw);
    if (parsed !== null) {
      const data = validate(parsed);
      if (data !== null && data !== undefined) return { data, raw: lastRaw, usage: lastUsage };
    }
    if (attempt < 2) {
      // 轻微退避后重试
      await sleep(300 * (attempt + 1));
    }
  }
  throw new FatalError(`模型返回的不是合法 JSON 或未通过校验: ${lastRaw.slice(0, 200)}`);
}

/** 从模型文本中尽可能提取 JSON 对象（容忍被 ```json 包裹或夹杂说明文字） */
export function parseJsonObject(text: string): unknown {
  if (!text) return null;
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    /* fallthrough */
  }
  // 尝试从第一个 { 到最后一个 } 截取
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

/** 错误分类：由 gateway 统一抛出的错误，标注是否可重试 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof RetryableError) return true;
  if (error instanceof FatalError) return false;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
