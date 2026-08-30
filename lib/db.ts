import mariadb from 'mariadb';

/**
 * MySQL / MariaDB 连接模块。
 * 通过环境变量配置（见 .env.example）：
 *   DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
 * 未配置时所有操作都安全降级为“本地模式”（前端继续使用 localStorage）。
 *
 * 说明：使用 `mariadb` 驱动（纯 JS，不依赖 new Function），因此
 * 既能在生产 Node 服务器（vinext start / Docker）运行，
 * 也能在 vinext dev 的 Miniflare(Workers) 沙箱里运行。
 */

export type DbStatus = { configured: boolean; connected: boolean };

let pool: mariadb.Pool | null = null;
let schemaReady: Promise<void> | null = null;

export function isDbConfigured(): boolean {
  return Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME);
}

export function getPool(): mariadb.Pool {
  if (!isDbConfigured()) {
    throw new Error('数据库未配置：缺少 DB_HOST / DB_USER / DB_NAME 环境变量');
  }
  if (!pool) {
    pool = mariadb.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME,
      connectionLimit: 10,
      connectTimeout: 5000,
      charset: 'utf8mb4',
      // Required for MySQL 8's default caching_sha2_password authentication
      // when the database is reached over the private Docker network.
      allowPublicKeyRetrieval: true,
    });
  }
  return pool;
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS employees (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  role VARCHAR(200) NOT NULL,
  department VARCHAR(100) NOT NULL,
  initials VARCHAR(10) NOT NULL,
  color VARCHAR(20) NOT NULL,
  online TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS messages (
  id VARCHAR(64) PRIMARY KEY,
  employee_id VARCHAR(50) NOT NULL,
  sender VARCHAR(10) NOT NULL,
  text MEDIUMTEXT NOT NULL,
  time VARCHAR(30) NOT NULL DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_messages_employee (employee_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS settings (
  k VARCHAR(50) PRIMARY KEY,
  v VARCHAR(1000) NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS employee_profiles (
  employee_id VARCHAR(50) PRIMARY KEY,
  summary MEDIUMTEXT NOT NULL,
  traits MEDIUMTEXT,
  expertise VARCHAR(500) NOT NULL DEFAULT '',
  strengths MEDIUMTEXT,
  weaknesses MEDIUMTEXT,
  best_for MEDIUMTEXT,
  skills MEDIUMTEXT,
  nationality VARCHAR(100) NOT NULL DEFAULT '',
  age INT DEFAULT NULL,
  keywords MEDIUMTEXT,
  not_good_at MEDIUMTEXT,
  career MEDIUMTEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS org_nodes (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description MEDIUMTEXT NOT NULL,
  parent_id VARCHAR(50) DEFAULT NULL,
  department VARCHAR(100) DEFAULT NULL,
  sort_order INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS decision_line (
  id TINYINT PRIMARY KEY DEFAULT 1,
  config MEDIUMTEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS chat_groups (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  members MEDIUMTEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS group_messages (
  id VARCHAR(64) PRIMARY KEY,
  group_id VARCHAR(50) NOT NULL,
  sender VARCHAR(10) NOT NULL,
  sender_name VARCHAR(100) NOT NULL DEFAULT '',
  text MEDIUMTEXT NOT NULL,
  time VARCHAR(30) NOT NULL DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_group_messages (group_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

/** 幂等地创建/补齐数据表，每个进程只执行一次。 */
export function ensureSchema(): Promise<void> {
  if (!isDbConfigured()) return Promise.resolve();
  if (!schemaReady) {
    schemaReady = (async () => {
      const connection = await getPool().getConnection();
      try {
        for (const statement of SCHEMA_STATEMENTS) {
          await connection.query(statement);
        }
        // 兼容旧库：给消息表补 tokens 列（MySQL8 不支持 ADD COLUMN IF NOT EXISTS，先查 information_schema）
        const ensureColumn = async (table: string, column: string, definition: string) => {
          const rows = await connection.query('SELECT COUNT(*) AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [table, column]) as Array<{ c: number }>;
          if (!rows[0]?.c) await connection.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        };
        await ensureColumn('messages', 'tokens', 'INT NOT NULL DEFAULT 0');
        await ensureColumn('group_messages', 'tokens', 'INT NOT NULL DEFAULT 0');
        // 兼容旧库：给员工档案表补 国籍/年龄/关键词/不擅长/履历 列
        await ensureColumn('employee_profiles', 'nationality', "VARCHAR(100) NOT NULL DEFAULT ''");
        await ensureColumn('employee_profiles', 'age', 'INT DEFAULT NULL');
        await ensureColumn('employee_profiles', 'keywords', 'MEDIUMTEXT');
        await ensureColumn('employee_profiles', 'not_good_at', 'MEDIUMTEXT');
        await ensureColumn('employee_profiles', 'career', 'MEDIUMTEXT');
      } finally {
        connection.release();
      }
    })().catch((error) => {
      schemaReady = null; // 允许下次重试
      throw error;
    });
  }
  return schemaReady;
}

/** 数据库健康检查：是否已配置、是否可连接。 */
export async function dbHealth(): Promise<DbStatus> {
  if (!isDbConfigured()) return { configured: false, connected: false };
  try {
    await ensureSchema();
    await getPool().query('SELECT 1');
    return { configured: true, connected: true };
  } catch {
    return { configured: true, connected: false };
  }
}
