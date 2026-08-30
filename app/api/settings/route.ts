import { ensureSchema, getPool, isDbConfigured } from '@/lib/db';

const KEY_MODEL = 'chatModel';
const KEY_MODE = 'answerMode';
const KEY_STARTS = 'contextStarts';
const KEY_EMP_MODELS = 'employeeModels';

type SettingsBody = {
  chatModel?: 'kimi' | 'deepseek';
  answerMode?: 'fast' | 'deep';
  contextStarts?: Record<string, number>;
  employeeModels?: Record<string, 'kimi' | 'deepseek'>;
};

/** GET /api/settings — 返回全局设置（对话模型 / 回答模式 / 上下文起始点） */
export async function GET() {
  try {
    if (!isDbConfigured()) return Response.json({ settings: null }, { status: 503 });
    await ensureSchema();
    const rows = await getPool().query('SELECT k, v FROM settings') as Array<{ k: string; v: string }>;
    const map = Object.fromEntries(rows.map((r) => [r.k, r.v]));
    let contextStarts: Record<string, number> | null = null;
    if (map[KEY_STARTS]) {
      try {
        const parsed = JSON.parse(map[KEY_STARTS]);
        if (parsed && typeof parsed === 'object') contextStarts = parsed;
      } catch {
        contextStarts = null;
      }
    }
    let employeeModels: Record<string, 'kimi' | 'deepseek'> | null = null;
    if (map[KEY_EMP_MODELS]) {
      try {
        const parsed = JSON.parse(map[KEY_EMP_MODELS]);
        if (parsed && typeof parsed === 'object') {
          employeeModels = {};
          for (const [k, v] of Object.entries(parsed)) {
            if (v === 'kimi' || v === 'deepseek') employeeModels[k] = v;
          }
        }
      } catch {
        employeeModels = null;
      }
    }
    return Response.json({
      settings: {
        chatModel: map[KEY_MODEL] === 'kimi' || map[KEY_MODEL] === 'deepseek' ? map[KEY_MODEL] : null,
        answerMode: map[KEY_MODE] === 'fast' || map[KEY_MODE] === 'deep' ? map[KEY_MODE] : null,
        contextStarts,
        employeeModels,
      },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '数据库访问失败' }, { status: 500 });
  }
}

/** PUT /api/settings — 部分更新设置（只更新传入的字段） */
export async function PUT(request: Request) {
  try {
    const body = await request.json() as SettingsBody;
    if (body.chatModel === undefined && body.answerMode === undefined && body.contextStarts === undefined && body.employeeModels === undefined) {
      return Response.json({ error: '参数不正确：没有可更新的字段' }, { status: 400 });
    }
    if (!isDbConfigured()) return Response.json({ error: '数据库未配置' }, { status: 503 });
    const pool = getPool();
    await ensureSchema();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const upsert = async (key: string, value: string) => {
        await connection.query('INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [key, value]);
      };
      if (body.chatModel !== undefined) await upsert(KEY_MODEL, body.chatModel);
      if (body.answerMode !== undefined) await upsert(KEY_MODE, body.answerMode);
      if (body.contextStarts !== undefined) await upsert(KEY_STARTS, JSON.stringify(body.contextStarts));
      if (body.employeeModels !== undefined) await upsert(KEY_EMP_MODELS, JSON.stringify(body.employeeModels));
      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '保存失败' }, { status: 500 });
  }
}
