/**
 * GET/PUT/DELETE /api/t/[tenantSlug]/model-configs — 租户级模型配置（admin）。
 * 敏感密钥绝不下发：GET 只返回 apiKeyConfigured。
 */
import { deleteModelConfig, listModelConfigs, upsertModelConfig } from '@/lib/repositories/model-configs';
import { requireRole, requireTenantContext } from '@/lib/auth/context';
import type { ModelProvider } from '@/lib/agent/types';

export async function GET(request: Request) {
  try {
    const ctx = await requireTenantContext(request);
    requireRole(ctx, 'owner', 'admin');
    const configs = await listModelConfigs(ctx.tenantId);
    return Response.json({ configs });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '读取失败' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireTenantContext(request);
    requireRole(ctx, 'owner', 'admin');
    const body = await request.json() as {
      provider?: string; displayName?: string; modelName?: string; apiKey?: string;
      enabled?: boolean; imageInput?: boolean | null; config?: Record<string, unknown>;
    };
    const provider = body.provider;
    if (provider !== 'kimi' && provider !== 'deepseek' && provider !== 'openai') {
      return Response.json({ error: 'provider 必须是 kimi/deepseek/openai' }, { status: 400 });
    }
    await upsertModelConfig(ctx.tenantId, provider as ModelProvider, {
      displayName: body.displayName,
      modelName: body.modelName,
      apiKey: body.apiKey,
      enabled: body.enabled,
      imageInput: body.imageInput,
      config: body.config,
    });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '保存失败' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireTenantContext(request);
    requireRole(ctx, 'owner', 'admin');
    const provider = new URL(request.url).searchParams.get('provider');
    if (provider !== 'kimi' && provider !== 'deepseek' && provider !== 'openai') {
      return Response.json({ error: 'provider 必须是 kimi/deepseek/openai' }, { status: 400 });
    }
    const removed = await deleteModelConfig(ctx.tenantId, provider as ModelProvider);
    return Response.json({ ok: true, removed });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '删除失败' }, { status: 500 });
  }
}
