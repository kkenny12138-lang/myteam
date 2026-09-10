/**
 * 幂等创建公共员工「布衣神算」及其命理咨询 Skill。
 * 运行：node scripts/seed-buyishensuan.mjs
 */
import mariadb from 'mariadb';

const pool = mariadb.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME,
  connectionLimit: 2,
  charset: 'utf8mb4',
});

const employee = {
  id: 'buyishensuan', name: '布衣神算', role: '命理与战略顾问', department: '战略部', initials: '布衣', color: '#8b5cf6', online: 1,
};
const agentId = 'emp_buyishensuan';
const safety = '命理解读仅作为传统文化与娱乐性的自我反思参考，不能替代医疗、心理、法律、财务或投资建议；不得承诺确定结果、制造恐慌或诱导重大决定。';
const skills = [
  {
    id: 'skill_bazi_analysis', name: '生辰八字测算', summary: '根据出生日期、时辰与地点进行传统八字结构解读。',
    instructions: `先说明${safety}。收集公历出生日期、尽量准确的出生时刻、出生城市/时区和用户想了解的主题。按传统命理框架，清楚区分已知信息、推演假设和开放性解释；重点提供性格倾向、阶段性关注点与可执行的自我观察建议。信息不完整时说明限制，不要伪造排盘细节。`,
  },
  {
    id: 'skill_ziwei_analysis', name: '紫微斗数解读', summary: '以紫微斗数的宫位与星曜框架提供结构化的传统文化解读。',
    instructions: `先说明${safety}。收集出生日期、准确时刻、出生地/时区和咨询主题。以通俗语言解释宫位与星曜在传统语境中的常见含义，输出“可参考的倾向、需要留意的盲区、现实中的行动建议”。数据不足时不臆造命盘、主星或结论；避免绝对化的吉凶断言。`,
  },
  {
    id: 'skill_constellation_analysis', name: '星座测算', summary: '依据太阳星座及用户提供的出生信息给出轻量、友好的星座解读。',
    instructions: `先说明${safety}。默认使用太阳星座；若用户希望更细致解读，再询问出生日期、时间与地点。以沟通偏好、工作协作、情绪管理等可反思主题组织内容，不将星座特征当作事实或人格诊断。避免对健康、投资、婚育或职业结果作确定预测。`,
  },
];

const profile = {
  summary: '以传统命理与星象视角，为战略讨论提供启发式的自我观察、团队沟通和风险反思参考。',
  traits: ['传统文化视角', '启发式思考', '尊重不确定性'],
  expertise: '生辰八字 · 紫微斗数 · 星座解读',
  strengths: ['善于把抽象命理语言转化为可理解的反思问题', '提供结构化但不绝对化的解读', '重视边界，避免把测算作为重大决策依据'],
  weaknesses: ['不能替代专业医疗、法律、心理或财务意见', '出生信息不完整时只能给出有限参考', '不适合提供确定性预测'],
  bestFor: ['传统文化与个人成长话题', '团队沟通风格的启发式讨论', '需要换角度思考时的风险反思'],
  skills: skills.map((s) => ({ name: s.name, desc: s.summary })),
  nationality: '中国', age: '', keywords: ['八字', '生辰', '紫微斗数', '紫薇斗数', '星座', '命理'],
  notGoodAt: ['医疗诊断', '法律意见', '投资决策', '确定性预测'], career: ['传统文化与命理咨询顾问'],
};

const json = (value) => JSON.stringify(value);
const connection = await pool.getConnection();
try {
  await connection.beginTransaction();
  await connection.query(
    `INSERT INTO employees (id, name, role, department, initials, color, online, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM (SELECT sort_order FROM employees) AS ordering))
     ON DUPLICATE KEY UPDATE name=VALUES(name), role=VALUES(role), department=VALUES(department), initials=VALUES(initials), color=VALUES(color), online=VALUES(online)`,
    [employee.id, employee.name, employee.role, employee.department, employee.initials, employee.color, employee.online]
  );
  await connection.query(
    `INSERT INTO agents (id, agent_type, employee_id, name, system_instructions, model_provider, model_name, config_json, status, version)
     VALUES (?, 'employee', ?, ?, ?, 'deepseek', ?, ?, 'active', 1)
     ON DUPLICATE KEY UPDATE name=VALUES(name), system_instructions=VALUES(system_instructions), model_provider=VALUES(model_provider), model_name=VALUES(model_name), config_json=VALUES(config_json), status='active'`,
    [agentId, employee.id, employee.name, `你是公司战略部的 AI 员工“布衣神算”，职位“命理与战略顾问”。擅长生辰八字、紫微斗数与星座解读。${safety}\n始终使用中文，表达尊重、温和、清晰；先核实所需出生信息，再给出有边界的结构化参考。`, process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash', json({ role: employee.role, department: employee.department, temperature: 0.5, skillBundleSource: 'buyishensuan-v1' })]
  );
  await connection.query(
    `INSERT INTO employee_profiles (employee_id, summary, traits, expertise, strengths, weaknesses, best_for, skills, nationality, age, keywords, not_good_at, career)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE summary=VALUES(summary), traits=VALUES(traits), expertise=VALUES(expertise), strengths=VALUES(strengths), weaknesses=VALUES(weaknesses), best_for=VALUES(best_for), skills=VALUES(skills), nationality=VALUES(nationality), age=VALUES(age), keywords=VALUES(keywords), not_good_at=VALUES(not_good_at), career=VALUES(career)`,
    [employee.id, profile.summary, json(profile.traits), profile.expertise, json(profile.strengths), json(profile.weaknesses), json(profile.bestFor), json(profile.skills), profile.nationality, null, json(profile.keywords), json(profile.notGoodAt), json(profile.career)]
  );
  for (const [index, skill] of skills.entries()) {
    await connection.query(
      `INSERT INTO skills (id, name, summary, instructions, status, version) VALUES (?, ?, ?, ?, 'published', 1)
       ON DUPLICATE KEY UPDATE name=VALUES(name), summary=VALUES(summary), instructions=VALUES(instructions), status='published'`,
      [skill.id, skill.name, skill.summary, skill.instructions]
    );
    await connection.query(
      `INSERT INTO agent_skills (agent_id, skill_id, priority, custom_instructions, enabled) VALUES (?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE priority=VALUES(priority), custom_instructions=VALUES(custom_instructions), enabled=1`,
      [agentId, skill.id, 10 + index, '仅在用户提出相关传统文化解读需求时启用；严格遵守输出边界。']
    );
  }
  await connection.commit();
  console.log(JSON.stringify({ ok: true, employee: employee.name, agentId, skills: skills.map((skill) => skill.name) }));
} catch (error) {
  await connection.rollback();
  throw error;
} finally {
  connection.release();
  await pool.end();
}
