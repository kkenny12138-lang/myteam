/**
 * agent_runs / agent_run_events 数据访问层。
 * 记录每次任务执行的轨迹、状态、Token 与耗时（docs §5）。
 */
import { ensureSchema, getPool, isDbConfigured } from '@/lib/db';
import type { AgentRun, AgentRunEvent, RunStatus } from '@/lib/agent/types';

function parseJson<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v === 'object') return v as T;
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return fallback;
  }
}

function mapRun(r: Record<string, unknown>): AgentRun {
  return {
    id: String(r.id),
    parentRunId: r.parent_run_id ? String(r.parent_run_id) : null,
    rootRunId: String(r.root_run_id),
    conversationId: String(r.conversation_id),
    agentId: String(r.agent_id),
    skillId: r.skill_id ? String(r.skill_id) : null,
    status: r.status as RunStatus,
    inputText: String(r.input_text || ''),
    outputText: r.output_text ? String(r.output_text) : null,
    errorText: r.error_text ? String(r.error_text) : null,
    modelName: r.model_name ? String(r.model_name) : null,
    promptTokens: Number(r.prompt_tokens || 0),
    completionTokens: Number(r.completion_tokens || 0),
    latencyMs: Number(r.latency_ms || 0),
    createdAt: r.created_at ? String(r.created_at) : undefined,
    finishedAt: r.finished_at ? String(r.finished_at) : null,
  };
}

export async function createRun(tenantId: string, run: Partial<AgentRun> & Pick<AgentRun, 'id' | 'rootRunId' | 'conversationId' | 'agentId' | 'inputText' | 'status'>): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO agent_runs (id, tenant_id, parent_run_id, root_run_id, conversation_id, agent_id, skill_id, status, input_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE id = id`,
    [
      run.id,
      tenantId,
      run.parentRunId ?? null,
      run.rootRunId,
      run.conversationId,
      run.agentId,
      run.skillId ?? null,
      run.status,
      run.inputText,
    ]
  );
}

export async function getRun(tenantId: string, id: string): Promise<AgentRun | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const rows = await getPool().query('SELECT * FROM agent_runs WHERE id = ? AND tenant_id = ? LIMIT 1', [id, tenantId]);
  const row = (rows as Array<Record<string, unknown>>)[0];
  return row ? mapRun(row) : null;
}

/** 结束一个 Run：更新状态、输出/错误、Token、耗时、完成时间。 */
export async function finishRun(
  tenantId: string,
  id: string,
  fields: Partial<Pick<AgentRun, 'status' | 'outputText' | 'errorText' | 'modelName' | 'promptTokens' | 'completionTokens' | 'latencyMs'>>
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (fields.status !== undefined) { sets.push('status = ?'); values.push(fields.status); }
  if (fields.outputText !== undefined) { sets.push('output_text = ?'); values.push(fields.outputText); }
  if (fields.errorText !== undefined) { sets.push('error_text = ?'); values.push(fields.errorText); }
  if (fields.modelName !== undefined) { sets.push('model_name = ?'); values.push(fields.modelName); }
  if (fields.promptTokens !== undefined) { sets.push('prompt_tokens = ?'); values.push(fields.promptTokens); }
  if (fields.completionTokens !== undefined) { sets.push('completion_tokens = ?'); values.push(fields.completionTokens); }
  if (fields.latencyMs !== undefined) { sets.push('latency_ms = ?'); values.push(fields.latencyMs); }
  if (fields.status === 'succeeded' || fields.status === 'failed' || fields.status === 'cancelled') {
    sets.push('finished_at = CURRENT_TIMESTAMP');
  }
  if (!sets.length) return;
  values.push(id, tenantId);
  await getPool().query(`UPDATE agent_runs SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`, values);
}

export async function listChildRuns(tenantId: string, parentRunId: string): Promise<AgentRun[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const rows = await getPool().query('SELECT * FROM agent_runs WHERE tenant_id = ? AND parent_run_id = ? ORDER BY created_at ASC', [tenantId, parentRunId]);
  return (rows as Array<Record<string, unknown>>).map(mapRun);
}

export async function listRunsByConversation(tenantId: string, conversationId: string, limit = 50): Promise<AgentRun[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const rows = await getPool().query(
    'SELECT * FROM agent_runs WHERE tenant_id = ? AND conversation_id = ? ORDER BY created_at DESC LIMIT ?',
    [tenantId, conversationId, limit]
  );
  return (rows as Array<Record<string, unknown>>).map(mapRun);
}

/* ---------- events ---------- */

export async function appendRunEvent(tenantId: string, runId: string, eventType: string, payload?: Record<string, unknown>): Promise<void> {
  await ensureSchema();
  await getPool().query(
    'INSERT INTO agent_run_events (tenant_id, run_id, event_type, payload_json) VALUES (?, ?, ?, ?)',
    [tenantId, runId, eventType, payload ? JSON.stringify(payload) : null]
  );
}

export async function listRunEvents(tenantId: string, runId: string, afterId?: number): Promise<AgentRunEvent[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const rows = afterId
    ? await getPool().query('SELECT * FROM agent_run_events WHERE tenant_id = ? AND run_id = ? AND id > ? ORDER BY id ASC', [tenantId, runId, afterId])
    : await getPool().query('SELECT * FROM agent_run_events WHERE tenant_id = ? AND run_id = ? ORDER BY id ASC', [tenantId, runId]);
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    runId: String(r.run_id),
    eventType: String(r.event_type),
    payload: parseJson<Record<string, unknown> | null>(r.payload_json, null),
    createdAt: r.created_at ? String(r.created_at) : undefined,
  }));
}
