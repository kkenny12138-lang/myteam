/**
 * 模型供应商配置仓储。
 * 数据库中的启用配置优先；无记录或数据库不可用时回退到服务端环境变量。
 * 注意：本表含敏感 API Key，不得通过普通客户端 API 返回。
 */
import { ensureSchema, getPool, isDbConfigured } from '@/lib/db';
import type { ModelProvider } from '@/lib/agent/types';
import { decryptModelSecret, encryptModelSecret } from '@/lib/security/model-secrets';

export interface RuntimeModelConfig {
  provider: ModelProvider;
  displayName: string;
  modelName: string;
  apiKey: string;
  enabled: boolean;
  imageInput: boolean | null;
  config: Record<string, unknown>;
  source: 'database' | 'environment';
}

const DEFAULTS: Record<ModelProvider, { displayName: string; modelName: string; keyEnv: string; modelEnv: string }> = {
  kimi: { displayName: 'Kimi', modelName: 'kimi-k2.6', keyEnv: 'KIMI_API_KEY', modelEnv: 'KIMI_MODEL' },
  deepseek: { displayName: 'DS V4', modelName: 'deepseek-v4-flash', keyEnv: 'DEEPSEEK_API_KEY', modelEnv: 'DEEPSEEK_MODEL' },
  openai: { displayName: 'GPT', modelName: 'gpt-5.4', keyEnv: 'OPENAI_API_KEY', modelEnv: 'OPENAI_MODEL' },
};

let seedPromise: Promise<void> | null = null;

function parseConfig(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** 首次运行时把现有服务端环境变量导入表；已有记录绝不覆盖。 */
export async function ensureModelConfigsSeeded(): Promise<void> {
  if (!isDbConfigured()) return;
  if (!seedPromise) {
    seedPromise = (async () => {
      await ensureSchema();
      for (const [provider, defaults] of Object.entries(DEFAULTS) as Array<[ModelProvider, typeof DEFAULTS[ModelProvider]]>) {
        const apiKey = await encryptModelSecret(process.env[defaults.keyEnv] || '');
        const modelName = process.env[defaults.modelEnv] || defaults.modelName;
        await getPool().query(
          `INSERT IGNORE INTO model_configs
           (provider, display_name, model_name, api_key_encrypted, enabled, image_input, config_json)
           VALUES (?, ?, ?, ?, 1, NULL, NULL)`,
          [provider, defaults.displayName, modelName, apiKey]
        );
      }
    })().catch((error) => {
      seedPromise = null;
      throw error;
    });
  }
  return seedPromise;
}

export async function getRuntimeModelConfig(provider: ModelProvider): Promise<RuntimeModelConfig> {
  const defaults = DEFAULTS[provider];
  if (isDbConfigured()) {
    try {
      await ensureModelConfigsSeeded();
      const rows = await getPool().query('SELECT * FROM model_configs WHERE provider = ? LIMIT 1', [provider]) as Array<Record<string, unknown>>;
      const row = rows[0];
      if (row) {
        return {
          provider,
          displayName: String(row.display_name || defaults.displayName),
          modelName: String(row.model_name || defaults.modelName),
          apiKey: await decryptModelSecret(String(row.api_key_encrypted || '')),
          enabled: Boolean(row.enabled),
          imageInput: row.image_input === null || row.image_input === undefined ? null : Boolean(row.image_input),
          config: parseConfig(row.config_json),
          source: 'database',
        };
      }
    } catch {
      // 数据库暂时不可用时保留环境变量兜底，避免模型调用完全中断。
    }
  }
  return {
    provider,
    displayName: defaults.displayName,
    modelName: process.env[defaults.modelEnv] || defaults.modelName,
    apiKey: process.env[defaults.keyEnv] || '',
    enabled: true,
    imageInput: null,
    config: {},
    source: 'environment',
  };
}
