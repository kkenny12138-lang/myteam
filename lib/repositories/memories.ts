/**
 * memories 数据访问层（Phase 3）：员工长期记忆 / 用户偏好 / 任务阶段上下文 / 对话摘要。
 */
import { ensureSchema, getPool, isDbConfigured } from '@/lib/db';
import type { MemoryRecord } from '@/lib/agent/types';

export interface AddMemoryInput {
  agentId: string;
  kind: MemoryRecord['kind'];
  content: string;
  metadata?: Record<string, unknown>;
}

export async function addMemory(tenantId: string, input: AddMemoryInput): Promise<string> {
  const id = `mem_${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 12) : Math.random().toString(36).slice(2, 14)}`;
  await ensureSchema();
  await getPool().query(
    'INSERT INTO memories (id, tenant_id, agent_id, kind, content, metadata_json) VALUES (?, ?, ?, ?, ?, ?)',
    [id, tenantId, input.agentId, input.kind, input.content, input.metadata ? JSON.stringify(input.metadata) : null]
  );
  return id;
}

export async function listMemories(tenantId: string, agentId: string, kind?: MemoryRecord['kind'], limit = 20): Promise<MemoryRecord[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const rows = kind
    ? await getPool().query(
        'SELECT id, agent_id, kind, content, metadata_json, created_at FROM memories WHERE tenant_id = ? AND agent_id = ? AND kind = ? ORDER BY created_at DESC LIMIT ?',
        [tenantId, agentId, kind, limit]
      )
    : await getPool().query(
        'SELECT id, agent_id, kind, content, metadata_json, created_at FROM memories WHERE tenant_id = ? AND agent_id = ? ORDER BY created_at DESC LIMIT ?',
        [tenantId, agentId, limit]
      );
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    agentId: String(r.agent_id),
    kind: r.kind as MemoryRecord['kind'],
    content: String(r.content),
    metadata: r.metadata_json ? JSON.parse(String(r.metadata_json)) : null,
    createdAt: r.created_at ? String(r.created_at) : undefined,
  }));
}

export async function deleteMemory(tenantId: string, id: string): Promise<void> {
  await ensureSchema();
  await getPool().query('DELETE FROM memories WHERE id = ? AND tenant_id = ?', [id, tenantId]);
}

export async function updateMemory(tenantId: string, id: string, input: Pick<AddMemoryInput, 'kind' | 'content'>): Promise<boolean> {
  await ensureSchema();
  const result = await getPool().query(
    'UPDATE memories SET kind = ?, content = ? WHERE id = ? AND tenant_id = ?',
    [input.kind, input.content, id, tenantId]
  ) as { affectedRows?: number };
  return Number(result.affectedRows) > 0;
}
