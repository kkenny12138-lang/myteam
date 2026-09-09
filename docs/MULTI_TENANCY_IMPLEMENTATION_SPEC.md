# MyTeam 多租户实施说明：共享员工角色，隔离租户对话

## 1. 目标与边界

本次只实现“共享角色库 + 租户数据隔离”模式：平台现有的员工角色、员工档案、Agent、Skill 和组织模板由平台统一维护，任何已加入租户的用户都可以使用它们；不同租户之间绝不能看到、读取、写入或通过 Agent 上下文间接获得彼此的对话内容、附件、记忆、运行记录和产物。

这是共享数据库、共享 schema 的行级隔离方案，不为每个租户创建单独的数据库。

本期不包括：计费、配额、SSO、客户自行复制/编辑公共员工角色、独库部署。它们不应阻塞本期。

## 2. 数据归属模型

```text
平台共享（只读）
  employees / employee_profiles / agents / skills / agent_skills / org_nodes / tools
                                  │
                                  ├── Tenant A：会话、消息、附件、记忆、运行、产物
                                  └── Tenant B：会话、消息、附件、记忆、运行、产物
```

### 2.1 平台共享表：不加 `tenant_id`

| 表 | 原因 |
| --- | --- |
| `employees`、`employee_profiles` | 统一员工角色、人格和档案 |
| `agents`、`skills`、`agent_skills` | 统一 Agent 定义与能力库 |
| `org_nodes`、`tools` | 统一组织/工具模板 |

公共角色 API 必须为只读。现有修改公共配置的接口（如 `PUT /api/employees`、`/api/agents`、`/api/skills`）需限制为平台运维身份；普通租户管理员不能修改它们。

### 2.2 租户私有表：必须加 `tenant_id`

| 表 | 说明 |
| --- | --- |
| `conversations`、`conversation_messages`、`conversation_message_attachments` | 新会话与消息 |
| `attachments`、`message_attachments` | 文件及旧消息附件关联 |
| `messages`、`group_messages`、`chat_groups` | 旧聊天兼容数据；若不再开放，仍需隔离历史数据 |
| `agent_runs`、`agent_run_events`、`artifacts` | Agent 的运行轨迹和产物 |
| `memories` | 最关键：避免同一公共 Agent 把 A 租户信息带到 B 租户 |
| `settings`、`model_configs`、`decision_line` | 建议各租户独立模型和运行设置 |

`agent_skills` 不能以 `tenant_id` 隔离；它定义的是公共角色能力。未来客户需要定制时，新增 `tenant_agent_overrides`，不要复制所有 Agent 记录。

## 3. 身份、租户和权限

多租户的授权来源必须是服务端认证会话，不能是客户端传入的 `tenantId`。选择服务端 Session Cookie：Cookie 只存不透明 session token，数据库保存哈希后的 token。Cookie 使用 `HttpOnly; Secure; SameSite=Lax; Path=/`。

新增表：

```sql
CREATE TABLE tenants (
  id CHAR(26) PRIMARY KEY,
  slug VARCHAR(80) NOT NULL,
  name VARCHAR(120) NOT NULL,
  status ENUM('active', 'suspended') NOT NULL DEFAULT 'active',
  plan VARCHAR(30) NOT NULL DEFAULT 'free',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_tenants_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE users (
  id CHAR(26) PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  password_hash VARCHAR(255) NULL,
  status ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE tenant_members (
  tenant_id CHAR(26) NOT NULL,
  user_id CHAR(26) NOT NULL,
  role ENUM('owner', 'admin', 'member', 'viewer') NOT NULL DEFAULT 'member',
  status ENUM('active', 'invited', 'disabled') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, user_id),
  INDEX idx_tenant_members_user (user_id, tenant_id),
  CONSTRAINT fk_tm_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_tm_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE auth_sessions (
  id CHAR(26) PRIMARY KEY,
  user_id CHAR(26) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_auth_sessions_token_hash (token_hash),
  INDEX idx_auth_sessions_user (user_id, expires_at),
  CONSTRAINT fk_session_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

角色权限：

| 角色 | 权限 |
| --- | --- |
| `owner` | 租户删除、所有权转移、成员和全部配置管理 |
| `admin` | 成员管理、模型/设置管理、查看和使用全部租户资源 |
| `member` | 创建及使用租户会话、上传附件、执行公共 Agent |
| `viewer` | 仅可读取被允许的资源；第一期不允许创建会话 |

### 3.1 请求上下文

新增 `lib/auth/context.ts`（名称可调整），输出：

```ts
type TenantContext = {
  tenantId: string;
  tenantSlug: string;
  userId: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
};
```

所有私有 API 入口先调用 `requireTenantContext(request)`：

1. 验证 session cookie，失效时返回 `401 unauthenticated`。
2. 从请求 URL 的 `/api/t/:tenantSlug/...` 读取 slug。
3. 查询 `tenants + tenant_members`，确认成员是 `active`，否则返回 `403 tenant_access_denied`。
4. 按操作调用 `requireRole(context, 'member')` 或 `requireRole(context, 'admin')`。
5. 仅把这个上下文传入 repository / runtime；禁止由 body、query 或 header 覆盖 `tenantId`。

业务 API 统一迁到 `/api/t/[tenantSlug]/...`。例如：

```text
GET  /api/t/acme/v2/conversations
POST /api/t/acme/v2/conversations
GET  /api/t/acme/v2/conversations/{id}/messages
POST /api/t/acme/attachments
POST /api/t/acme/agent/runs
```

公共角色只读 API 可使用 `/api/public/...`，同样要求有效租户成员身份，避免匿名暴露内部角色配置。

## 4. 数据库迁移

迁移必须是独立、可重复执行的脚本，写入 `schema_migrations`；不要把大规模数据回填隐藏在应用启动的 `ensureSchema()` 中。

### 4.1 首次部署与历史数据

1. 创建 `tenants/users/tenant_members/auth_sessions`。
2. 创建一个历史默认租户，例如 `id=tenant_legacy`、`slug=default`、`name=默认团队`。
3. 将已有运维用户加入默认租户并授予 `owner`。
4. 为私有表补 `tenant_id`，先允许 `NULL`。
5. 对所有历史行执行 `UPDATE ... SET tenant_id = 'tenant_legacy' WHERE tenant_id IS NULL`。
6. 校验没有空值后设为 `NOT NULL`，创建索引。
7. 发布新 API 和 repository；确认没有旧 API 调用后再删除/下线旧接口。

示例（实际脚本应先用 `information_schema` 做幂等列/索引判断）：

```sql
ALTER TABLE conversations ADD COLUMN tenant_id CHAR(26) NULL AFTER id;
UPDATE conversations SET tenant_id = 'tenant_legacy' WHERE tenant_id IS NULL;
ALTER TABLE conversations MODIFY tenant_id CHAR(26) NOT NULL;
CREATE INDEX idx_conversations_tenant_updated ON conversations (tenant_id, updated_at, id);

ALTER TABLE conversation_messages ADD COLUMN tenant_id CHAR(26) NULL AFTER id;
UPDATE conversation_messages m
JOIN conversations c ON c.id = m.conversation_id
SET m.tenant_id = c.tenant_id
WHERE m.tenant_id IS NULL;
ALTER TABLE conversation_messages MODIFY tenant_id CHAR(26) NOT NULL;
CREATE INDEX idx_convmsg_tenant_conversation_seq
  ON conversation_messages (tenant_id, conversation_id, seq);
```

`settings` 现有主键为 `k`，不能直接插入多租户记录。改造为：

```sql
ALTER TABLE settings DROP PRIMARY KEY;
ALTER TABLE settings ADD COLUMN tenant_id CHAR(26) NOT NULL FIRST;
ALTER TABLE settings ADD PRIMARY KEY (tenant_id, k);
```

`model_configs` 现有主键为 `provider`，应改为 `(tenant_id, provider)`；历史环境变量模型密钥只能作为“未配置租户时的服务器回退”，不能让任意租户读取。

## 5. Repository 改造约束

所有私有 repository 函数强制接收 `TenantContext` 或最小的 `tenantId`。以下写法禁止保留：

```ts
getConversation(id)
listConversations()
getAttachment(id)
getAgentMemories(agentId)
```

替换为：

```ts
getConversation(tenantId, id)
listConversations(tenantId, options)
getAttachment(tenantId, id)
getAgentMemories(tenantId, agentId)
```

`lib/repositories/conversations.ts` 的最低改造要求：

- 创建会话时写入 `tenant_id`。
- `getConversation`、`getConversationByOwner`、`listConversations` 都使用 `WHERE tenant_id = ?`。
- `appendMessage` 开启事务后，以 `id + tenant_id` 锁定会话；新消息写入同一 `tenant_id`。
- `listMessages` 必须按 `tenant_id + conversation_id` 查询。
- 查询附件时将 `tenant_id` 传入，附件必须属于同租户和当前会话。

类似改造 `attachments.ts`、`memories.ts`、`runs.ts`、`model-configs.ts`。ID 是全局随机 ID 不能替代租户条件；每一个 `SELECT / UPDATE / DELETE` 都必须带租户条件。

## 6. Agent 运行时隔离

公共 `agentId` 可以在所有租户中使用，但运行时加载的数据必须是：

```text
公共 Agent 定义 + 公共 Skill
  + 当前 tenantId 下的 conversation
  + 当前 tenantId 下的 memory
  + 当前 tenantId 下的 model config
  + 当前 tenantId 下的 attachment / run / artifact
```

更新 `lib/agent/runtime.ts`、`context-builder.ts`、`executor.ts`，将 `tenantId` 作为显式输入向下传递。任何 Agent 工具（例如读取员工档案、会话或记忆）也必须接收同一上下文，不能按全局 ID 查询。

尤其应覆盖：

- `agent_runs` 的查询、取消、SSE events 均须验证租户；
- 生成产物时写入运行记录所属租户；
- 附件文件下载接口应使用 `getAttachmentBytes(tenantId, id)`；
- 聊天接口不能再直接信任 `employeeId/groupId/conversationId` 是否“可用”，而应先在当前租户范围验证它们。

## 7. 现有路由改造清单

优先迁移并在旧路径停用以下私有接口：

| 现有路径 | 迁移后的责任 |
| --- | --- |
| `/api/v2/conversations/*` | 租户会话、消息读写 |
| `/api/chat`、`/api/messages`、`/api/group-messages`、`/api/groups` | 兼容聊天数据，全部租户化；建议前端尽快只用 v2 |
| `/api/attachments/*` | 上传、元数据、下载、删除均租户验证 |
| `/api/agent/runs/*` | 运行、详情、SSE、取消均租户验证 |
| `/api/settings`、`/api/db`、`/api/decision-line` | 租户级设置，至少 admin |
| `/api/agents/*`、`/api/skills/*`、`/api/employees`、`/api/profiles`、`/api/org-nodes` | 改为公共只读；写操作仅平台运维 |

前端需新增：登录态处理、当前租户切换器、租户 slug 路由，以及 `401/403` 的明确提示。角色列表沿用当前数据源，不做复制。

## 8. 验收与安全测试

必须新增自动化测试，至少覆盖：

1. 租户 A 和 B 都能列出同一位公共员工角色。
2. A 创建的会话不出现在 B 的会话列表中。
3. B 使用 A 的 `conversationId` 请求消息、追加消息、取消 run、读取 SSE event，均得到 `404`（推荐，避免资源枚举）或 `403`。
4. B 使用 A 的附件 ID 下载、读取、删除，均失败且不返回文件名、类型、大小等元数据。
5. 同一公共 Agent 分别在 A/B 运行时，只加载各自的 memory；测试桩可断言 SQL 参数含正确 tenant ID。
6. `viewer` 无法创建会话，`member` 无法改模型配置，`admin` 无法删除租户，`owner` 可以管理成员。
7. 迁移脚本重复运行不产生重复默认租户、重复列、空 `tenant_id` 或数据丢失。

上线前用两个测试租户执行一次“猜测资源 ID”回归，覆盖会话、消息、附件、run、event、artifact 六类资源。

## 9. 建议交付顺序

1. 身份/租户/成员/Session 与 `TenantContext`。
2. 数据库迁移和历史数据回填。
3. 先改 v2 conversations、attachments、runs、memories；补跨租户测试。
4. 改 Agent runtime 的上下文链路和租户模型配置。
5. 迁移或下线旧聊天接口，收紧公共角色写接口。
6. 完成租户切换 UI、审计日志与上线回归。

只有第 3 和第 4 步完成后，才可以宣称实现了租户数据隔离；仅有租户表和前端切换器不构成安全隔离。
