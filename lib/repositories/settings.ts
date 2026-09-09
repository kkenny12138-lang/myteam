/**
 * settings 数据访问层（租户级，主键 (tenant_id, k)）。
 * docs/MULTI_TENANCY_IMPLEMENTATION_SPEC.md §2.2 / §4
 */
import { ensureSchema, getPool, isDbConfigured } from '@/lib/db';

export async function getSettings(tenantId: string): Promise<Record<string, string>> {
  if (!isDbConfigured()) return {};
  await ensureSchema();
  const rows = await getPool().query('SELECT k, v FROM settings WHERE tenant_id = ?', [tenantId]) as Array<{ k: string; v: string }>;
  return Object.fromEntries(rows.map((r) => [r.k, r.v]));
}

export async function upsertSetting(tenantId: string, key: string, value: string): Promise<void> {
  await ensureSchema();
  await getPool().query(
    'INSERT INTO settings (tenant_id, k, v) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)',
    [tenantId, key, value]
  );
}

export async function deleteSetting(tenantId: string, key: string): Promise<void> {
  await ensureSchema();
  await getPool().query('DELETE FROM settings WHERE tenant_id = ? AND k = ?', [tenantId, key]);
}
