import { ensureSchema, getPool, isDbConfigured } from '@/lib/db';

type OrgNode = { id: string; name: string; description: string; parentId: string | null; department?: string };

export const DEFAULT_ORG_NODES: OrgNode[] = [
  { id: 'root', name: '公司总部', parentId: null, description: '统筹公司整体战略与经营目标，负责跨部门协调、资源分配与重大决策的最终拍板。', department: '' },
  { id: 'mgmt', name: '管理层', parentId: 'root', department: '管理层', description: '负责公司战略方向制定、关键项目决策与全局资源调度，向下拆解目标并分派给各部门。' },
  { id: 'product', name: '产品部', parentId: 'root', department: '产品部', description: '负责产品定位、用户体验与品牌表达，把用户需求转化为可落地的产品方案，并对功能做取舍评审。' },
  { id: 'finance', name: '财务部', parentId: 'root', department: '财务部', description: '负责预算、投资、现金流与风险控制，评估商业模式与长期回报，守住资金安全边界。' },
  { id: 'strategy', name: '战略部', parentId: 'root', department: '战略部', description: '负责战略推演、决策复盘与风险预判，用多元思维模型识别偏差、预演失败并纠偏。' },
];

/** GET /api/org-nodes — 返回组织架构节点；无记录时返回默认架构 */
export async function GET() {
  try {
    if (!isDbConfigured()) return Response.json({ orgNodes: null }, { status: 503 });
    await ensureSchema();
    const rows = await getPool().query(
      'SELECT id, name, description, parent_id, department, sort_order FROM org_nodes ORDER BY sort_order ASC, id ASC'
    ) as Array<Record<string, unknown>>;
    if (!rows.length) return Response.json({ orgNodes: DEFAULT_ORG_NODES });
    const nodes: OrgNode[] = rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      description: String(r.description || ''),
      parentId: r.parent_id ? String(r.parent_id) : null,
      department: r.department ? String(r.department) : undefined,
    }));
    return Response.json({ orgNodes: nodes });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '数据库访问失败' }, { status: 500 });
  }
}

/** PUT /api/org-nodes — 整体替换组织架构节点 */
export async function PUT(request: Request) {
  try {
    const body = await request.json() as { orgNodes?: OrgNode[] };
    const nodes = Array.isArray(body.orgNodes) ? body.orgNodes : null;
    if (!nodes) return Response.json({ error: '参数不正确：缺少 orgNodes' }, { status: 400 });
    if (!isDbConfigured()) return Response.json({ error: '数据库未配置' }, { status: 503 });
    const pool = getPool();
    await ensureSchema();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query('DELETE FROM org_nodes');
      if (nodes.length) {
        const values: Array<[string, string, string, string | null, string | null, number]> = [];
        nodes.forEach((n, i) => {
          if (!n?.id || !n?.name) return;
          values.push([n.id, n.name, n.description || '', n.parentId || null, n.department || null, i]);
        });
        if (values.length) {
          await connection.batch('INSERT INTO org_nodes (id, name, description, parent_id, department, sort_order) VALUES (?, ?, ?, ?, ?, ?)', values);
        }
      }
      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
    return Response.json({ ok: true, count: nodes.length });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '保存失败' }, { status: 500 });
  }
}
