/**
 * GET/PUT /api/t/[tenantSlug]/settings — 租户级设置（admin 可写，其余可读）。
 */
import { getSettings, upsertSetting } from '@/lib/repositories/settings';
import { requireRole, requireTenantContext } from '@/lib/auth/context';

const KEY_MODEL = 'chatModel';
const KEY_MODE = 'answerMode';
const KEY_STARTS = 'contextStarts';
const KEY_EMP_MODELS = 'employeeModels';

type SettingsBody = {
  chatModel?: 'kimi' | 'deepseek' | 'openai';
  answerMode?: 'fast' | 'deep';
  contextStarts?: Record<string, number>;
  employeeModels?: Record<string, 'kimi' | 'deepseek' | 'openai'>;
};

export async function GET(request: Request) {
  try {
    const ctx = await requireTenantContext(request);
    const map = await getSettings(ctx.tenantId);
    let contextStarts: Record<string, number> | null = null;
    if (map[KEY_STARTS]) {
      try {
        const parsed = JSON.parse(map[KEY_STARTS]);
        if (parsed && typeof parsed === 'object') contextStarts = parsed;
      } catch {
        contextStarts = null;
      }
    }
    let employeeModels: Record<string, 'kimi' | 'deepseek' | 'openai'> | null = null;
    if (map[KEY_EMP_MODELS]) {
      try {
        const parsed = JSON.parse(map[KEY_EMP_MODELS]);
        if (parsed && typeof parsed === 'object') {
          employeeModels = {};
          for (const [k, v] of Object.entries(parsed)) {
            if (v === 'kimi' || v === 'deepseek' || v === 'openai') employeeModels[k] = v;
          }
        }
      } catch {
        employeeModels = null;
      }
    }
    return Response.json({
      settings: {
        chatModel: map[KEY_MODEL] === 'kimi' || map[KEY_MODEL] === 'deepseek' || map[KEY_MODEL] === 'openai' ? map[KEY_MODEL] : null,
        answerMode: map[KEY_MODE] === 'fast' || map[KEY_MODE] === 'deep' ? map[KEY_MODE] : null,
        contextStarts,
        employeeModels,
      },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '数据库访问失败' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireTenantContext(request);
    requireRole(ctx, 'owner', 'admin');
    const body = await request.json() as SettingsBody;
    if (body.chatModel === undefined && body.answerMode === undefined && body.contextStarts === undefined && body.employeeModels === undefined) {
      return Response.json({ error: '参数不正确：没有可更新的字段' }, { status: 400 });
    }
    if (body.chatModel !== undefined) await upsertSetting(ctx.tenantId, KEY_MODEL, body.chatModel);
    if (body.answerMode !== undefined) await upsertSetting(ctx.tenantId, KEY_MODE, body.answerMode);
    if (body.contextStarts !== undefined) await upsertSetting(ctx.tenantId, KEY_STARTS, JSON.stringify(body.contextStarts));
    if (body.employeeModels !== undefined) await upsertSetting(ctx.tenantId, KEY_EMP_MODELS, JSON.stringify(body.employeeModels));
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '保存失败' }, { status: 500 });
  }
}
