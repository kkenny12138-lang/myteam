/**
 * tools / agent_tools 数据访问层（Phase 3）。
 * 工具定义、输入 Schema、权限（read/write）、绑定关系。
 */
import { ensureSchema, getPool, isDbConfigured } from '@/lib/db';
import type { ToolDefinition } from '@/lib/agent/types';

function parseJson<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v === 'object') return v as T;
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return fallback;
  }
}

function mapRow(r: Record<string, unknown>): ToolDefinition {
  return {
    id: String(r.id),
    name: String(r.name),
    description: String(r.description || ''),
    inputSchema: parseJson<Record<string, unknown> | undefined>(r.input_schema, undefined),
    permission: r.permission as 'read' | 'write',
    enabled: r.status === 'active',
  };
}

export async function listTools(status?: 'active' | 'disabled'): Promise<ToolDefinition[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const rows = status
    ? await getPool().query('SELECT * FROM tools WHERE status = ? ORDER BY name ASC', [status])
    : await getPool().query('SELECT * FROM tools ORDER BY name ASC');
  return (rows as Array<Record<string, unknown>>).map(mapRow);
}

export async function getToolById(id: string): Promise<ToolDefinition | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const rows = await getPool().query('SELECT * FROM tools WHERE id = ? LIMIT 1', [id]);
  const row = (rows as Array<Record<string, unknown>>)[0];
  return row ? mapRow(row) : null;
}

export async function createTool(tool: ToolDefinition): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO tools (id, name, description, input_schema, permission, status)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), input_schema = VALUES(input_schema), permission = VALUES(permission), status = VALUES(status)`,
    [tool.id, tool.name, tool.description, tool.inputSchema ? JSON.stringify(tool.inputSchema) : null, tool.permission, tool.enabled ? 'active' : 'disabled']
  );
}

/** 某 Agent 已启用（且全局 active）的工具 */
export async function listAgentTools(agentId: string): Promise<ToolDefinition[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const rows = await getPool().query(
    `SELECT t.* FROM agent_tools at JOIN tools t ON t.id = at.tool_id
     WHERE at.agent_id = ? AND at.enabled = 1 AND t.status = 'active' ORDER BY t.name ASC`,
    [agentId]
  );
  return (rows as Array<Record<string, unknown>>).map(mapRow);
}

export async function linkTool(agentId: string, toolId: string): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO agent_tools (agent_id, tool_id, enabled) VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE enabled = 1`,
    [agentId, toolId]
  );
}

export async function unlinkTool(agentId: string, toolId: string): Promise<void> {
  await ensureSchema();
  await getPool().query('DELETE FROM agent_tools WHERE agent_id = ? AND tool_id = ?', [agentId, toolId]);
}
