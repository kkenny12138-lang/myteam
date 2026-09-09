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

const seedPromises = new Map<string, Promise<void>>();

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

/** 首次运行时把现有服务端环境变量导入指定租户；已有记录绝不覆盖。 */
export async function ensureModelConfigsSeeded(tenantId: string): Promise<void> {
  if (!isDbConfigured()) return;
  let pending = seedPromises.get(tenantId);
  if (!pending) {
    pending = (async () => {
      await ensureSchema();
      for (const [provider, defaults] of Object.entries(DEFAULTS) as Array<[ModelProvider, typeof DEFAULTS[ModelProvider]]>) {
        const apiKey = await encryptModelSecret(process.env[defaults.keyEnv] || '');
        const modelName = process.env[defaults.modelEnv] || defaults.modelName;
        await getPool().query(
          `INSERT IGNORE INTO model_configs
           (tenant_id, provider, display_name, model_name, api_key_encrypted, enabled, image_input, config_json)
           VALUES (?, ?, ?, ?, ?, 1, NULL, NULL)`,
          [tenantId, provider, defaults.displayName, modelName, apiKey]
        );
      }
    })().catch((error) => {
      seedPromises.delete(tenantId);
      throw error;
    });
    seedPromises.set(tenantId, pending);
  }
  return pending;
}

/**
 * 读取租户模型配置：优先 tenant_id + provider 的记录；
 * 无记录（或未指定租户）时回退到服务端环境变量，绝不读取其他租户的密钥。
 */
export async function getRuntimeModelConfig(tenantId: string | undefined, provider: ModelProvider): Promise<RuntimeModelConfig> {
  const defaults = DEFAULTS[provider];
  if (isDbConfigured() && tenantId) {
    try {
      await ensureSchema();
      const rows = await getPool().query('SELECT * FROM model_configs WHERE tenant_id = ? AND provider = ? LIMIT 1', [tenantId, provider]) as Array<Record<string, unknown>>;
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

/** 列出某租户全部模型配置（不含明文密钥，供 admin 管理接口使用） */
export async function listModelConfigs(tenantId: string): Promise<Array<RuntimeModelConfig & { apiKeyConfigured: boolean }>> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const rows = await getPool().query('SELECT * FROM model_configs WHERE tenant_id = ? ORDER BY provider ASC', [tenantId]) as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const provider = String(r.provider) as ModelProvider;
    const defaults = DEFAULTS[provider] ?? { displayName: provider, modelName: '' };
    return {
      provider,
      displayName: String(r.display_name || defaults.displayName),
      modelName: String(r.model_name || defaults.modelName),
      apiKey: '',
      enabled: Boolean(r.enabled),
      imageInput: r.image_input === null || r.image_input === undefined ? null : Boolean(r.image_input),
      config: parseConfig(r.config_json),
      source: 'database',
      apiKeyConfigured: Boolean(r.api_key_encrypted),
    };
  });
}

/** admin：写入/更新租户模型配置（apiKey 为空字符串表示沿用旧密钥） */
export async function upsertModelConfig(
  tenantId: string,
  provider: ModelProvider,
  input: { displayName?: string; modelName?: string; apiKey?: string; enabled?: boolean; imageInput?: boolean | null; config?: Record<string, unknown> }
): Promise<void> {
  await ensureSchema();
  const existing = await getPool().query('SELECT api_key_encrypted FROM model_configs WHERE tenant_id = ? AND provider = ? LIMIT 1', [tenantId, provider]) as Array<{ api_key_encrypted: string }>;
  const apiKeyEncrypted = input.apiKey
    ? await encryptModelSecret(input.apiKey)
    : (existing[0]?.api_key_encrypted ?? await encryptModelSecret(process.env[DEFAULTS[provider].keyEnv] || ''));
  await getPool().query(
    `INSERT INTO model_configs (tenant_id, provider, display_name, model_name, api_key_encrypted, enabled, image_input, config_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       display_name = VALUES(display_name),
       model_name = VALUES(model_name),
       api_key_encrypted = VALUES(api_key_encrypted),
       enabled = VALUES(enabled),
       image_input = VALUES(image_input),
       config_json = VALUES(config_json)`,
    [
      tenantId,
      provider,
      input.displayName ?? DEFAULTS[provider].displayName,
      input.modelName ?? DEFAULTS[provider].modelName,
      apiKeyEncrypted,
      input.enabled === false ? 0 : 1,
      input.imageInput === undefined ? null : (input.imageInput ? 1 : 0),
      input.config ? JSON.stringify(input.config) : null,
    ]
  );
}

export async function deleteModelConfig(tenantId: string, provider: ModelProvider): Promise<boolean> {
  await ensureSchema();
  const result = await getPool().query('DELETE FROM model_configs WHERE tenant_id = ? AND provider = ?', [tenantId, provider]);
  return Number((result as { affectedRows?: number }).affectedRows) > 0;
}
