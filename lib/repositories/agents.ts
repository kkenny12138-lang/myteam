/**
 * agents 表数据访问层。
 * 服务端唯一的 Agent 权威来源：前端只提交 agentId / employeeId，由这里按 ID 加载配置。
 */
import { ensureSchema, getPool, isDbConfigured } from '@/lib/db';
import type { AgentConfig, AgentRecord, AgentType, ModelProvider } from '@/lib/agent/types';

function parseJson<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v === 'object') return v as T;
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return fallback;
  }
}

function mapRow(r: Record<string, unknown>): AgentRecord {
  return {
    id: String(r.id),
    agentType: r.agent_type as AgentType,
    employeeId: r.employee_id ? String(r.employee_id) : null,
    name: String(r.name),
    systemInstructions: String(r.system_instructions || ''),
    modelProvider: r.model_provider as ModelProvider,
    modelName: String(r.model_name),
    config: parseJson<AgentConfig>(r.config_json, {}),
    status: r.status as AgentRecord['status'],
    version: Number(r.version),
    createdAt: r.created_at ? String(r.created_at) : undefined,
    updatedAt: r.updated_at ? String(r.updated_at) : undefined,
  };
}

export async function listAgents(status?: AgentRecord['status']): Promise<AgentRecord[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const rows = status
    ? await getPool().query('SELECT * FROM agents WHERE status = ? ORDER BY agent_type DESC, name ASC', [status])
    : await getPool().query('SELECT * FROM agents ORDER BY agent_type DESC, name ASC');
  return (rows as Array<Record<string, unknown>>).map(mapRow);
}

export async function getAgentById(id: string): Promise<AgentRecord | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const rows = await getPool().query('SELECT * FROM agents WHERE id = ? LIMIT 1', [id]);
  const row = (rows as Array<Record<string, unknown>>)[0];
  return row ? mapRow(row) : null;
}

export async function getAgentByEmployeeId(employeeId: string): Promise<AgentRecord | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const rows = await getPool().query('SELECT * FROM agents WHERE employee_id = ? LIMIT 1', [employeeId]);
  const row = (rows as Array<Record<string, unknown>>)[0];
  return row ? mapRow(row) : null;
}

/** 唯一的平台 Agent（company 类型）。若存在多个，取最早创建的一个。 */
export async function getCompanyAgent(): Promise<AgentRecord | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const rows = await getPool().query(
    "SELECT * FROM agents WHERE agent_type = 'company' ORDER BY created_at ASC LIMIT 1"
  );
  const row = (rows as Array<Record<string, unknown>>)[0];
  return row ? mapRow(row) : null;
}

export async function createAgent(agent: AgentRecord): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO agents (id, agent_type, employee_id, name, system_instructions, model_provider, model_name, config_json, status, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       name = VALUES(name),
       system_instructions = VALUES(system_instructions),
       model_provider = VALUES(model_provider),
       model_name = VALUES(model_name),
       config_json = VALUES(config_json),
       status = VALUES(status)`,
    [
      agent.id,
      agent.agentType,
      agent.employeeId,
      agent.name,
      agent.systemInstructions,
      agent.modelProvider,
      agent.modelName,
      agent.config ? JSON.stringify(agent.config) : null,
      agent.status,
      agent.version,
    ]
  );
}

/** 乐观锁更新：WHERE version = ?，更新成功后 version+1。返回是否成功。 */
export async function updateAgent(
  id: string,
  patch: Partial<Pick<AgentRecord, 'name' | 'systemInstructions' | 'modelProvider' | 'modelName' | 'config' | 'status'>>,
  expectedVersion: number
): Promise<boolean> {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined) { fields.push('name = ?'); values.push(patch.name); }
  if (patch.systemInstructions !== undefined) { fields.push('system_instructions = ?'); values.push(patch.systemInstructions); }
  if (patch.modelProvider !== undefined) { fields.push('model_provider = ?'); values.push(patch.modelProvider); }
  if (patch.modelName !== undefined) { fields.push('model_name = ?'); values.push(patch.modelName); }
  if (patch.config !== undefined) { fields.push('config_json = ?'); values.push(JSON.stringify(patch.config)); }
  if (patch.status !== undefined) { fields.push('status = ?'); values.push(patch.status); }
  if (!fields.length) return true;
  fields.push('version = version + 1');
  values.push(id, expectedVersion);
  const result = await getPool().query(`UPDATE agents SET ${fields.join(', ')} WHERE id = ? AND version = ?`, values);
  return Number((result as { affectedRows?: number }).affectedRows) > 0;
}

export async function deleteAgent(id: string): Promise<void> {
  await ensureSchema();
  await getPool().query('DELETE FROM agent_skills WHERE agent_id = ?', [id]);
  await getPool().query('DELETE FROM agents WHERE id = ?', [id]);
}
