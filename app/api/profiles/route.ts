import { ensureSchema, getPool, isDbConfigured } from '@/lib/db';

type Skill = { name: string; description?: string; desc: string };
type EmployeeProfile = { summary: string; traits: string[]; expertise: string; strengths: string[]; weaknesses: string[]; bestFor: string[]; skills: Skill[]; nationality?: string; age?: number | ''; keywords?: string[]; notGoodAt?: string[]; career?: string[] };

const profileValues = (employeeId: string, p: EmployeeProfile) => [
  employeeId, p.summary, JSON.stringify(p.traits || []), p.expertise || '',
  JSON.stringify(p.strengths || []), JSON.stringify(p.weaknesses || []),
  JSON.stringify(p.bestFor || []), JSON.stringify(p.skills || []),
  p.nationality || '', p.age === '' || p.age === undefined || p.age === null ? null : Number(p.age),
  JSON.stringify(p.keywords || []), JSON.stringify(p.notGoodAt || []), JSON.stringify(p.career || []),
];

const parseList = (v: unknown): string[] => {
  if (!v) return [];
  try {
    const parsed = JSON.parse(String(v));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};
const parseSkills = (v: unknown): Skill[] => {
  if (!v) return [];
  try {
    const parsed = JSON.parse(String(v));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

/** GET /api/profiles — 返回全部员工的特色档案（按员工 id 分组） */
export async function GET() {
  try {
    if (!isDbConfigured()) return Response.json({ profiles: null }, { status: 503 });
    await ensureSchema();
    const rows = await getPool().query(
      'SELECT employee_id, summary, traits, expertise, strengths, weaknesses, best_for, skills, nationality, age, keywords, not_good_at, career FROM employee_profiles'
    ) as Array<Record<string, unknown>>;
    const profiles: Record<string, EmployeeProfile> = {};
    for (const r of rows) {
      profiles[String(r.employee_id)] = {
        summary: String(r.summary || ''),
        traits: parseList(r.traits),
        expertise: String(r.expertise || ''),
        strengths: parseList(r.strengths),
        weaknesses: parseList(r.weaknesses),
        bestFor: parseList(r.best_for),
        skills: parseSkills(r.skills),
        nationality: r.nationality ? String(r.nationality) : '',
        age: r.age === null || r.age === undefined ? '' : Number(r.age),
        keywords: parseList(r.keywords),
        notGoodAt: parseList(r.not_good_at),
        career: parseList(r.career),
      };
    }
    return Response.json({ profiles });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '数据库访问失败' }, { status: 500 });
  }
}

/** PUT /api/profiles — 批量新增或更新员工特色档案 */
export async function PUT(request: Request) {
  try {
    const body = await request.json() as { profiles?: Record<string, EmployeeProfile> };
    const profiles = body.profiles && typeof body.profiles === 'object' ? body.profiles : null;
    if (!profiles) return Response.json({ error: '参数不正确：缺少 profiles' }, { status: 400 });
    if (!isDbConfigured()) return Response.json({ error: '数据库未配置' }, { status: 503 });
    const pool = getPool();
    await ensureSchema();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const [employeeId, p] of Object.entries(profiles)) {
        if (!p?.summary) continue;
        await connection.query(
          `INSERT INTO employee_profiles
           (employee_id, summary, traits, expertise, strengths, weaknesses, best_for, skills, nationality, age, keywords, not_good_at, career)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
           summary=VALUES(summary), traits=VALUES(traits), expertise=VALUES(expertise),
           strengths=VALUES(strengths), weaknesses=VALUES(weaknesses), best_for=VALUES(best_for),
           skills=VALUES(skills), nationality=VALUES(nationality), age=VALUES(age),
           keywords=VALUES(keywords), not_good_at=VALUES(not_good_at), career=VALUES(career)`,
          profileValues(employeeId, p)
        );
      }
      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
    return Response.json({ ok: true, count: Object.keys(profiles).length });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '保存失败' }, { status: 500 });
  }
}

/** PATCH /api/profiles — 只新增或更新一个员工档案，避免覆盖其他员工。 */
export async function PATCH(request: Request) {
  try {
    const body = await request.json() as { employeeId?: string; profile?: EmployeeProfile };
    const employeeId = typeof body.employeeId === 'string' ? body.employeeId.trim() : '';
    const profile = body.profile;
    if (!employeeId || !profile || typeof profile !== 'object' || typeof profile.summary !== 'string') {
      return Response.json({ error: '参数不正确：缺少 employeeId 或 profile' }, { status: 400 });
    }
    if (!isDbConfigured()) return Response.json({ error: '数据库未配置' }, { status: 503 });
    await ensureSchema();
    await getPool().query(
      `INSERT INTO employee_profiles
       (employee_id, summary, traits, expertise, strengths, weaknesses, best_for, skills, nationality, age, keywords, not_good_at, career)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
       summary=VALUES(summary), traits=VALUES(traits), expertise=VALUES(expertise),
       strengths=VALUES(strengths), weaknesses=VALUES(weaknesses), best_for=VALUES(best_for),
       skills=VALUES(skills), nationality=VALUES(nationality), age=VALUES(age),
       keywords=VALUES(keywords), not_good_at=VALUES(not_good_at), career=VALUES(career)`,
      profileValues(employeeId, profile)
    );
    return Response.json({ ok: true, employeeId });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '保存失败' }, { status: 500 });
  }
}
