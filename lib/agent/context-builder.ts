/**
 * Context Builder：服务端按 agentId 加载权威配置。
 * 前端只提交 ID，身份 / 档案 / Skill / 记忆都在这里按权威数据源加载（docs §5.1 / §5.3）。
 */
import { ensureSchema, getPool, isDbConfigured } from '@/lib/db';
import { getAgentById } from '@/lib/repositories/agents';
import { getSkillForAgent } from '@/lib/repositories/skills';
import { listMemories } from '@/lib/repositories/memories';
import type { AgentRecord, AgentSkillLink, CandidateAgent, EmployeeProfile, MemoryRecord, SkillRecord } from '@/lib/agent/types';

export interface AgentContext {
  agent: AgentRecord;
  profile: EmployeeProfile | null;
  /** 已发布且已启用的 Skill */
  skills: Array<AgentSkillLink & SkillRecord>;
  memories: MemoryRecord[];
}

function parseList(v: unknown): string[] {
  if (!v) return [];
  try {
    const parsed = JSON.parse(String(v));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * 解析旧 employee_profiles.skills（兼容对象数组 / 字符串数组 / JSON 字符串 / 非法值）。
 * 注意：旧字段是 `{ name, desc }[]`，不能用 parseList（它会把对象 String() 成 `[object Object]`）。
 */
export function parseLegacySkills(v: unknown): Array<{ name: string; description: string; desc: string }> {
  if (!v) return [];
  let parsed: unknown = v;
  if (typeof v === 'string') {
    try {
      parsed = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const result: Array<{ name: string; description: string; desc: string }> = [];
  for (const item of parsed) {
    if (typeof item === 'string') {
      const name = item.trim();
      if (name) result.push({ name, description: '', desc: '' });
    } else if (typeof item === 'object' && item !== null) {
      const obj = item as Record<string, unknown>;
      const name = typeof obj.name === 'string' ? obj.name.trim() : '';
      const description = typeof obj.description === 'string' ? obj.description : '';
      const desc = typeof obj.desc === 'string' ? obj.desc : description;
      if (name) result.push({ name, description, desc });
    }
  }
  return result;
}

/** 从 employee_profiles 兼容读取员工档案（双读策略：新表优先，无数据时回退旧表） */
export async function getEmployeeProfile(employeeId: string): Promise<EmployeeProfile | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const rows = await getPool().query(
    'SELECT summary, traits, expertise, strengths, weaknesses, best_for, skills, nationality, age, keywords, not_good_at, career FROM employee_profiles WHERE employee_id = ? LIMIT 1',
    [employeeId]
  ) as Array<Record<string, unknown>>;
  const r = rows[0];
  if (!r) return null;
  return {
    summary: String(r.summary || ''),
    traits: parseList(r.traits),
    expertise: String(r.expertise || ''),
    strengths: parseList(r.strengths),
    weaknesses: parseList(r.weaknesses),
    bestFor: parseList(r.best_for),
    skills: parseLegacySkills(r.skills),
    nationality: r.nationality ? String(r.nationality) : '',
    age: r.age === null || r.age === undefined ? '' : Number(r.age),
    keywords: parseList(r.keywords),
    notGoodAt: parseList(r.not_good_at),
    career: parseList(r.career),
  };
}

export async function listMemoriesForAgent(agentId: string, limit = 20): Promise<MemoryRecord[]> {
  return listMemories(agentId, undefined, limit);
}

/** 加载一次运行所需的 Agent 上下文（可按 skillId 精确加载，未指定则不加载 Skill 全文） */
export async function loadAgentContext(agentId: string, opts?: { skillId?: string | null }): Promise<AgentContext | null> {
  const agent = await getAgentById(agentId);
  if (!agent) return null;
  const profile = agent.agentType === 'employee' && agent.employeeId ? await getEmployeeProfile(agent.employeeId) : null;
  // Sprint 1：指定 skillId 时只加载该员工已绑定、启用、published 的 Skill；未指定时不加载 Skill 全文，避免上下文失控
  let skills: Array<AgentSkillLink & SkillRecord> = [];
  if (opts?.skillId) {
    const skill = await getSkillForAgent(agentId, opts.skillId);
    if (skill) skills = [skill];
  }
  const memories = await listMemoriesForAgent(agentId);
  return { agent, profile, skills, memories };
}

/* ---------- 候选召回（docs §5.3：硬规则 → 候选 → 模型选择） ---------- */

export async function candidateSearch(query: string, limit = 8): Promise<CandidateAgent[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const q = query.trim();
  const rows = await getPool().query(
    `SELECT a.id AS agent_id, a.name AS agent_name, a.config_json,
            e.role, e.department,
            p.keywords AS keywords_json, p.summary, p.expertise,
            (SELECT GROUP_CONCAT(s.name SEPARATOR ',') FROM agent_skills asl JOIN skills s ON s.id = asl.skill_id
              WHERE asl.agent_id = a.id AND asl.enabled = 1 AND s.status = 'published') AS skill_names
     FROM agents a
     LEFT JOIN employees e ON e.id = a.employee_id
     LEFT JOIN employee_profiles p ON p.employee_id = a.employee_id
     WHERE a.agent_type = 'employee' AND a.status = 'active'`
  ) as Array<Record<string, unknown>>;

  const scored = rows
    .map((r) => {
      const name = r.agent_name ? String(r.agent_name) : '';
      const role = r.role ? String(r.role) : '';
      const department = r.department ? String(r.department) : '';
      const keywords = parseList(r.keywords_json);
      const skillNames = r.skill_names ? String(r.skill_names).split(',').map((s) => s.trim()).filter(Boolean) : [];
      const summary = String(r.summary || '');
      const expertise = r.expertise ? String(r.expertise) : '';
      let score = 0;
      const hit = (term: string) => {
        if (term && term.length >= 2 && q.includes(term)) score += 2;
        else if (term && q.includes(term)) score += 1;
      };
      hit(name); hit(role); hit(department); hit(expertise);
      keywords.forEach(hit);
      skillNames.forEach(hit);
      // 摘要中的长词命中（粗粒度）
      if (summary) {
        for (const seg of summary.split(/[，。、；：,.;:！？!?\s]/)) {
          if (seg.length >= 2 && q.includes(seg)) score += 1;
        }
      }
      return {
        agentId: String(r.agent_id),
        name,
        role,
        department,
        keywords,
        skillNames,
        summary,
        score,
      };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  let picked: CandidateAgent[] = scored.slice(0, limit).map((c) => ({
    agentId: c.agentId,
    name: c.name,
    role: c.role,
    department: c.department,
    keywords: c.keywords,
    skillNames: c.skillNames,
    summary: c.summary,
  }));
  // 兜底：关键词无命中时，返回全部 active 员工供 Planner 自行判断（最多 limit）
  if (!picked.length) {
    picked = rows
      .map((r) => ({
        agentId: String(r.agent_id),
        name: r.agent_name ? String(r.agent_name) : '',
        role: r.role ? String(r.role) : '',
        department: r.department ? String(r.department) : '',
        keywords: parseList(r.keywords_json),
        skillNames: r.skill_names ? String(r.skill_names).split(',').map((s) => s.trim()).filter(Boolean) : [],
        summary: String(r.summary || ''),
      }))
      .slice(0, limit);
  }
  return picked;
}
