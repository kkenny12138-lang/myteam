/**
 * 幂等迁移：旧档案 → Agent 平台（docs §4.3）。
 *
 * 1. 为每位现有员工创建 employee 类型 Agent（只创建不覆盖已有配置）
 * 2. 创建唯一的 company 类型平台 Agent
 * 3. 把旧 employee_profiles.skills[] 每项迁移成独立 Skill 并建立 agent_skills 关联
 * 4. 通过 schema_migrations 记录执行状态，可重复运行（幂等）
 *
 * 双读策略：新表优先，无新数据时读取旧 JSON（context-builder 已实现）。
 */
import { ensureSchema, getPool, isDbConfigured } from '@/lib/db';
import type { PoolConnection } from 'mariadb';
import { newSkillId } from '@/lib/agent/validators';
import { buildEmployeeAgent } from '@/lib/agent/employee-agent';

const MIGRATION_NAME = 'agent_bootstrap_v1';

const COMPANY_AGENT_ID = 'agent_company';
const COMPANY_SYSTEM_INSTRUCTIONS = `你是平台总控 Agent（Company Agent），是用户的统一入口与总控编排器。

职责：
- 理解用户意图与交付物；
- 判断直接回答、追问，还是委派员工；
- 根据员工能力和 Skill 进行路由；
- 将大任务拆成子任务并选择串行或并行执行；
- 汇总多个员工的结果，处理冲突，向用户输出最终答案。

你本身不是某位员工，员工 Agent 是你可以调用的下级 Agent。`;

export interface MigrateResult {
  skipped: boolean;
  agentsCreated: number;
  agentsExisted: number;
  skillsCreated: number;
  skillsLinked: number;
  companyCreated: boolean;
}

type LegacySkill = { name: string; desc: string };

export async function migrateToAgentPlatform(): Promise<MigrateResult> {
  const result: MigrateResult = {
    skipped: false,
    agentsCreated: 0,
    agentsExisted: 0,
    skillsCreated: 0,
    skillsLinked: 0,
    companyCreated: false,
  };
  if (!isDbConfigured()) return { ...result, skipped: true };
  await ensureSchema();

  const connection = await getPool().getConnection();
  try {
    // 旧 Skill 迁移只执行一次；员工 Agent 的补建每次都执行，确保后来新增的员工可被调度。
    const done = await connection.query('SELECT id FROM schema_migrations WHERE name = ? LIMIT 1', [MIGRATION_NAME]);
    const legacyMigrationDone = (done as Array<{ id: number }>).length > 0;

    await connection.beginTransaction();

    // ---- 2. 唯一的 company Agent ----
    const companyRows = await connection.query("SELECT id FROM agents WHERE agent_type = 'company' LIMIT 1");
    if (!(companyRows as Array<{ id: string }>).length) {
      await connection.query(
        `INSERT INTO agents (id, agent_type, employee_id, name, system_instructions, model_provider, model_name, config_json, status, version)
         VALUES (?, 'company', NULL, '平台总控', ?, 'deepseek', 'deepseek-v4-flash', ?, 'active', 1)`,
        [COMPANY_AGENT_ID, COMPANY_SYSTEM_INSTRUCTIONS, JSON.stringify({ maxDelegations: 5, temperature: 0.5 })]
      );
      result.companyCreated = true;
    }

    // ---- 1. 每位员工一个 employee Agent ----
    const employees = (await connection.query('SELECT id, name, role, department FROM employees')) as Array<{
      id: string; name: string; role: string; department: string;
    }>; 

    // ---- 3. 旧 Skill 迁移（先读取全部旧档案） ----
    const profiles = (await connection.query('SELECT employee_id, skills FROM employee_profiles')) as Array<{
      employee_id: string; skills: string | null;
    }>;

    for (const emp of employees) {
      const existingRows = await connection.query('SELECT id FROM agents WHERE employee_id = ? LIMIT 1', [emp.id]) as Array<{ id: string }>;
      let agentId: string;
      if (!existingRows.length) {
        const agent = buildEmployeeAgent(emp);
        agentId = agent.id;
        await connection.query(
          `INSERT INTO agents (id, agent_type, employee_id, name, system_instructions, model_provider, model_name, config_json, status, version)
           VALUES (?, 'employee', ?, ?, ?, ?, ?, ?, 'active', 1)`,
          [
            agent.id,
            agent.employeeId,
            agent.name,
            agent.systemInstructions,
            agent.modelProvider,
            agent.modelName,
            JSON.stringify(agent.config),
          ]
        );
        result.agentsCreated++;
      } else {
        agentId = existingRows[0].id;
        result.agentsExisted++;
      }

      // 迁移该员工的旧 skills[] → 独立 Skill + 关联
      if (legacyMigrationDone) continue;
      const profileRow = profiles.find((p) => p.employee_id === emp.id);
      let legacySkills: LegacySkill[] = [];
      if (profileRow?.skills) {
        try {
          const parsed = JSON.parse(profileRow.skills);
          if (Array.isArray(parsed)) legacySkills = parsed.map((s) => {
            if (typeof s === 'string') return { name: s, desc: '' };
            if (typeof s === 'object' && s !== null) return { name: String((s as { name?: unknown }).name || ''), desc: String((s as { desc?: unknown }).desc || '') };
            return { name: String(s), desc: '' };
          }).filter((s) => s.name);
        } catch {
          legacySkills = [];
        }
      }
      for (const ls of legacySkills) {
        const skillId = await ensureSkill(connection, ls.name, ls.desc, result);
        await connection.query(
          `INSERT INTO agent_skills (agent_id, skill_id, priority, custom_instructions, enabled)
           VALUES (?, ?, 100, NULL, 1)
           ON DUPLICATE KEY UPDATE enabled = 1`,
          [agentId, skillId]
        );
        result.skillsLinked++;
      }
    }

    if (!legacyMigrationDone) {
      await connection.query('INSERT INTO schema_migrations (name) VALUES (?)', [MIGRATION_NAME]);
    } else {
      result.skipped = result.agentsCreated === 0;
    }
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/** 按 name 查找已有 Skill，无则创建（同名复用，保证幂等） */
async function ensureSkill(
  connection: PoolConnection,
  name: string,
  desc: string,
  result: MigrateResult
): Promise<string> {
  const rows = await connection.query('SELECT id FROM skills WHERE name = ? LIMIT 1', [name]);
  if ((rows as Array<{ id: string }>).length) return String((rows as Array<{ id: string }>)[0].id);
  const id = newSkillId();
  await connection.query(
    `INSERT INTO skills (id, name, summary, instructions, input_schema, output_schema, examples_json, status, version)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, 'published', 1)`,
    [id, name, name, desc || `（该 Skill 由旧档案迁移，暂无详细说明）`]
  );
  result.skillsCreated++;
  return id;
}
