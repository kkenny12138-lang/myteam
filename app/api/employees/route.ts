import { ensureSchema, getPool, isDbConfigured } from '@/lib/db';

type Employee = { id: string; name: string; role: string; department: string; initials: string; color: string; online: boolean };

/** GET /api/employees — 返回全部员工（按排序） */
export async function GET() {
  try {
    if (!isDbConfigured()) return Response.json({ employees: null }, { status: 503 });
    await ensureSchema();
    const rows = await getPool().query(
      'SELECT id, name, role, department, initials, color, online FROM employees ORDER BY sort_order ASC, id ASC'
    ) as Array<Record<string, unknown>>;
    const employees = rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      role: String(r.role),
      department: String(r.department),
      initials: String(r.initials),
      color: String(r.color),
      online: Boolean(r.online),
    }));
    return Response.json({ employees });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '数据库访问失败' }, { status: 500 });
  }
}

/** PUT /api/employees — 整体替换员工列表 */
export async function PUT(request: Request) {
  try {
    const body = await request.json() as { employees?: Employee[] };
    const employees = Array.isArray(body.employees) ? body.employees : null;
    if (!employees) return Response.json({ error: '参数不正确：缺少 employees' }, { status: 400 });
    if (!isDbConfigured()) return Response.json({ error: '数据库未配置' }, { status: 503 });
    const pool = getPool();
    await ensureSchema();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query('DELETE FROM employees');
      for (let i = 0; i < employees.length; i++) {
        const e = employees[i];
        if (!e?.id || !e?.name) throw new Error('员工数据不完整');
        await connection.query(
          'INSERT INTO employees (id, name, role, department, initials, color, online, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [e.id, e.name, e.role || '', e.department || '', e.initials || '', e.color || '#3478f6', e.online ? 1 : 0, i]
        );
      }
      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
    return Response.json({ ok: true, count: employees.length });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '保存失败' }, { status: 500 });
  }
}

/** POST /api/employees — 新增一名员工。 */
export async function POST(request: Request) {
  try {
    const body = await request.json() as { employee?: Employee };
    const employee = body.employee;
    if (!employee?.id?.trim() || !employee.name?.trim() || !employee.department?.trim()) {
      return Response.json({ error: '员工姓名和所属部门不能为空' }, { status: 400 });
    }
    if (!isDbConfigured()) return Response.json({ error: '数据库未配置' }, { status: 503 });
    await ensureSchema();
    const duplicate = await getPool().query('SELECT id FROM employees WHERE id = ? OR name = ? LIMIT 1', [employee.id, employee.name.trim()]) as Array<Record<string, unknown>>;
    if (duplicate.length) return Response.json({ error: '员工已存在' }, { status: 409 });
    await getPool().query(
      `INSERT INTO employees (id, name, role, department, initials, color, online, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM (SELECT sort_order FROM employees) AS employee_order))`,
      [employee.id.trim(), employee.name.trim(), employee.role?.trim() || '招聘专员', employee.department.trim(), employee.initials?.trim() || employee.name.trim().slice(0, 2), employee.color || '#3478f6', employee.online ? 1 : 0]
    );
    return Response.json({ employee }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '新增员工失败' }, { status: 500 });
  }
}

/** PATCH /api/employees — 调整员工所属部门。 */
export async function PATCH(request: Request) {
  try {
    const body = await request.json() as { employeeId?: string; department?: string };
    const employeeId = body.employeeId?.trim() || '';
    const department = body.department?.trim() || '';
    if (!employeeId || !department) return Response.json({ error: '员工和部门不能为空' }, { status: 400 });
    if (!isDbConfigured()) return Response.json({ error: '数据库未配置' }, { status: 503 });
    await ensureSchema();
    const result = await getPool().query('UPDATE employees SET department = ? WHERE id = ?', [department, employeeId]);
    if (!result.affectedRows) return Response.json({ error: '员工不存在' }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '调整部门失败' }, { status: 500 });
  }
}
