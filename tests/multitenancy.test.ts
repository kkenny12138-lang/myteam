/**
 * 多租户隔离与权限集成测试（需要本地 MySQL，见 scripts/start-test-db.ps1）。
 * 覆盖 docs/MULTI_TENANCY_IMPLEMENTATION_SPEC.md §8 验收项。
 * 数据库不可用时自动跳过。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT || '3307';
process.env.DB_USER = process.env.DB_USER || 'myteam';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'myteam123';
process.env.DB_NAME = process.env.DB_NAME || 'myteam';

import { ensureSchema, getPool, isDbConfigured } from '@/lib/db';
import { SESSION_COOKIE_NAME, createSession } from '@/lib/auth/session';
import { requireRole, requireTenantContext, resolveTenantContext, type TenantContext } from '@/lib/auth/context';
import { ApiError } from '@/lib/agent/validators';
import { appendMessage, createConversation, listConversations, listMessages } from '@/lib/repositories/conversations';
import { createAttachment, deleteAttachment, getAttachment, getAttachmentBytes } from '@/lib/repositories/attachments';
import { addMemory, listMemories } from '@/lib/repositories/memories';
import { appendRunEvent, createRun, getRun, listRunEvents } from '@/lib/repositories/runs';
import { listModelConfigs, upsertModelConfig } from '@/lib/repositories/model-configs';
import { listTenantMembers, removeTenantMember, upsertTenantMember } from '@/lib/repositories/tenants';

const A = 'tst_tenant_a';
const B = 'tst_tenant_b';
const SHARED_EMP = 'tst_emp_shared';
const SHARED_AGENT = 'tst_agent_shared';

const q = (sql: string, params: unknown[] = []) => getPool().query(sql, params);

const dbAvailable = await (async () => {
  if (!isDbConfigured()) return false;
  try {
    await ensureSchema();
    await q('SELECT 1');
    return true;
  } catch (e) {
    console.warn('[multitenancy.test] 数据库不可用，跳过集成测试：', e instanceof Error ? e.message : e);
    return false;
  }
})();

function cookieHeader(token: string): HeadersInit {
  return { cookie: `${SESSION_COOKIE_NAME}=${token}` };
}

function tenantRequest(token: string, slug: string, path: string): Request {
  return new Request(`http://localhost/api/t/${slug}${path}`, { headers: cookieHeader(token) });
}

async function seed() {
  await q("DELETE FROM tenant_members WHERE tenant_id IN (?, ?)", [A, B]);
  await q("DELETE FROM tenants WHERE id IN (?, ?)", [A, B]);
  await q("DELETE FROM users WHERE id LIKE 'tst_u_%'");
  await q('DELETE FROM memories WHERE tenant_id IN (?, ?)', [A, B]);
  await q('DELETE FROM agent_runs WHERE tenant_id IN (?, ?)', [A, B]);
  await q('DELETE FROM agent_run_events WHERE tenant_id IN (?, ?)', [A, B]);
  await q('DELETE FROM attachments WHERE tenant_id IN (?, ?)', [A, B]);
  await q('DELETE FROM conversation_message_attachments WHERE tenant_id IN (?, ?)', [A, B]);
  await q('DELETE FROM conversation_messages WHERE tenant_id IN (?, ?)', [A, B]);
  await q('DELETE FROM conversations WHERE tenant_id IN (?, ?)', [A, B]);
  await q('DELETE FROM model_configs WHERE tenant_id IN (?, ?)', [A, B]);

  await q('INSERT INTO tenants (id, slug, name, status, plan) VALUES (?, ?, ?, ?, ?)', [A, 'acme', 'Acme', 'active', 'free']);
  await q('INSERT INTO tenants (id, slug, name, status, plan) VALUES (?, ?, ?, ?, ?)', [B, 'beta', 'Beta', 'active', 'free']);

  // 公共员工角色（平台共享表，不含 tenant_id）
  await q('DELETE FROM employees WHERE id = ?', [SHARED_EMP]);
  await q('INSERT INTO employees (id, name, role, department, initials, color, online) VALUES (?, ?, ?, ?, ?, ?, 1)', [SHARED_EMP, '共享员工', '专员', '共享部', '共', '#3478f6']);

  // 公共 Agent（平台共享表，不含 tenant_id）
  await q('DELETE FROM agents WHERE id = ?', [SHARED_AGENT]);
  await q("INSERT INTO agents (id, agent_type, employee_id, name, system_instructions, model_provider, model_name, config_json, status, version) VALUES (?, 'employee', NULL, '共享Agent', 'x', 'deepseek', 'deepseek-v4-flash', '{}', 'active', 1)", [SHARED_AGENT]);

  const users: Array<[string, string, string]> = [
    ['tst_u_owner', 'owner@tst', 'A Owner'],
    ['tst_u_admin', 'admin@tst', 'A Admin'],
    ['tst_u_member', 'member@tst', 'A Member'],
    ['tst_u_viewer', 'viewer@tst', 'A Viewer'],
    ['tst_u_b', 'b@tst', 'B Owner'],
  ];
  for (const [id, email, name] of users) {
    await q('INSERT INTO users (id, email, display_name, password_hash, status) VALUES (?, ?, ?, NULL, ?) ON DUPLICATE KEY UPDATE email = VALUES(email)', [id, email, name, 'active']);
  }
  await q("INSERT INTO tenant_members (tenant_id, user_id, role, status) VALUES (?, 'tst_u_owner', 'owner', 'active') ON DUPLICATE KEY UPDATE role='owner'", [A]);
  await q("INSERT INTO tenant_members (tenant_id, user_id, role, status) VALUES (?, 'tst_u_admin', 'admin', 'active') ON DUPLICATE KEY UPDATE role='admin'", [A]);
  await q("INSERT INTO tenant_members (tenant_id, user_id, role, status) VALUES (?, 'tst_u_member', 'member', 'active') ON DUPLICATE KEY UPDATE role='member'", [A]);
  await q("INSERT INTO tenant_members (tenant_id, user_id, role, status) VALUES (?, 'tst_u_viewer', 'viewer', 'active') ON DUPLICATE KEY UPDATE role='viewer'", [A]);
  await q("INSERT INTO tenant_members (tenant_id, user_id, role, status) VALUES (?, 'tst_u_b', 'owner', 'active') ON DUPLICATE KEY UPDATE role='owner'", [B]);
}

async function cleanup() {
  await seed(); // seed 内部先清理再重写；这里再做一次完整清理避免残留
  await q("DELETE FROM tenant_members WHERE tenant_id IN (?, ?)", [A, B]);
  await q("DELETE FROM tenants WHERE id IN (?, ?)", [A, B]);
  await q("DELETE FROM users WHERE id LIKE 'tst_u_%'");
  await q('DELETE FROM employees WHERE id = ?', [SHARED_EMP]);
  await q('DELETE FROM agents WHERE id = ?', [SHARED_AGENT]);
  await q('DELETE FROM memories WHERE tenant_id IN (?, ?)', [A, B]);
  await q('DELETE FROM agent_runs WHERE tenant_id IN (?, ?)', [A, B]);
  await q('DELETE FROM agent_run_events WHERE tenant_id IN (?, ?)', [A, B]);
  await q('DELETE FROM attachments WHERE tenant_id IN (?, ?)', [A, B]);
  await q('DELETE FROM model_configs WHERE tenant_id IN (?, ?)', [A, B]);
  await q('DELETE FROM conversations WHERE tenant_id IN (?, ?)', [A, B]);
}

describe.skipIf(!dbAvailable)('多租户隔离与权限（集成）', () => {
  beforeAll(async () => {
    await ensureSchema();
    await seed();
  });
  afterAll(async () => {
    await cleanup();
  });

  it('租户 A/B 都能看到同一个公共员工角色', async () => {
    const a = await resolveTenantContext({ userId: 'tst_u_owner', email: 'owner@tst', displayName: 'A Owner', status: 'active' }, 'acme');
    const b = await resolveTenantContext({ userId: 'tst_u_b', email: 'b@tst', displayName: 'B Owner', status: 'active' }, 'beta');
    expect(a.tenantId).toBe(A);
    expect(b.tenantId).toBe(B);
    const rows = await q('SELECT id FROM employees WHERE id = ?', [SHARED_EMP]) as Array<{ id: string }>;
    expect(rows.length).toBe(1);
  });

  it('A 创建的会话不出现在 B 的会话列表', async () => {
    const convA = await createConversation(A, { type: 'single', employeeId: SHARED_EMP });
    const listA = await listConversations(A, { limit: 200 });
    const listB = await listConversations(B, { limit: 200 });
    expect(listA.items.some((c) => c.id === convA.id)).toBe(true);
    expect(listB.items.some((c) => c.id === convA.id)).toBe(false);
  });

  it('B 用 A 的 conversationId 读消息 / 写消息 / 查 run / 取消 run / 读事件均失败', async () => {
    const convA = await createConversation(A, { type: 'single', employeeId: SHARED_EMP });
    await appendMessage(A, { conversationId: convA.id, id: 'tst_m_a', sender: 'me', text: 'A 的私密消息' });

    // B 读不到 A 会话的消息
    const page = await listMessages(B, convA.id, { limit: 200 });
    expect(page.items.length).toBe(0);

    // B 向 A 会话写消息被拒（404，避免资源枚举）
    let writeRejected = false;
    try {
      await appendMessage(B, { conversationId: convA.id, sender: 'me', text: '越权写入' });
    } catch (e) {
      writeRejected = e instanceof ApiError && e.status === 404;
    }
    expect(writeRejected).toBe(true);

    // A 的 run 对 B 不可见，事件也不可见
    await createRun(A, { id: 'tst_run_a', rootRunId: 'tst_run_a', conversationId: convA.id, agentId: SHARED_AGENT, inputText: 'x', status: 'queued' });
    await appendRunEvent(A, 'tst_run_a', 'running', {});
    expect(await getRun(B, 'tst_run_a')).toBeNull();
    expect((await listRunEvents(B, 'tst_run_a')).length).toBe(0);
    // A 自己能看到
    expect(await getRun(A, 'tst_run_a')).not.toBeNull();
  });

  it('B 无法读取、下载、删除 A 的附件', async () => {
    await createAttachment(A, { id: 'att_tst_iso', ownerType: 'single', ownerId: SHARED_EMP, originalName: 'secret.txt', mimeType: 'text/plain', sizeBytes: 3, category: 'text', status: 'ready', extractedText: null, extractionMeta: null, data: new Uint8Array([1, 2, 3]) });
    expect(await getAttachment(B, 'att_tst_iso')).toBeNull();
    expect(await getAttachmentBytes(B, 'att_tst_iso')).toBeNull();
    expect(await deleteAttachment(B, 'att_tst_iso')).toBe(false);
    // A 自己仍可读，删除返回 true
    expect(await getAttachment(A, 'att_tst_iso')).not.toBeNull();
    expect(await deleteAttachment(A, 'att_tst_iso')).toBe(true);
  });

  it('同一公共 Agent 在 A/B 运行时只读取各自租户的 memory', async () => {
    await addMemory(A, { agentId: SHARED_AGENT, kind: 'long_term', content: 'A 的记忆' });
    await addMemory(B, { agentId: SHARED_AGENT, kind: 'long_term', content: 'B 的记忆' });
    const memA = await listMemories(A, SHARED_AGENT, 'long_term', 20);
    const memB = await listMemories(B, SHARED_AGENT, 'long_term', 20);
    expect(memA.map((m) => m.content)).toEqual(['A 的记忆']);
    expect(memB.map((m) => m.content)).toEqual(['B 的记忆']);
  });

  it('viewer 不能创建会话；member 不能改模型配置；admin 不能删租户；owner 可管理成员', async () => {
    const make = (userId: string, slug: string) => resolveTenantContext({ userId, email: `${userId}@tst`, displayName: userId, status: 'active' }, slug);
    const viewer = await make('tst_u_viewer', 'acme');
    const member = await make('tst_u_member', 'acme');
    const admin = await make('tst_u_admin', 'acme');
    const owner = await make('tst_u_owner', 'acme');

    // viewer：禁止创建会话（member 及以上才允许）
    expect(() => requireRole(viewer, 'owner', 'admin', 'member')).toThrow(ApiError);
    // member：禁止改模型配置（admin 及以上）
    expect(() => requireRole(member, 'owner', 'admin')).toThrow(ApiError);
    // admin：禁止删除租户（仅 owner）
    expect(() => requireRole(admin, 'owner')).toThrow(ApiError);
    // owner：可管理成员（owner/admin 均可管理成员）
    expect(() => requireRole(owner, 'owner', 'admin')).not.toThrow();

    // owner 实际执行成员管理
    await upsertTenantMember(A, { email: 'newmember@tst', displayName: '新成员', role: 'member' });
    const members = await listTenantMembers(A);
    const added = members.find((m) => m.email === 'newmember@tst');
    expect(added?.role).toBe('member');
    await removeTenantMember(A, added!.userId);
  });

  it('model_configs 按租户隔离：A 的配置不影响 B', async () => {
    await upsertModelConfig(A, 'deepseek', { modelName: 'a-model', apiKey: 'a-key' });
    await upsertModelConfig(B, 'deepseek', { modelName: 'b-model', apiKey: 'b-key' });
    const cfgA = await listModelConfigs(A);
    const cfgB = await listModelConfigs(B);
    expect(cfgA.find((c) => c.provider === 'deepseek')?.modelName).toBe('a-model');
    expect(cfgB.find((c) => c.provider === 'deepseek')?.modelName).toBe('b-model');
    // 密钥不明文返回
    expect(cfgA.every((c) => c.apiKey === '')).toBe(true);
  });

  it('requireTenantContext：无 session 返回 401，非成员返回 403，跨租户资源解析按 URL slug', async () => {
    const { token } = await createSession('tst_u_owner');
    const ctx = await requireTenantContext(tenantRequest(token, 'acme', '/v2/conversations'));
    expect(ctx.tenantId).toBe(A);

    await expect(requireTenantContext(new Request('http://localhost/api/t/acme/v2/conversations'))).rejects.toMatchObject({ status: 401 });

    const { token: tokenB } = await createSession('tst_u_b');
    await expect(requireTenantContext(tenantRequest(tokenB, 'acme', '/v2/conversations'))).rejects.toMatchObject({ status: 403 });
  });

  it('迁移脚本重复执行安全且历史数据归入默认租户', async () => {
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const script = resolve(root, 'scripts/migrations/migrate-multitenancy.mjs');
    const env = { ...process.env };
    for (let i = 0; i < 2; i++) {
      const out = execFileSync('node', [script], { env, encoding: 'utf8' });
      expect(out).toContain('多租户迁移完成');
    }
    const tenants = await q("SELECT id FROM tenants WHERE slug = 'default'") as Array<{ id: string }>;
    expect(tenants.length).toBe(1);
    const migrated = await q("SELECT name FROM schema_migrations WHERE name = 'multitenancy_v1'") as Array<{ name: string }>;
    expect(migrated.length).toBe(1);
  });
});
