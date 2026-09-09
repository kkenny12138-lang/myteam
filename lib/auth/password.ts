/**
 * 密码哈希工具（scrypt），格式：scrypt$<saltHex>$<hashHex>。
 * 迁移脚本 scripts/migrations/migrate-multitenancy.mjs 内置了同样的算法，
 * 以便在应用构建产物之外独立创建种子管理员用户。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, KEY_LEN).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hashHex] = parts;
  if (!salt || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const candidate = scryptSync(password, salt, expected.length);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
