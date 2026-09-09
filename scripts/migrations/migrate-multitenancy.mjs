/**
 * 多租户迁移（docs/MULTI_TENANCY_IMPLEMENTATION_SPEC.md §4）。
 *
 * 用法（项目根目录）：
 *   node --env-file-if-exists=.env scripts/migrations/migrate-multitenancy.mjs
 *
 * 特性：
 * - 独立、可重复执行；所有列/索引/主键操作先用 information_schema 判断（幂等）。
 * - 创建 tenants / users / tenant_members / auth_sessions。
 * - 创建默认历史租户 tenant_legacy（slug=default，name=默认团队）。
 * - 为私有表补 tenant_id：先加可空列 → 回填 → 校验无空值 → 改 NOT NULL → 加索引。
 * - settings 主键改为 (tenant_id, k)；model_configs 改为 (tenant_id, provider)；decision_line 改为 (tenant_id, id)。
 * - 通过 schema_migrations 记录，重复执行不重复创建、不丢数据。
 */
import mariadb from 'mariadb';
import { randomBytes, scryptSync } from 'node:crypto';

const REQUIRED = ['DB_HOST', 'DB_USER', 'DB_NAME'];
const DEFAULT_TENANT = { id: 'tenant_legacy', slug: 'default', name: '默认团队' };
const MIGRATION_NAME = 'multitenancy_v1';

const PRIVATE_TABLES = ['conversations', 'conversation_messages', 'conversation_message_attachments', 'attachments', 'message_attachments',
  'messages', 'group_messages', 'chat_groups', 'agent_runs', 'agent_run_events', 'artifacts', 'memories', 'settings', 'model_configs', 'decision_line'];

function config() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`缺少环境变量：${missing.join(', ')}（可用 --env-file-if-exists=.env 提供）`);
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

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

/* ---------------- 基础建表（幂等） ---------------- */
const CREATE_TABLES = [
  `CREATE TABLE IF NOT EXISTS tenants (
  id CHAR(26) PRIMARY KEY,
  slug VARCHAR(80) NOT NULL,
  name VARCHAR(120) NOT NULL,
  status ENUM('active', 'suspended') NOT NULL DEFAULT 'active',
  plan VARCHAR(30) NOT NULL DEFAULT 'free',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_tenants_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS users (
  id CHAR(26) PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  password_hash VARCHAR(255) NULL,
  status ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS tenant_members (
  tenant_id CHAR(26) NOT NULL,
  user_id CHAR(26) NOT NULL,
  role ENUM('owner', 'admin', 'member', 'viewer') NOT NULL DEFAULT 'member',
  status ENUM('active', 'invited', 'disabled') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, user_id),
  INDEX idx_tenant_members_user (user_id, tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS auth_sessions (
  id CHAR(26) PRIMARY KEY,
  user_id CHAR(26) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_auth_sessions_token_hash (token_hash),
  INDEX idx_auth_sessions_user (user_id, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
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
  INDEX idx_cma_attachment (attachment_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS attachments (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id CHAR(26) NOT NULL,
  owner_type VARCHAR(20) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  size_bytes BIGINT NOT NULL,
  category VARCHAR(30) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'uploading',
  data LONGBLOB NULL,
  extracted_text LONGTEXT NULL,
  extraction_meta JSON NULL,
  error_message TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_attachments_tenant (tenant_id, created_at),
  INDEX idx_attachment_owner (owner_type, owner_id),
  INDEX idx_attachment_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS message_attachments (
  tenant_id CHAR(26) NOT NULL,
  message_type VARCHAR(20) NOT NULL,
  message_id VARCHAR(64) NOT NULL,
  attachment_id VARCHAR(64) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (message_type, message_id, attachment_id),
  INDEX idx_ma_tenant (tenant_id),
  INDEX idx_ma_attachment (attachment_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS messages (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id CHAR(26) NOT NULL,
  employee_id VARCHAR(50) NOT NULL,
  sender VARCHAR(10) NOT NULL,
  text MEDIUMTEXT NOT NULL,
  time VARCHAR(30) NOT NULL DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_messages_tenant (tenant_id, created_at),
  INDEX idx_messages_employee (employee_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS group_messages (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id CHAR(26) NOT NULL,
  group_id VARCHAR(50) NOT NULL,
  sender VARCHAR(10) NOT NULL,
  sender_name VARCHAR(100) NOT NULL DEFAULT '',
  text MEDIUMTEXT NOT NULL,
  time VARCHAR(30) NOT NULL DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_group_messages_tenant (tenant_id, created_at),
  INDEX idx_group_messages (group_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS chat_groups (
  id VARCHAR(50) PRIMARY KEY,
  tenant_id CHAR(26) NOT NULL,
  name VARCHAR(100) NOT NULL,
  members MEDIUMTEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_chat_groups_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS agent_runs (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id CHAR(26) NOT NULL,
  parent_run_id VARCHAR(64) NULL,
  root_run_id VARCHAR(64) NOT NULL,
  conversation_id VARCHAR(64) NOT NULL,
  agent_id VARCHAR(64) NOT NULL,
  skill_id VARCHAR(64) NULL,
  status ENUM('queued','planning','running','waiting','succeeded','failed','cancelled') NOT NULL,
  input_text MEDIUMTEXT NOT NULL,
  output_text MEDIUMTEXT NULL,
  error_text MEDIUMTEXT NULL,
  model_name VARCHAR(100) NULL,
  prompt_tokens INT NOT NULL DEFAULT 0,
  completion_tokens INT NOT NULL DEFAULT 0,
  latency_ms INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMP NULL,
  INDEX idx_runs_tenant_created (tenant_id, created_at),
  INDEX idx_runs_root (root_run_id, created_at),
  INDEX idx_runs_conversation (conversation_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS agent_run_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  tenant_id CHAR(26) NOT NULL,
  run_id VARCHAR(64) NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  payload_json JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_run_events_tenant (tenant_id, id),
  INDEX idx_run_events (run_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS artifacts (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id CHAR(26) NOT NULL,
  run_id VARCHAR(64) NOT NULL,
  name VARCHAR(150) NOT NULL,
  mime_type VARCHAR(60) NOT NULL DEFAULT 'text/markdown',
  content LONGTEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_artifacts_tenant (tenant_id, created_at),
  INDEX idx_artifacts_run (run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS memories (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id CHAR(26) NOT NULL,
  agent_id VARCHAR(64) NOT NULL,
  kind ENUM('long_term','preference','task_context','summary') NOT NULL DEFAULT 'long_term',
  content MEDIUMTEXT NOT NULL,
  metadata_json JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_memories_tenant_agent (tenant_id, agent_id, created_at),
  INDEX idx_memories_agent (agent_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS settings (
  tenant_id CHAR(26) NOT NULL,
  k VARCHAR(50) NOT NULL,
  v VARCHAR(1000) NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, k)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS model_configs (
  tenant_id CHAR(26) NOT NULL,
  provider VARCHAR(30) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  model_name VARCHAR(100) NOT NULL,
  api_key_encrypted MEDIUMTEXT NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  image_input TINYINT(1) DEFAULT NULL,
  config_json JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, provider)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS decision_line (
  tenant_id CHAR(26) NOT NULL,
  id TINYINT NOT NULL DEFAULT 1,
  config MEDIUMTEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS schema_migrations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

/* ---------------- 信息 schema 辅助 ---------------- */
async function columnExists(conn, table, column) {
  const rows = await conn.query(
    'SELECT COUNT(*) AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column]
  );
  return Number(rows[0].c) > 0;
}

async function columnNullable(conn, table, column) {
  const rows = await conn.query(
    'SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column]
  );
  return rows[0]?.IS_NULLABLE === 'YES';
}

async function indexExists(conn, table, index) {
  const rows = await conn.query(
    'SELECT COUNT(*) AS c FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
    [table, index]
  );
  return Number(rows[0].c) > 0;
}

async function primaryKeyColumns(conn, table) {
  const rows = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'
     ORDER BY ORDINAL_POSITION`,
    [table]
  );
  return rows.map((r) => r.COLUMN_NAME);
}

/* ---------------- 列/索引迁移 ---------------- */
async function ensureTenantColumn(conn, table, backfillSql) {
  if (!(await columnExists(conn, table, 'tenant_id'))) {
    await conn.query(`ALTER TABLE ${table} ADD COLUMN tenant_id CHAR(26) NULL`);
  }
  await conn.query(backfillSql, [DEFAULT_TENANT.id]);
  if (await columnNullable(conn, table, 'tenant_id')) {
    // 校验：必须不存在空值，否则中断，避免把数据抹平
    const nulls = await conn.query(`SELECT COUNT(*) AS c FROM ${table} WHERE tenant_id IS NULL`);
    if (Number(nulls[0].c) > 0) {
      throw new Error(`表 ${table} 回填后仍有 ${nulls[0].c} 行 tenant_id 为空，已中止`);
    }
    await conn.query(`ALTER TABLE ${table} MODIFY tenant_id CHAR(26) NOT NULL`);
  }
}

async function ensureIndex(conn, table, index, definition) {
  if (!(await indexExists(conn, table, index))) {
    await conn.query(`ALTER TABLE ${table} ADD INDEX ${index} ${definition}`);
  }
}

async function ensurePrimaryKey(conn, table, cols) {
  const current = await primaryKeyColumns(conn, table);
  const sorted = (arr) => [...arr].sort();
  if (sorted(current).join(',') === sorted(cols).join(',')) return;
  await conn.query(`ALTER TABLE ${table} DROP PRIMARY KEY`);
  await conn.query(`ALTER TABLE ${table} ADD PRIMARY KEY (${cols.join(', ')})`);
}

/* ---------------- 主流程 ---------------- */
async function main() {
  const cfg = config();
  const pool = mariadb.createPool({ ...cfg, connectionLimit: 5, charset: 'utf8mb4', allowPublicKeyRetrieval: true });
  const conn = await pool.getConnection();
  const report = { tenant: { created: false, existed: false }, user: { created: false, existed: false }, tables: [], errors: [] };
  try {
    for (const stmt of CREATE_TABLES) await conn.query(stmt);

    await conn.beginTransaction();

    // 1. 默认历史租户
    const tenantRows = await conn.query('SELECT id FROM tenants WHERE id = ? OR slug = ? LIMIT 1', [DEFAULT_TENANT.id, DEFAULT_TENANT.slug]);
    if (tenantRows.length) {
      report.tenant.existed = true;
    } else {
      await conn.query('INSERT INTO tenants (id, slug, name, status, plan) VALUES (?, ?, ?, ?, ?)', [
        DEFAULT_TENANT.id, DEFAULT_TENANT.slug, DEFAULT_TENANT.name, 'active', 'free',
      ]);
      report.tenant.created = true;
    }

    // 2. 默认运维用户（owner 加入默认租户）
    const seedEmail = (process.env.SEED_ADMIN_EMAIL || 'admin@example.com').toLowerCase().trim();
    const seedPassword = process.env.SEED_ADMIN_PASSWORD || 'admin123456';
    let userId = 'user_admin';
    const userRows = await conn.query('SELECT id FROM users WHERE email = ? LIMIT 1', [seedEmail]);
    if (userRows.length) {
      userId = userRows[0].id;
      report.user.existed = true;
    } else {
      const existingId = await conn.query('SELECT id FROM users WHERE id = ? LIMIT 1', [userId]);
      if (existingId.length) userId = `u_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
      await conn.query(
        'INSERT INTO users (id, email, display_name, password_hash, status) VALUES (?, ?, ?, ?, ?)',
        [userId, seedEmail, '平台运维', hashPassword(seedPassword), 'active']
      );
      report.user.created = true;
    }
    await conn.query(
      `INSERT INTO tenant_members (tenant_id, user_id, role, status) VALUES (?, ?, 'owner', 'active')
       ON DUPLICATE KEY UPDATE status = 'active', role = IF(role = 'viewer', 'owner', role)`,
      [DEFAULT_TENANT.id, userId]
    );

    // 3. 私有表 tenant_id 回填 + NOT NULL
    const DEF = DEFAULT_TENANT.id;
    await ensureTenantColumn(conn, 'conversations', 'UPDATE conversations SET tenant_id = ? WHERE tenant_id IS NULL');
    await ensureTenantColumn(conn, 'conversation_messages',
      'UPDATE conversation_messages m LEFT JOIN conversations c ON c.id = m.conversation_id SET m.tenant_id = COALESCE(c.tenant_id, ?) WHERE m.tenant_id IS NULL');
    await ensureTenantColumn(conn, 'conversation_message_attachments',
      'UPDATE conversation_message_attachments cma LEFT JOIN conversation_messages cm ON cm.id = cma.message_id SET cma.tenant_id = COALESCE(cm.tenant_id, ?) WHERE cma.tenant_id IS NULL');
    await ensureTenantColumn(conn, 'attachments', 'UPDATE attachments SET tenant_id = ? WHERE tenant_id IS NULL');
    await ensureTenantColumn(conn, 'message_attachments',
      'UPDATE message_attachments ma LEFT JOIN attachments a ON a.id = ma.attachment_id SET ma.tenant_id = COALESCE(a.tenant_id, ?) WHERE ma.tenant_id IS NULL');
    await ensureTenantColumn(conn, 'messages', 'UPDATE messages SET tenant_id = ? WHERE tenant_id IS NULL');
    await ensureTenantColumn(conn, 'group_messages', 'UPDATE group_messages SET tenant_id = ? WHERE tenant_id IS NULL');
    await ensureTenantColumn(conn, 'chat_groups', 'UPDATE chat_groups SET tenant_id = ? WHERE tenant_id IS NULL');
    await ensureTenantColumn(conn, 'agent_runs', 'UPDATE agent_runs SET tenant_id = ? WHERE tenant_id IS NULL');
    await ensureTenantColumn(conn, 'agent_run_events',
      'UPDATE agent_run_events e LEFT JOIN agent_runs r ON r.id = e.run_id SET e.tenant_id = COALESCE(r.tenant_id, ?) WHERE e.tenant_id IS NULL');
    await ensureTenantColumn(conn, 'artifacts',
      'UPDATE artifacts a LEFT JOIN agent_runs r ON r.id = a.run_id SET a.tenant_id = COALESCE(r.tenant_id, ?) WHERE a.tenant_id IS NULL');
    await ensureTenantColumn(conn, 'memories', 'UPDATE memories SET tenant_id = ? WHERE tenant_id IS NULL');
    await ensureTenantColumn(conn, 'settings', 'UPDATE settings SET tenant_id = ? WHERE tenant_id IS NULL');
    await ensureTenantColumn(conn, 'model_configs', 'UPDATE model_configs SET tenant_id = ? WHERE tenant_id IS NULL');
    await ensureTenantColumn(conn, 'decision_line', 'UPDATE decision_line SET tenant_id = ? WHERE tenant_id IS NULL');

    // 4. 主键改造
    await ensurePrimaryKey(conn, 'settings', ['tenant_id', 'k']);
    await ensurePrimaryKey(conn, 'model_configs', ['tenant_id', 'provider']);
    await ensurePrimaryKey(conn, 'decision_line', ['tenant_id', 'id']);

    // 5. 索引
    await ensureIndex(conn, 'conversations', 'idx_conversations_tenant_updated', '(tenant_id, updated_at, id)');
    await ensureIndex(conn, 'conversation_messages', 'idx_convmsg_tenant_conversation_seq', '(tenant_id, conversation_id, seq)');
    await ensureIndex(conn, 'conversation_message_attachments', 'idx_cma_tenant', '(tenant_id)');
    await ensureIndex(conn, 'attachments', 'idx_attachments_tenant', '(tenant_id, created_at)');
    await ensureIndex(conn, 'message_attachments', 'idx_ma_tenant', '(tenant_id)');
    await ensureIndex(conn, 'messages', 'idx_messages_tenant', '(tenant_id, created_at)');
    await ensureIndex(conn, 'group_messages', 'idx_group_messages_tenant', '(tenant_id, created_at)');
    await ensureIndex(conn, 'chat_groups', 'idx_chat_groups_tenant', '(tenant_id)');
    await ensureIndex(conn, 'agent_runs', 'idx_runs_tenant_created', '(tenant_id, created_at)');
    await ensureIndex(conn, 'agent_run_events', 'idx_run_events_tenant', '(tenant_id, id)');
    await ensureIndex(conn, 'artifacts', 'idx_artifacts_tenant', '(tenant_id, created_at)');
    await ensureIndex(conn, 'memories', 'idx_memories_tenant_agent', '(tenant_id, agent_id, created_at)');

    await conn.query('INSERT IGNORE INTO schema_migrations (name) VALUES (?)', [MIGRATION_NAME]);
    await conn.commit();

    // 6. 校验（事务外只读）
    for (const t of PRIVATE_TABLES) {
      const nulls = await conn.query(`SELECT COUNT(*) AS c FROM ${t} WHERE tenant_id IS NULL`);
      if (Number(nulls[0].c) > 0) report.errors.push(`${t}: 仍有 ${nulls[0].c} 行空 tenant_id`);
      else report.tables.push(t);
    }
  } catch (error) {
    try { await conn.rollback(); } catch { /* ignore */ }
    throw error;
  } finally {
    conn.release();
    await pool.end();
  }

  console.log('');
  console.log('=== MyTeam 多租户迁移完成 ===');
  console.log(`  默认租户：${report.tenant.created ? '已创建' : '已存在'}（tenant_legacy / default / 默认团队）`);
  console.log(`  运维用户：${report.user.created ? '已创建' : '已存在'}（owner 加入默认租户）`);
  console.log(`  私有表 tenant_id 校验通过：${report.tables.length}/${PRIVATE_TABLES.length}`);
  if (report.errors.length) {
    console.log('  ⚠️ 校验失败：');
    for (const e of report.errors) console.log(`    - ${e}`);
    process.exitCode = 1;
  } else {
    console.log('  ✅ 所有私有表无空 tenant_id，主键与索引已就绪');
  }
}

main().catch((error) => {
  console.error('迁移失败：', error);
  process.exit(1);
});
