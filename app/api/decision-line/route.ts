import { ensureSchema, getPool, isDbConfigured } from '@/lib/db';

type DecisionNode = { employeeId: string; domain: string; keywords: string[] };
type DecisionLine = { dispatcherId: string; nodes: DecisionNode[] };

/** 默认决策线：马斯克解析问题并分派给各专业专家 */
const DEFAULT_DECISION_LINE: DecisionLine = {
  dispatcherId: 'elon',
  nodes: [
    { employeeId: 'jobs', domain: '产品设计 · 用户体验 · 品牌表达', keywords: ['产品', '设计', '体验', '品牌', '功能', '界面', '用户'] },
    { employeeId: 'buffett', domain: '财务分析 · 价值投资 · 风险控制', keywords: ['财务', '投资', '预算', '现金流', '成本', '利润', '资金', '收益'] },
    { employeeId: 'munger', domain: '战略推演 · 决策复盘 · 风险预判', keywords: ['战略', '风险', '决策', '复盘', '偏差', '逆向', '连锁'] },
    { employeeId: 'elon', domain: '战略决策 · 商业增长 · 工程管理', keywords: ['战略', '增长', '工程', '技术', '突破', '执行', '指标'] },
  ],
};

const sanitize = (value: unknown): DecisionLine | null => {
  if (!value) return null;
  let parsed: Partial<DecisionLine>;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) as Partial<DecisionLine> : value as Partial<DecisionLine>;
  } catch {
    return null;
  }
  if (typeof parsed?.dispatcherId !== 'string' || !Array.isArray(parsed?.nodes)) return null;
  const nodes = parsed.nodes
    .filter((n): n is DecisionNode => !!n && typeof n.employeeId === 'string' && typeof n.domain === 'string')
    .map((n) => ({ employeeId: n.employeeId, domain: n.domain, keywords: Array.isArray(n.keywords) ? n.keywords.filter((k): k is string => typeof k === 'string') : [] }));
  return { dispatcherId: parsed.dispatcherId, nodes };
};

/** GET /api/decision-line — 返回决策线配置（无记录时返回默认） */
export async function GET() {
  try {
    if (!isDbConfigured()) return Response.json({ decisionLine: null }, { status: 503 });
    await ensureSchema();
    const rows = await getPool().query('SELECT config FROM decision_line WHERE id = 1') as Array<{ config: string }>;
    const decisionLine = sanitize(rows[0]?.config) ?? DEFAULT_DECISION_LINE;
    return Response.json({ decisionLine });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '数据库访问失败' }, { status: 500 });
  }
}

/** PUT /api/decision-line — 保存决策线配置 */
export async function PUT(request: Request) {
  try {
    const body = await request.json() as { decisionLine?: DecisionLine };
    const decisionLine = sanitize(body.decisionLine);
    if (!decisionLine) return Response.json({ error: '参数不正确：decisionLine 格式有误' }, { status: 400 });
    if (!isDbConfigured()) return Response.json({ error: '数据库未配置' }, { status: 503 });
    await ensureSchema();
    await getPool().query(
      'INSERT INTO decision_line (id, config) VALUES (1, ?) ON DUPLICATE KEY UPDATE config = VALUES(config)',
      [JSON.stringify(decisionLine)]
    );
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '保存失败' }, { status: 500 });
  }
}
