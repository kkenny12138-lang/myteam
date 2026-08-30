/**
 * skills 表数据访问层。
 * Skill 是独立、可复用、可版本化的能力定义（docs §2.3 / §6）。
 */
import { ensureSchema, getPool, isDbConfigured } from '@/lib/db';
import type { AgentSkillLink, SkillExample, SkillRecord, SkillStatus } from '@/lib/agent/types';

function parseJson<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v === 'object') return v as T;
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return fallback;
  }
}

function mapRow(r: Record<string, unknown>): SkillRecord {
  return {
    id: String(r.id),
    name: String(r.name),
    summary: String(r.summary || ''),
    instructions: String(r.instructions || ''),
    inputSchema: parseJson<Record<string, unknown> | null>(r.input_schema, null),
    outputSchema: parseJson<Record<string, unknown> | null>(r.output_schema, null),
    examples: parseJson<SkillExample[] | null>(r.examples_json, null),
    status: r.status as SkillStatus,
    version: Number(r.version),
    createdAt: r.created_at ? String(r.created_at) : undefined,
    updatedAt: r.updated_at ? String(r.updated_at) : undefined,
  };
}

export const SKILL_INSTRUCTIONS_MAX = 200_000;

export async function listSkills(status?: SkillStatus): Promise<SkillRecord[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const rows = status
    ? await getPool().query('SELECT * FROM skills WHERE status = ? ORDER BY updated_at DESC', [status])
    : await getPool().query('SELECT * FROM skills ORDER BY updated_at DESC');
  return (rows as Array<Record<string, unknown>>).map(mapRow);
}

export async function getSkillById(id: string): Promise<SkillRecord | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const rows = await getPool().query('SELECT * FROM skills WHERE id = ? LIMIT 1', [id]);
  const row = (rows as Array<Record<string, unknown>>)[0];
  return row ? mapRow(row) : null;
}

export async function createSkill(skill: SkillRecord): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO skills (id, name, summary, instructions, input_schema, output_schema, examples_json, status, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      skill.id,
      skill.name,
      skill.summary || '',
      skill.instructions,
      skill.inputSchema ? JSON.stringify(skill.inputSchema) : null,
      skill.outputSchema ? JSON.stringify(skill.outputSchema) : null,
      skill.examples && skill.examples.length ? JSON.stringify(skill.examples) : null,
      skill.status || 'draft',
      skill.version || 1,
    ]
  );
}

/** 乐观锁更新：WHERE id=? AND version=?，成功后 version+1。 */
export async function updateSkill(
  id: string,
  patch: Partial<Pick<SkillRecord, 'name' | 'summary' | 'instructions' | 'inputSchema' | 'outputSchema' | 'examples' | 'status'>>,
  expectedVersion: number
): Promise<boolean> {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined) { fields.push('name = ?'); values.push(patch.name); }
  if (patch.summary !== undefined) { fields.push('summary = ?'); values.push(patch.summary); }
  if (patch.instructions !== undefined) { fields.push('instructions = ?'); values.push(patch.instructions); }
  if (patch.inputSchema !== undefined) { fields.push('input_schema = ?'); values.push(patch.inputSchema ? JSON.stringify(patch.inputSchema) : null); }
  if (patch.outputSchema !== undefined) { fields.push('output_schema = ?'); values.push(patch.outputSchema ? JSON.stringify(patch.outputSchema) : null); }
  if (patch.examples !== undefined) { fields.push('examples_json = ?'); values.push(patch.examples && patch.examples.length ? JSON.stringify(patch.examples) : null); }
  if (patch.status !== undefined) { fields.push('status = ?'); values.push(patch.status); }
  if (!fields.length) return true;
  fields.push('version = version + 1');
  values.push(id, expectedVersion);
  const result = await getPool().query(`UPDATE skills SET ${fields.join(', ')} WHERE id = ? AND version = ?`, values);
  return Number((result as { affectedRows?: number }).affectedRows) > 0;
}

export async function deleteSkill(id: string): Promise<void> {
  await ensureSchema();
  await getPool().query('DELETE FROM agent_skills WHERE skill_id = ?', [id]);
  await getPool().query('DELETE FROM skills WHERE id = ?', [id]);
}

/** 返回某 Agent 绑定的已启用 Skill（含 priority / custom_instructions） */
export async function listAgentSkills(agentId: string): Promise<Array<AgentSkillLink & SkillRecord>> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const rows = await getPool().query(
    `SELECT s.*, asl.priority AS link_priority, asl.custom_instructions AS link_custom, asl.enabled AS link_enabled
     FROM agent_skills asl JOIN skills s ON s.id = asl.skill_id
     WHERE asl.agent_id = ? AND asl.enabled = 1
     ORDER BY asl.priority ASC, s.updated_at DESC`,
    [agentId]
  );
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    ...mapRow(r),
    agentId,
    skillId: String(r.id),
    priority: Number(r.link_priority),
    customInstructions: r.link_custom ? String(r.link_custom) : null,
    enabled: Boolean(r.link_enabled),
  }));
}

/** 精确获取某 Agent 已绑定、启用且已发布的单个 Skill；不满足任一条件返回 null。 */
export async function getSkillForAgent(agentId: string, skillId: string): Promise<(AgentSkillLink & SkillRecord) | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const rows = await getPool().query(
    `SELECT s.*, asl.priority AS link_priority, asl.custom_instructions AS link_custom, asl.enabled AS link_enabled
     FROM agent_skills asl JOIN skills s ON s.id = asl.skill_id
     WHERE asl.agent_id = ? AND asl.skill_id = ? AND asl.enabled = 1 AND s.status = 'published'
     LIMIT 1`,
    [agentId, skillId]
  ) as Array<Record<string, unknown>>;
  const r = rows[0];
  if (!r) return null;
  return {
    ...mapRow(r),
    agentId,
    skillId: String(r.id),
    priority: Number(r.link_priority),
    customInstructions: r.link_custom ? String(r.link_custom) : null,
    enabled: Boolean(r.link_enabled),
  };
}

/** 绑定 / 解绑 Skill */
export async function linkSkill(agentId: string, skillId: string, priority = 100, customInstructions?: string): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO agent_skills (agent_id, skill_id, priority, custom_instructions, enabled)
     VALUES (?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE priority = VALUES(priority), custom_instructions = VALUES(custom_instructions), enabled = 1`,
    [agentId, skillId, priority, customInstructions ?? null]
  );
}

export async function unlinkSkill(agentId: string, skillId: string): Promise<void> {
  await ensureSchema();
  await getPool().query('DELETE FROM agent_skills WHERE agent_id = ? AND skill_id = ?', [agentId, skillId]);
}
