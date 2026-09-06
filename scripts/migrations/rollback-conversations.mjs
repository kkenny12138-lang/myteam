/**
 * 回滚命令：仅删除 S0 迁移新增的三张表与迁移标记，旧表数据绝不触碰。
 *
 * 用法：
 *   node --env-file-if-exists=.env scripts/migrations/rollback-conversations.mjs
 * 或：
 *   npm run migrate:conversations:rollback
 *
 * 回滚后旧接口（/api/messages、/api/group-messages）不受影响，可继续使用旧数据。
 */
import mariadb from 'mariadb';

const REQUIRED = ['DB_HOST', 'DB_USER', 'DB_NAME'];

function config() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`缺少环境变量：${missing.join(', ')}`);
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

async function main() {
  const cfg = config();
  const pool = mariadb.createPool({ ...cfg, connectionLimit: 5, charset: 'utf8mb4', allowPublicKeyRetrieval: true });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM conversation_message_attachments');
    await conn.query('DELETE FROM conversation_messages');
    await conn.query('DELETE FROM conversations');
    await conn.query("DELETE FROM schema_migrations WHERE name = 'conversation_bootstrap_v1'");
    await conn.commit();
    console.log('');
    console.log('=== 会话迁移已回滚 ===');
    console.log('  已清空 conversations / conversation_messages / conversation_message_attachments 及迁移标记。');
    console.log('  旧表 messages / group_messages / message_attachments 未被修改，可继续使用旧接口。');
  } catch (err) {
    try { await conn.rollback(); } catch {}
    console.error('回滚失败：', err?.message || err);
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
}

main();
