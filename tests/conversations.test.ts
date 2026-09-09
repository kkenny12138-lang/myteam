/**
 * S0 集成测试（需要本地 MySQL，见 scripts/start-test-db.ps1）：
 * - 并发追加消息不丢失
 * - 迁移可重复执行（幂等）且旧消息/附件关联完整
 * - 附件关联失败回滚
 * - 游标分页、恢复方法
 * 数据库不可用时自动跳过（描述 skipIf），可在无库环境下 `npm test` 不报错。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT || '3307';
process.env.DB_USER = process.env.DB_USER || 'myteam';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'myteam123';
process.env.DB_NAME = process.env.DB_NAME || 'myteam';

import { ensureSchema, getPool, isDbConfigured } from '@/lib/db';
import {
  appendMessage,
  createConversation,
  defaultConversationId,
  listConversations,
  listMessages,
} from '@/lib/repositories/conversations';
import { migrateToConversations, resetConversationMigration, verifyConversationMigration } from '@/lib/agent/conversation-migrate';
import { createAttachment } from '@/lib/repositories/attachments';

const LEGACY = 'tenant_legacy';

const dbAvailable = await (async () => {
  if (!isDbConfigured()) return false;
  try {
    await ensureSchema();
    await getPool().query('SELECT 1');
    return true;
  } catch (e) {
    console.warn('[conversations.test] 数据库不可用，跳过集成测试：', e instanceof Error ? e.message : e);
    return false;
  }
})();

const q = (sql: string, params: unknown[] = []) => getPool().query(sql, params);

async function truncateNewTables() {
  await q('DELETE FROM conversation_message_attachments');
  await q('DELETE FROM conversation_messages');
  await q('DELETE FROM conversations');
}

async function cleanupSeed() {
  await q("DELETE FROM message_attachments WHERE message_id LIKE 'tst_%'");
  await q("DELETE FROM messages WHERE employee_id LIKE 'tst_%'");
  await q("DELETE FROM group_messages WHERE group_id LIKE 'tst_%'");
  await q("DELETE FROM chat_groups WHERE id LIKE 'tst_%'");
  await q("DELETE FROM attachments WHERE id LIKE 'att_tst_%'");
  await q("DELETE FROM employees WHERE id LIKE 'tst_%'");
}

describe.skipIf(!dbAvailable)('S0 会话与增量消息（集成）', () => {
  beforeAll(async () => {
    await ensureSchema();
    await truncateNewTables();
    await cleanupSeed();
  });

  afterAll(async () => {
    await truncateNewTables();
    await cleanupSeed();
  });

  describe('并发追加消息不丢失', () => {
    it('同一会话并发追加 N 条消息全部落库且 seq 单调', async () => {
      const conv = await createConversation(LEGACY, { type: 'single', employeeId: 'tst_emp_conc' });
      const N = 12;
      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          appendMessage(LEGACY, { conversationId: conv.id, id: `tst_m_conc_${i}`, sender: i % 2 === 0 ? 'me' : 'employee', text: `消息 ${i}` })
        )
      );
      const page = await listMessages(LEGACY, conv.id, { limit: 200 });
      expect(page.items.length).toBe(N);
      expect(page.items.map((m) => m.id).sort()).toEqual(Array.from({ length: N }, (_, i) => `tst_m_conc_${i}`).sort());
      const seqs = page.items.map((m) => m.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(N);

      const list = await listConversations(LEGACY, { limit: 200 });
      expect(list.items.some((c) => c.id === conv.id)).toBe(true);
    });
  });

  describe('迁移可重复执行（幂等）', () => {
    it('迁移两次结果一致，旧消息 ID/顺序/附件关联完整保留', async () => {
      const empId = 'tst_emp_mig';
      await q('INSERT INTO employees (id, name, role, department, initials, color, online) VALUES (?, ?, ?, ?, ?, ?, 1)', [empId, '迁移员工', '专员', '测试部', '迁', '#888888']);
      await q('INSERT INTO messages (id, tenant_id, employee_id, sender, text, time, tokens) VALUES (?, ?, ?, ?, ?, ?, ?)', ['tst_msg_m1', LEGACY, empId, 'me', '你好', '', 0]);
      await q('INSERT INTO messages (id, tenant_id, employee_id, sender, text, time, tokens) VALUES (?, ?, ?, ?, ?, ?, ?)', ['tst_msg_m2', LEGACY, empId, 'employee', '你好，有什么可以帮你', '', 5]);
      await q('INSERT INTO messages (id, tenant_id, employee_id, sender, text, time, tokens) VALUES (?, ?, ?, ?, ?, ?, ?)', ['tst_msg_m3', LEGACY, empId, 'me', '帮我做个分析', '', 0]);

      const groupId = 'tst_grp_mig';
      await q('INSERT INTO chat_groups (id, tenant_id, name, members) VALUES (?, ?, ?, ?)', [groupId, LEGACY, '迁移群', JSON.stringify([empId])]);
      await q('INSERT INTO group_messages (id, tenant_id, group_id, sender, sender_name, text, time, tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ['tst_msg_g1', LEGACY, groupId, 'me', '', '群聊消息', '', 0]);

      await createAttachment(LEGACY, { id: 'att_tst_mig', ownerType: 'single', ownerId: empId, originalName: 'a.txt', mimeType: 'text/plain', sizeBytes: 3, category: 'text', status: 'ready', extractedText: null, extractionMeta: null, data: null });
      await q('INSERT INTO message_attachments (tenant_id, message_type, message_id, attachment_id, sort_order) VALUES (?, ?, ?, ?, ?)', [LEGACY, 'single', 'tst_msg_m1', 'att_tst_mig', 0]);

      const first = await migrateToConversations();
      expect(first.verified).toBe(true);
      expect(first.missingMessageIds).not.toContain('tst_msg_m1');
      expect(first.missingMessageIds).not.toContain('tst_msg_g1');

      const second = await migrateToConversations();
      expect(second.singleMessagesCopied).toBe(0);
      expect(second.groupMessagesCopied).toBe(0);
      expect(second.attachmentsLinked).toBe(0);
      expect(second.conversationsCreated).toBe(0);

      const verification = await verifyConversationMigration();
      expect(verification.missingMessageIds).not.toContain('tst_msg_m1');
      expect(verification.missingMessageIds).not.toContain('tst_msg_g1');
      expect(verification.ok).toBe(true);

      const dmId = defaultConversationId('single', empId);
      const page = await listMessages(LEGACY, dmId, { limit: 200 });
      expect(page.items.map((m) => m.id)).toEqual(['tst_msg_m1', 'tst_msg_m2', 'tst_msg_m3']);
      expect(page.items[0].attachments.map((a) => a.id)).toEqual(['att_tst_mig']);

      const groupPage = await listMessages(LEGACY, defaultConversationId('group', groupId), { limit: 200 });
      expect(groupPage.items.map((m) => m.id)).toEqual(['tst_msg_g1']);
      expect(groupPage.items[0].text).toBe('群聊消息');
    });
  });

  describe('附件关联失败回滚', () => {
    it('引用不存在的附件时整条消息回滚，不落库', async () => {
      const conv = await createConversation(LEGACY, { type: 'single', employeeId: 'tst_emp_rollback' });
      let threw = false;
      try {
        await appendMessage(LEGACY, { conversationId: conv.id, id: 'tst_msg_rollback', sender: 'me', text: '带坏附件', attachmentIds: ['att_not_exists'] });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      const page = await listMessages(LEGACY, conv.id, { limit: 200 });
      expect(page.items.length).toBe(0);
    });

    it('引用属于其他会话的附件同样回滚', async () => {
      const convA = await createConversation(LEGACY, { type: 'single', employeeId: 'tst_emp_a' });
      await createConversation(LEGACY, { type: 'single', employeeId: 'tst_emp_b' });
      await createAttachment(LEGACY, { id: 'att_tst_owned', ownerType: 'single', ownerId: 'tst_emp_b', originalName: 'b.txt', mimeType: 'text/plain', sizeBytes: 3, category: 'text', status: 'ready', extractedText: null, extractionMeta: null, data: null });
      let threw = false;
      try {
        await appendMessage(LEGACY, { conversationId: convA.id, sender: 'me', text: '越权附件', attachmentIds: ['att_tst_owned'] });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      const page = await listMessages(LEGACY, convA.id, { limit: 200 });
      expect(page.items.length).toBe(0);
    });

    it('附件归属正确时消息与关联都落库', async () => {
      const conv = await createConversation(LEGACY, { type: 'single', employeeId: 'tst_emp_ok' });
      await createAttachment(LEGACY, { id: 'att_tst_ok', ownerType: 'single', ownerId: 'tst_emp_ok', originalName: 'ok.txt', mimeType: 'text/plain', sizeBytes: 3, category: 'text', status: 'ready', extractedText: null, extractionMeta: null, data: null });
      const msg = await appendMessage(LEGACY, { conversationId: conv.id, sender: 'me', text: '带附件', attachmentIds: ['att_tst_ok'] });
      expect(msg.attachments.map((a) => a.id)).toEqual(['att_tst_ok']);
      const page = await listMessages(LEGACY, conv.id, { limit: 200 });
      expect(page.items.length).toBe(1);
      expect(page.items[0].attachments.map((a) => a.id)).toEqual(['att_tst_ok']);
    });
  });

  describe('游标分页与恢复方法', () => {
    it('按 seq 游标翻页不重不漏', async () => {
      const conv = await createConversation(LEGACY, { type: 'single', employeeId: 'tst_emp_page' });
      for (let i = 0; i < 5; i++) {
        await appendMessage(LEGACY, { conversationId: conv.id, id: `tst_msg_page_${i}`, sender: 'me', text: `第 ${i} 条` });
      }
      const p1 = await listMessages(LEGACY, conv.id, { limit: 2 });
      const p2 = await listMessages(LEGACY, conv.id, { cursor: p1.nextCursor, limit: 2 });
      const p3 = await listMessages(LEGACY, conv.id, { cursor: p2.nextCursor, limit: 2 });
      expect(p1.items.length).toBe(2);
      expect(p2.items.length).toBe(2);
      expect(p3.items.length).toBe(1);
      expect(p3.nextCursor).toBeNull();
      const all = [...p1.items, ...p2.items, ...p3.items].map((m) => m.seq);
      expect(new Set(all).size).toBe(5);
    });

    it('恢复方法清空新表但不触碰旧表数据', async () => {
      const empId = 'tst_emp_recover';
      await q('INSERT INTO employees (id, name, role, department, initials, color, online) VALUES (?, ?, ?, ?, ?, ?, 1)', [empId, '恢复员工', '专员', '测试部', '恢', '#888888']);
      await q('INSERT INTO messages (id, tenant_id, employee_id, sender, text, time, tokens) VALUES (?, ?, ?, ?, ?, ?, ?)', ['tst_msg_rec', LEGACY, empId, 'me', '旧数据', '', 0]);
      await migrateToConversations();
      await resetConversationMigration();

      const convCount = await q('SELECT COUNT(*) AS c FROM conversations') as Array<{ c: number | bigint }>;
      const msgCount = await q('SELECT COUNT(*) AS c FROM conversation_messages') as Array<{ c: number | bigint }>;
      expect(Number(convCount[0].c)).toBe(0);
      expect(Number(msgCount[0].c)).toBe(0);

      const oldRows = await q('SELECT id FROM messages WHERE id = ?', ['tst_msg_rec']) as Array<{ id: string }>;
      expect(oldRows.length).toBe(1); // 旧表未被触碰
    });
  });
});
