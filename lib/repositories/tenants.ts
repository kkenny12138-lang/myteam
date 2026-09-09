/**
 * tenants / users / tenant_members 数据访问层（多租户身份与成员管理）。
 * docs/MULTI_TENANCY_IMPLEMENTATION_SPEC.md §3
 */
import { ensureSchema, getPool, isDbConfigured } from '@/lib/db';
import { hashPassword } from '@/lib/auth/password';
import type { TenantRole } from '@/lib/auth/context';

export interface TenantRecord {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended';
  plan: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface TenantMember {
  tenantId: string;
  userId: string;
  role: TenantRole;
  status: 'active' | 'invited' | 'disabled';
  email?: string;
  displayName?: string;
}

function newId(): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 18)
    : Math.random().toString(36).slice(2, 20).padEnd(18, '0');
  return `${Date.now().toString(36)}${rnd}`.slice(0, 26);
}

export async function createTenant(input: { slug: string; name: string; plan?: string }): Promise<TenantRecord> {
  await ensureSchema();
  const id = newId();
  await getPool().query(
    'INSERT INTO tenants (id, slug, name, status, plan) VALUES (?, ?, ?, ?, ?)',
    [id, input.slug, input.name, 'active', input.plan || 'free']
  );
  return (await getTenantBySlug(input.slug))!;
}

export async function getTenantBySlug(slug: string): Promise<TenantRecord | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const rows = await getPool().query(
    'SELECT id, slug, name, status, plan, created_at, updated_at FROM tenants WHERE slug = ? LIMIT 1',
    [slug]
  ) as Array<Record<string, unknown>>;
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r.id),
    slug: String(r.slug),
    name: String(r.name),
    status: r.status as TenantRecord['status'],
    plan: String(r.plan),
    createdAt: r.created_at ? String(r.created_at) : undefined,
    updatedAt: r.updated_at ? String(r.updated_at) : undefined,
  };
}

export async function deleteTenant(tenantId: string): Promise<boolean> {
  await ensureSchema();
  const result = await getPool().query('DELETE FROM tenants WHERE id = ?', [tenantId]);
  return Number((result as { affectedRows?: number }).affectedRows) > 0;
}

export async function listTenantMembers(tenantId: string): Promise<TenantMember[]> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  const rows = await getPool().query(
    `SELECT tm.tenant_id, tm.user_id, tm.role, tm.status, u.email, u.display_name
     FROM tenant_members tm JOIN users u ON u.id = tm.user_id
     WHERE tm.tenant_id = ? ORDER BY FIELD(tm.role, 'owner', 'admin', 'member', 'viewer'), u.email ASC`,
    [tenantId]
  ) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    tenantId: String(r.tenant_id),
    userId: String(r.user_id),
    role: r.role as TenantRole,
    status: r.status as TenantMember['status'],
    email: r.email ? String(r.email) : undefined,
    displayName: r.display_name ? String(r.display_name) : undefined,
  }));
}

export async function upsertTenantMember(
  tenantId: string,
  input: { userId?: string; email?: string; displayName?: string; role: TenantRole; status?: TenantMember['status'] }
): Promise<TenantMember> {
  await ensureSchema();
  let userId = input.userId;
  if (!userId && input.email) {
    const rows = await getPool().query('SELECT id FROM users WHERE email = ? LIMIT 1', [input.email.toLowerCase()]) as Array<{ id: string }>;
    if (rows.length) userId = rows[0].id;
  }
  if (!userId) {
    if (!input.email) throw new Error('成员必须有 userId 或 email');
    userId = newId();
    await getPool().query(
      'INSERT INTO users (id, email, display_name, password_hash, status) VALUES (?, ?, ?, ?, ?)',
      [userId, input.email.toLowerCase(), input.displayName || input.email, null, 'active']
    );
  }
  await getPool().query(
    `INSERT INTO tenant_members (tenant_id, user_id, role, status) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE role = VALUES(role), status = VALUES(status)`,
    [tenantId, userId, input.role, input.status || 'active']
  );
  const rows = await getPool().query(
    `SELECT tm.tenant_id, tm.user_id, tm.role, tm.status, u.email, u.display_name
     FROM tenant_members tm JOIN users u ON u.id = tm.user_id
     WHERE tm.tenant_id = ? AND tm.user_id = ? LIMIT 1`,
    [tenantId, userId]
  ) as Array<Record<string, unknown>>;
  const r = rows[0];
  return {
    tenantId: String(r.tenant_id),
    userId: String(r.user_id),
    role: r.role as TenantRole,
    status: r.status as TenantMember['status'],
    email: r.email ? String(r.email) : undefined,
    displayName: r.display_name ? String(r.display_name) : undefined,
  };
}

export async function removeTenantMember(tenantId: string, userId: string): Promise<boolean> {
  await ensureSchema();
  const result = await getPool().query('DELETE FROM tenant_members WHERE tenant_id = ? AND user_id = ?', [tenantId, userId]);
  return Number((result as { affectedRows?: number }).affectedRows) > 0;
}

/** 创建平台运维用户（写公共角色时使用），返回用户 id */
export async function ensurePlatformUser(email: string, displayName: string, password?: string): Promise<string> {
  await ensureSchema();
  const normalized = email.toLowerCase();
  const rows = await getPool().query('SELECT id FROM users WHERE email = ? LIMIT 1', [normalized]) as Array<{ id: string }>;
  if (rows.length) return rows[0].id;
  const id = newId();
  await getPool().query(
    'INSERT INTO users (id, email, display_name, password_hash, status) VALUES (?, ?, ?, ?, ?)',
    [id, normalized, displayName, password ? hashPassword(password) : null, 'active']
  );
  return id;
}
