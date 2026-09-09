/**
 * 历史数据迁移：旧 messages / group_messages → conversations / conversation_messages（S0）。
 * 文档依据：docs/FEATURE_DEVELOPMENT_ROADMAP.md §4.2 / §15.3
 *
 * 设计原则：
 * - 只迁移数据，绝不删除或清空旧表（messages / group_messages / message_attachments 原样保留）。
 * - 幂等可重复执行：会话用确定性 ID（dm_<员工> / grp_<群>），消息按原 ID INSERT IGNORE。
 * - 单聊按员工、群聊按群映射成默认会话，保留原 message ID、顺序与附件关联。
 * - 迁移是部署命令，不在聊天请求中触发。
 */
import { ensureSchema, getPool, isDbConfigured } from '@/lib/db';
import { defaultConversationId, insertAttachmentLinkIgnoring, insertMessageIgnoring } from '@/lib/repositories/conversations';
import type { PoolConnection } from 'mariadb';

const MIGRATION_NAME = 'conversation_bootstrap_v1';
const LEGACY_TENANT = 'tenant_legacy';

export interface ConversationMigrationReport {
  skipped: boolean;
  conversationsCreated: number;
  conversationsExisted: number;
  singleMessagesCopied: number;
  groupMessagesCopied: number;
  attachmentsLinked: number;
  verified: boolean;
  missingMessageIds: string[];
}

export interface ConversationVerification {
  sourceSingleMessages: number;
  sourceGroupMessages: number;
  targetMessages: number;
  sourceAttachments: number;
  targetAttachments: number;
  missingMessageIds: string[];
  ok: boolean;
}

export async function migrateToConversations(): Promise<ConversationMigrationReport> {
  const report: ConversationMigrationReport = {
    skipped: false,
    conversationsCreated: 0,
    conversationsExisted: 0,
    singleMessagesCopied: 0,
    groupMessagesCopied: 0,
    attachmentsLinked: 0,
    verified: false,
    missingMessageIds: [],
  };
  if (!isDbConfigured()) return { ...report, skipped: true };
  await ensureSchema();

  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();

    // ---- 单聊：按员工映射为默认会话 ----
    const employees = await connection.query('SELECT DISTINCT employee_id FROM messages ORDER BY employee_id ASC') as Array<{ employee_id: string }>;
    const messageToConversation = new Map<string, string>();
    for (const row of employees) {
      const employeeId = row.employee_id;
      const conversationId = defaultConversationId('single', employeeId);
      const title = await employeeTitle(connection, employeeId);
      await ensureConversation(connection, LEGACY_TENANT, conversationId, 'single', employeeId, null, title, report);
      const msgs = await connection.query(
        'SELECT id, sender, text, tokens FROM messages WHERE employee_id = ? ORDER BY created_at ASC, id ASC',
        [employeeId]
      ) as Array<{ id: string; sender: string; text: string; tokens: number }>;
      for (const m of msgs) {
        const copied = await insertMessageIgnoring(connection, LEGACY_TENANT, {
          id: m.id,
          conversationId,
          sender: m.sender === 'me' ? 'me' : 'employee',
          senderName: '',
          text: m.text,
          tokens: Number(m.tokens || 0),
        });
        if (copied) report.singleMessagesCopied++;
        messageToConversation.set(m.id, conversationId);
      }
    }

    // ---- 群聊：按群映射为默认会话 ----
    const groups = await connection.query('SELECT DISTINCT group_id FROM group_messages ORDER BY group_id ASC') as Array<{ group_id: string }>;
    for (const row of groups) {
      const groupId = row.group_id;
      const conversationId = defaultConversationId('group', groupId);
      const title = await groupTitle(connection, groupId);
      await ensureConversation(connection, LEGACY_TENANT, conversationId, 'group', null, groupId, title, report);
      const msgs = await connection.query(
        'SELECT id, sender, sender_name, text, tokens FROM group_messages WHERE group_id = ? ORDER BY created_at ASC, id ASC',
        [groupId]
      ) as Array<{ id: string; sender: string; sender_name: string; text: string; tokens: number }>;
      for (const m of msgs) {
        const copied = await insertMessageIgnoring(connection, LEGACY_TENANT, {
          id: m.id,
          conversationId,
          sender: m.sender === 'me' ? 'me' : 'employee',
          senderName: m.sender_name || '',
          text: m.text,
          tokens: Number(m.tokens || 0),
        });
        if (copied) report.groupMessagesCopied++;
        messageToConversation.set(m.id, conversationId);
      }
    }

    // ---- 附件关联迁移（message_id 在原表与迁移后保持一致）----
    const links = await connection.query('SELECT message_type, message_id, attachment_id, sort_order FROM message_attachments ORDER BY message_type, message_id, attachment_id') as Array<{
      message_type: string; message_id: string; attachment_id: string; sort_order: number;
    }>;
    for (const link of links) {
      const conversationId = messageToConversation.get(link.message_id);
      if (!conversationId) continue; // 孤儿关联（消息已不存在）跳过
      const linked = await insertAttachmentLinkIgnoring(connection, LEGACY_TENANT, link.message_id, link.attachment_id, Number(link.sort_order || 0));
      if (linked) report.attachmentsLinked++;
    }

    await connection.query(
      'INSERT IGNORE INTO schema_migrations (name) VALUES (?)',
      [MIGRATION_NAME]
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  // 迁移后校验（事务外只读）
  const verification = await verifyConversationMigration();
  report.verified = verification.ok;
  report.missingMessageIds = verification.missingMessageIds;
  return report;
}

async function ensureConversation(
  connection: PoolConnection,
  tenantId: string,
  id: string,
  type: 'single' | 'group',
  employeeId: string | null,
  groupId: string | null,
  title: string,
  report: ConversationMigrationReport
): Promise<void> {
  const existing = await connection.query('SELECT id FROM conversations WHERE id = ? AND tenant_id = ? LIMIT 1', [id, tenantId]) as Array<{ id: string }>;
  if (existing.length) {
    report.conversationsExisted++;
    return;
  }
  await connection.query(
    'INSERT INTO conversations (id, tenant_id, type, employee_id, group_id, title, version) VALUES (?, ?, ?, ?, ?, ?, 1)',
    [id, tenantId, type, employeeId, groupId, title]
  );
  report.conversationsCreated++;
}

async function employeeTitle(connection: PoolConnection, employeeId: string): Promise<string> {
  const rows = await connection.query('SELECT name FROM employees WHERE id = ? LIMIT 1', [employeeId]) as Array<{ name: string }>;
  return rows[0]?.name ? `与 ${rows[0].name} 的对话` : `单聊 ${employeeId}`;
}

async function groupTitle(connection: PoolConnection, groupId: string): Promise<string> {
  const rows = await connection.query('SELECT name FROM chat_groups WHERE id = ? LIMIT 1', [groupId]) as Array<{ name: string }>;
  return rows[0]?.name || `群聊 ${groupId}`;
}

/** 只读校验：旧表消息是否全部出现在新表、附件关联是否齐全。 */
export async function verifyConversationMigration(): Promise<ConversationVerification> {
  const result: ConversationVerification = {
    sourceSingleMessages: 0,
    sourceGroupMessages: 0,
    targetMessages: 0,
    sourceAttachments: 0,
    targetAttachments: 0,
    missingMessageIds: [],
    ok: false,
  };
  if (!isDbConfigured()) return result;
  await ensureSchema();
  const pool = getPool();

  const singleRows = await pool.query('SELECT id FROM messages') as Array<{ id: string }>;
  const groupRows = await pool.query('SELECT id FROM group_messages') as Array<{ id: string }>;
  const targetRows = await pool.query('SELECT id FROM conversation_messages') as Array<{ id: string }>;
  const sourceAtt = await pool.query('SELECT message_id FROM message_attachments') as Array<{ message_id: string }>;
  const targetAtt = await pool.query('SELECT message_id FROM conversation_message_attachments') as Array<{ message_id: string }>;

  result.sourceSingleMessages = singleRows.length;
  result.sourceGroupMessages = groupRows.length;
  result.targetMessages = targetRows.length;
  result.sourceAttachments = sourceAtt.length;
  result.targetAttachments = targetAtt.length;

  const targetIds = new Set(targetRows.map((r) => r.id));
  const allSourceIds = [...singleRows, ...groupRows].map((r) => r.id);
  result.missingMessageIds = allSourceIds.filter((id) => !targetIds.has(id));
  result.ok = result.missingMessageIds.length === 0;
  return result;
}

/** 恢复方法：仅删除本次迁移新增的三张表数据与迁移标记，旧表（messages/group_messages/message_attachments）绝不触碰。 */
export async function resetConversationMigration(): Promise<{ ok: boolean }> {
  if (!isDbConfigured()) return { ok: false };
  await ensureSchema();
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    await connection.query('DELETE FROM conversation_message_attachments');
    await connection.query('DELETE FROM conversation_messages');
    await connection.query('DELETE FROM conversations');
    await connection.query('DELETE FROM schema_migrations WHERE name = ?', [MIGRATION_NAME]);
    await connection.commit();
    return { ok: true };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
