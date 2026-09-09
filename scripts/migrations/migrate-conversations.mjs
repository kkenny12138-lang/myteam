/**
 * 部署迁移命令：历史消息 → 独立会话（S0）。
 *
 * 用法（在项目根目录）：
 *   node --env-file-if-exists=.env scripts/migrations/migrate-conversations.mjs
 * 或通过 npm 脚本：
 *   npm run migrate:conversations
 *
 * 依赖环境变量 DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME。
 * 说明：本脚本自包含（不依赖应用构建产物），幂等可重复执行，绝不删除旧表数据。
 */
import mariadb from 'mariadb';

const REQUIRED = ['DB_HOST', 'DB_USER', 'DB_NAME'];

function config() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`缺少环境变量：${missing.join(', ')}（可在 .env 中配置，或用 --env-file-if-exists=.env）`);
    process.exit(2);
  }
  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME,
  };
}

const CREATE_TABLES = [
  `CREATE TABLE IF NOT EXISTS conversations (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id CHAR(26) NOT NULL,
  type ENUM('single','group') NOT NULL,
  employee_id VARCHAR(50) NULL,
  group_id VARCHAR(50) NULL,
  title VARCHAR(200) NOT NULL DEFAULT '',
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_conversations_tenant_updated (tenant_id, updated_at, id),
  INDEX idx_conversation_employee (employee_id),
  INDEX idx_conversation_group (group_id),
  INDEX idx_conversation_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS conversation_messages (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id CHAR(26) NOT NULL,
  conversation_id VARCHAR(64) NOT NULL,
  seq BIGINT NOT NULL AUTO_INCREMENT,
  sender ENUM('me','employee') NOT NULL,
  sender_name VARCHAR(100) NOT NULL DEFAULT '',
  text MEDIUMTEXT NOT NULL,
  tokens INT NOT NULL DEFAULT 0,
  run_id VARCHAR(64) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_convmsg_seq (seq),
  INDEX idx_convmsg_tenant_conversation_seq (tenant_id, conversation_id, seq),
  INDEX idx_convmsg_conversation (conversation_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS conversation_message_attachments (
  tenant_id CHAR(26) NOT NULL,
  message_id VARCHAR(64) NOT NULL,
  attachment_id VARCHAR(64) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (message_id, attachment_id),
  INDEX idx_cma_tenant (tenant_id),
  INDEX idx_cma_attachment (attachment_id),
  CONSTRAINT fk_cma_message FOREIGN KEY (message_id) REFERENCES conversation_messages (id) ON DELETE CASCADE,
  CONSTRAINT fk_cma_attachment FOREIGN KEY (attachment_id) REFERENCES attachments (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

async function main() {
  const cfg = config();
  const pool = mariadb.createPool({ ...cfg, connectionLimit: 5, charset: 'utf8mb4', allowPublicKeyRetrieval: true });
  const conn = await pool.getConnection();
  try {
    for (const stmt of CREATE_TABLES) await conn.query(stmt);

    const report = { conversationsCreated: 0, conversationsExisted: 0, singleCopied: 0, groupCopied: 0, links: 0 };
    const messageToConversation = new Map();

    await conn.beginTransaction();

    // 单聊
    const employees = await conn.query('SELECT DISTINCT employee_id FROM messages ORDER BY employee_id ASC');
    for (const { employee_id } of employees) {
      const convId = `dm_${employee_id}`;
      const titleRows = await conn.query('SELECT name FROM employees WHERE id = ? LIMIT 1', [employee_id]);
      const title = titleRows[0]?.name ? `与 ${titleRows[0].name} 的对话` : `单聊 ${employee_id}`;
      const exists = await conn.query('SELECT id FROM conversations WHERE id = ? AND tenant_id = ? LIMIT 1', [convId, 'tenant_legacy']);
      if (exists.length) report.conversationsExisted++;
      else {
        await conn.query('INSERT INTO conversations (id, tenant_id, type, employee_id, group_id, title, version) VALUES (?, ?, "single", ?, NULL, ?, 1)', [convId, 'tenant_legacy', employee_id, title]);
        report.conversationsCreated++;
      }
      const msgs = await conn.query('SELECT id, sender, text, tokens FROM messages WHERE employee_id = ? ORDER BY created_at ASC, id ASC', [employee_id]);
      for (const m of msgs) {
        const r = await conn.query('INSERT IGNORE INTO conversation_messages (id, tenant_id, conversation_id, sender, sender_name, text, tokens) VALUES (?, ?, ?, ?, ?, ?, ?)', [m.id, 'tenant_legacy', convId, m.sender === 'me' ? 'me' : 'employee', '', m.text, Number(m.tokens || 0)]);
        if (r.affectedRows) report.singleCopied++;
        messageToConversation.set(m.id, convId);
      }
    }

    // 群聊
    const groups = await conn.query('SELECT DISTINCT group_id FROM group_messages ORDER BY group_id ASC');
    for (const { group_id } of groups) {
      const convId = `grp_${group_id}`;
      const titleRows = await conn.query('SELECT name FROM chat_groups WHERE id = ? LIMIT 1', [group_id]);
      const title = titleRows[0]?.name || `群聊 ${group_id}`;
      const exists = await conn.query('SELECT id FROM conversations WHERE id = ? AND tenant_id = ? LIMIT 1', [convId, 'tenant_legacy']);
      if (exists.length) report.conversationsExisted++;
      else {
        await conn.query('INSERT INTO conversations (id, tenant_id, type, employee_id, group_id, title, version) VALUES (?, ?, "group", NULL, ?, ?, 1)', [convId, 'tenant_legacy', group_id, title]);
        report.conversationsCreated++;
      }
      const msgs = await conn.query('SELECT id, sender, sender_name, text, tokens FROM group_messages WHERE group_id = ? ORDER BY created_at ASC, id ASC', [group_id]);
      for (const m of msgs) {
        const r = await conn.query('INSERT IGNORE INTO conversation_messages (id, tenant_id, conversation_id, sender, sender_name, text, tokens) VALUES (?, ?, ?, ?, ?, ?, ?)', [m.id, 'tenant_legacy', convId, m.sender === 'me' ? 'me' : 'employee', m.sender_name || '', m.text, Number(m.tokens || 0)]);
        if (r.affectedRows) report.groupCopied++;
        messageToConversation.set(m.id, convId);
      }
    }

    // 附件关联
    const links = await conn.query('SELECT message_type, message_id, attachment_id, sort_order FROM message_attachments ORDER BY message_type, message_id, attachment_id');
    for (const l of links) {
      const convId = messageToConversation.get(l.message_id);
      if (!convId) continue;
      const r = await conn.query('INSERT IGNORE INTO conversation_message_attachments (tenant_id, message_id, attachment_id, sort_order) VALUES (?, ?, ?, ?)', ['tenant_legacy', l.message_id, l.attachment_id, Number(l.sort_order || 0)]);
      if (r.affectedRows) report.links++;
    }

    await conn.query('INSERT IGNORE INTO schema_migrations (name) VALUES (?)', ['conversation_bootstrap_v1']);
    await conn.commit();

    // 校验
    const srcSingle = (await conn.query('SELECT id FROM messages')).length;
    const srcGroup = (await conn.query('SELECT id FROM group_messages')).length;
    const tgt = (await conn.query('SELECT id FROM conversation_messages')).length;
    const tgtIds = new Set((await conn.query('SELECT id FROM conversation_messages')).map((r) => r.id));
    const missing = [...(await conn.query('SELECT id FROM messages')), ...(await conn.query('SELECT id FROM group_messages'))]
      .map((r) => r.id)
      .filter((id) => !tgtIds.has(id));

    console.log('');
    console.log('=== MyTeam 会话迁移完成 ===');
    console.log(`  会话：新建 ${report.conversationsCreated}，已存在 ${report.conversationsExisted}`);
    console.log(`  消息：单聊复制 ${report.singleCopied}，群聊复制 ${report.groupCopied}`);
    console.log(`  附件关联：${report.links}`);
    console.log(`  校验：旧表消息 ${srcSingle + srcGroup} 条 → 新表 ${tgt} 条；缺失 ${missing.length} 条`);
    if (missing.length) {
      console.log('  ⚠️ 存在缺失消息 ID：', missing.slice(0, 20).join(', '));
      process.exitCode = 1;
    } else {
      console.log('  ✓ 迁移完整，可重复执行（再次运行应显示复制 0 条）。');
    }
  } catch (err) {
    try { await conn.rollback(); } catch {}
    console.error('迁移失败：', err?.message || err);
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
}

main();
