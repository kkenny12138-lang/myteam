# MyTeam Agent 化技术方案

> 适用当前项目：Next.js/Vinext + React + MySQL，模型接入 Kimi / DeepSeek。  
> 目标：平台本身是一个总控 Agent；每位员工是可独立调用的 Employee Agent；员工拥有自己的身份、优缺点、Skill、记忆和工具权限。

## 1. 当前现状与关键问题

当前项目已经具备员工档案、聊天、群聊、决策线和模型调用，但还不是完整 Agent 架构：

1. `employee_profiles.skills` 已是 `MEDIUMTEXT`，数据库容量不是当前瓶颈；前端使用单行 `<input>`，才是 Skill 描述不能方便输入长文的直接原因。
2. Skill 目前只是员工档案中的 `{ name, desc }` JSON，没有版本、状态、详细指令、输入输出规范和工具权限，不能作为可靠的可调用能力。
3. `/api/chat` 只接收姓名、岗位、部门，员工的 Skill、优点、缺点、不擅长事项均未进入 system prompt，档案只是“展示数据”。
4. 当前“决策线”依赖前端关键词匹配及模型在文本中输出 `@员工名`，没有结构化路由、任务状态、执行记录和失败恢复。
5. 浏览器直接把员工身份和历史一起提交给模型接口，服务端没有依据 `employeeId` 加载权威配置，容易产生配置不一致和越权注入。

因此，本次不能只改一个输入框。建议把“档案展示”“Agent 配置”“Skill 定义”“一次任务执行”拆成独立概念。

## 2. 产品概念

### 2.1 平台 Agent（Company Agent）

平台 Agent 是用户的统一入口，也是总控编排器，职责包括：

- 理解用户意图与交付物；
- 判断直接回答、追问，还是委派员工；
- 根据员工能力和 Skill 进行路由；
- 将大任务拆成子任务并选择串行或并行执行；
- 汇总多个员工的结果，处理冲突，向用户输出最终答案；
- 记录任务、调用链、Token、耗时、失败原因。

平台 Agent 不等于某位员工，也不建议继续用“指定调度者员工”来模拟平台。平台应有独立的 `agent` 记录，员工 Agent 是它可调用的下级 Agent。

### 2.2 员工 Agent（Employee Agent）

每位员工都由以下配置组成：

- 身份：姓名、岗位、部门、目标、职责边界；
- 人格：表达风格、价值偏好、协作方式；
- 能力：优点、缺点、擅长、不擅长、关键词；
- Skill：可执行的专业工作说明；
- 工具权限：能使用哪些 API、数据库或内部工具；
- 记忆：员工长期记忆、用户偏好、任务阶段上下文；
- 模型策略：默认模型、温度、最大输出、超时、成本上限。

“优点/缺点”不是装饰字段，应影响运行时行为。例如缺点是“信息不足时容易过早下结论”，运行时指令应转换为“关键事实不足时必须先询问或显式列出假设”。

### 2.3 Skill

Skill 是可复用、可版本化、可测试的能力说明，不只是标签。第一版建议采用 Markdown 长文本，不要一开始把 Skill 做成任意代码插件。

建议字段：

```ts
type Skill = {
  id: string;
  name: string;
  summary: string;          // 列表展示，建议 <= 200 字
  instructions: string;     // Markdown 长文本，核心执行说明
  inputSchema?: object;     // JSON Schema，可在第二阶段启用
  outputSchema?: object;
  examples?: Array<{ input: string; output: string }>;
  toolIds: string[];
  status: 'draft' | 'published' | 'disabled';
  version: number;
};
```

Skill 的 `instructions` 建议支持至少 50,000 字符；后端设置明确上限（例如 200,000 字符）防止误提交。运行时不能把全部长文无条件塞进上下文，只加载本次被选中的 Skill，并做 Token 预算。

## 3. 推荐总体架构

第一阶段保持当前单体应用，不引入微服务：

```text
React UI
   │ POST /api/agent/runs
   ▼
Agent API（鉴权、校验、SSE）
   ▼
Agent Runtime
   ├─ Context Builder（身份/优缺点/记忆/Skill）
   ├─ Planner/Router（决定直接答复或委派）
   ├─ Executor（调用员工 Agent / Tool）
   ├─ Guardrails（权限、循环、Token、超时）
   └─ Trace Writer（执行轨迹）
   │
   ├─────────────► Model Gateway（DeepSeek/Kimi 适配器）
   ├─────────────► Tool Registry（未来外部工具）
   └─────────────► MySQL（配置、任务、消息、记忆、轨迹）
```

建议自行实现一层轻量 Runtime，而不是立即使用 LangChain 一类重框架。当前场景只需要稳定的状态机、结构化输出、模型适配器和可观测性；以后工具和流程明显复杂时再评估 LangGraph 等编排框架。

## 4. 数据库设计

### 4.1 保留与调整

- 保留 `employees` 作为组织成员基础资料。
- 保留 `employee_profiles` 兼容旧页面，但将 `skills` 迁移到独立表。
- 消息表保留，后续增加 `conversation_id` / `run_id`，避免只按员工聚合。
- `decision_line` 在新路由稳定后标记废弃；迁移期可作为人工路由规则来源。

### 4.2 新表

```sql
CREATE TABLE agents (
  id VARCHAR(64) PRIMARY KEY,
  agent_type ENUM('company','employee') NOT NULL,
  employee_id VARCHAR(50) NULL,
  name VARCHAR(100) NOT NULL,
  system_instructions MEDIUMTEXT NOT NULL,
  model_provider VARCHAR(30) NOT NULL DEFAULT 'deepseek',
  model_name VARCHAR(100) NOT NULL,
  config_json JSON NULL,
  status ENUM('draft','active','disabled') NOT NULL DEFAULT 'draft',
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_agent_employee (employee_id)
);

CREATE TABLE skills (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  summary VARCHAR(500) NOT NULL DEFAULT '',
  instructions LONGTEXT NOT NULL,
  input_schema JSON NULL,
  output_schema JSON NULL,
  examples_json JSON NULL,
  status ENUM('draft','published','disabled') NOT NULL DEFAULT 'draft',
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE agent_skills (
  agent_id VARCHAR(64) NOT NULL,
  skill_id VARCHAR(64) NOT NULL,
  priority INT NOT NULL DEFAULT 100,
  custom_instructions MEDIUMTEXT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (agent_id, skill_id)
);

CREATE TABLE agent_runs (
  id VARCHAR(64) PRIMARY KEY,
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
  INDEX idx_runs_root (root_run_id, created_at),
  INDEX idx_runs_conversation (conversation_id, created_at)
);

CREATE TABLE agent_run_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  run_id VARCHAR(64) NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  payload_json JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_run_events (run_id, id)
);
```

第二阶段再增加 `tools`、`agent_tools`、`memories`、`artifacts`。不建议第一版就做向量库；员工/Skill 数量不大时，用 MySQL 全文或候选摘要 + 模型结构化选择足够。

### 4.3 迁移策略

1. 新建表，不删除旧字段。
2. 为每位现有员工创建一个 `employee` 类型 Agent；再创建唯一的 `company` Agent。
3. 将旧 `employee_profiles.skills[]` 每项迁移成独立 Skill；`desc` 写入 `instructions`，并建立 `agent_skills` 关联。
4. 双读：优先读新表，无新数据时读取旧 JSON。
5. 新功能稳定后停止写旧 `skills` 字段，最后再移除兼容代码。

迁移脚本必须幂等，建议建立 `schema_migrations` 表，不继续依赖应用启动时大量 `ALTER TABLE`。

## 5. Agent 运行时设计

### 5.1 入口协议

前端只提交权威 ID，不再提交可伪造的完整员工配置：

```json
POST /api/agent/runs
{
  "conversationId": "conv_xxx",
  "agentId": "company",
  "message": "帮我分析下季度增长方案",
  "mode": "deep"
}
```

服务端根据 `agentId` 加载 Agent、员工档案、已发布 Skill、模型策略和权限。响应第一版可同步 JSON，建议直接做 SSE，以便输出 `planning`、`delegated`、`token`、`completed` 等事件。

### 5.2 Company Agent 状态机

```text
RECEIVE
  → LOAD_CONTEXT
  → PLAN
      ├─ ASK_USER → WAITING
      ├─ DIRECT_ANSWER → SYNTHESIZE
      └─ DELEGATE → EXECUTE_CHILD_RUNS → SYNTHESIZE
  → SAVE_TRACE
  → COMPLETE / FAIL
```

规划器必须要求模型返回结构化 JSON，并做服务端校验：

```ts
type Plan = {
  action: 'answer' | 'ask' | 'delegate';
  reason: string;
  assignments: Array<{
    agentId: string;
    skillId?: string;
    task: string;
    dependsOn: string[];
  }>;
};
```

不要以解析自然语言里的 `@姓名` 作为真正的调度机制。`@姓名` 只用于 UI 展示，调度以 `agentId` 和结构化 Plan 为准。

### 5.3 员工选择

推荐混合路由：

1. 硬规则过滤：仅选择启用的 Agent、已发布 Skill、权限允许者。
2. 候选召回：按员工关键词、Skill 名称/摘要、部门做 MySQL 检索，取前 5～10 名。
3. 模型选择：让平台 Agent 从候选集中按 ID 返回 0～3 位员工及理由。
4. 低置信度或存在关键歧义时向用户追问。

这样比纯关键词可靠，也比每次把所有员工的完整 Skill 全塞入 prompt 更省 Token。

### 5.4 Prompt 组装顺序

员工 Agent 的 system prompt 由服务端按固定模板生成：

1. 平台安全规则与输出规则；
2. 员工身份、职责和目标；
3. 优点如何发挥；
4. 缺点/不擅长事项对应的行为约束；
5. 本次选中的 Skill 指令（只选相关项）；
6. 可用工具和权限；
7. 任务上下文与必要记忆；
8. 用户消息。

任何用户输入、历史消息、Skill 示例都应使用明确分隔符，禁止它们覆盖平台级规则。

### 5.5 执行保护

- 单次根任务最多委派 5 个子任务；
- 最大递归深度 2（平台 → 员工 → 工具），员工第一版不能再任意调用其他员工；
- 同一 Agent 同一任务禁止重复调用；
- 每次调用有 Token、耗时、重试次数上限；
- 失败只重试可重试错误，最多 1～2 次；
- 涉及外部写操作、发送消息、删除数据时必须进入确认状态；
- 所有模型选择和工具调用写入 `agent_run_events`。

## 6. “Skill 能写很多字”的具体改造

### 6.1 前端

将当前 Skill 新增区的描述 `<input>` 攓为受控 `<textarea>`：

- 默认 8～12 行，可自动增高；
- 支持 Markdown；
- 显示字符数与建议 Token 数；
- 支持编辑已有 Skill，而不只是删除重建；
- 列表仅显示 `summary` 和长文前 3～5 行，点击展开完整内容；
- 离开未保存时提示；
- 超过后端上限时前后端同时拦截。

推荐独立路由 `/skills/[skillId]` 做完整编辑器，员工详情只负责绑定/解绑 Skill。这样同一个 Skill 可以被多个员工复用。

### 6.2 后端

- `instructions` 使用 `LONGTEXT`；API 验证字符串类型和长度；
- Skill 使用单条 CRUD：`POST /api/skills`、`PATCH /api/skills/:id`，不要再整体替换所有 profiles；
- 更新采用乐观锁：请求携带 `version`，SQL 使用 `WHERE id=? AND version=?`；
- 发布前校验名称、指令、状态及引用工具；
- 生产环境保存时做权限校验、审计和频率限制。

## 7. 建议代码结构

```text
app/api/agent/runs/route.ts
app/api/agent/runs/[id]/events/route.ts
app/api/agents/route.ts
app/api/agents/[id]/route.ts
app/api/skills/route.ts
app/api/skills/[id]/route.ts

lib/agent/runtime.ts
lib/agent/planner.ts
lib/agent/executor.ts
lib/agent/context-builder.ts
lib/agent/prompt-builder.ts
lib/agent/types.ts
lib/agent/validators.ts
lib/models/gateway.ts
lib/models/deepseek.ts
lib/models/kimi.ts
lib/repositories/agents.ts
lib/repositories/skills.ts
lib/repositories/runs.ts
```

模型差异只能存在于 `lib/models/*`。业务层统一调用 `gateway.generate()` / `gateway.generateObject()`，不要在路由里直接拼供应商请求体。

## 8. API 最小集合

- `GET/POST /api/agents`：Agent 列表/创建；
- `GET/PATCH /api/agents/:id`：配置与版本更新；
- `GET/POST /api/skills`：Skill 列表/创建；
- `GET/PATCH /api/skills/:id`：长文本编辑；
- `PUT/DELETE /api/agents/:id/skills/:skillId`：绑定/解绑；
- `POST /api/agent/runs`：启动一次 Agent 任务；
- `GET /api/agent/runs/:id`：运行状态与最终结果；
- `GET /api/agent/runs/:id/events`：SSE 执行事件；
- `POST /api/agent/runs/:id/cancel`：取消任务。

所有 API 使用统一错误结构：`{ code, message, details?, requestId }`，并对请求体做运行时校验（建议 Zod）。

## 9. 分阶段开发计划

### Phase 0：长文本与当前调用修正（1～2 天）

- Skill 描述改为 textarea，支持编辑、展开和长度校验；
- `/api/chat` 改为接收 `employeeId`，服务端读取员工档案；
- 把相关 Skill、优点、缺点、不擅长项加入员工 system prompt；
- 增加 prompt 长度控制与单元测试。

验收：修改员工 Skill 后，新对话中该员工的回答能稳定体现这项 Skill；浏览器不能通过伪造姓名改变 Agent 身份。

### Phase 1：真正的 Agent 内核（3～5 天）

- 新增 `agents`、`skills`、`agent_skills`、`agent_runs`、`agent_run_events`；
- 完成旧数据幂等迁移；
- 抽离 Model Gateway、Context Builder、Prompt Builder；
- 单员工对话全部切到 `POST /api/agent/runs`；
- 增加运行轨迹、超时、Token 上限和错误处理。

验收：每次回答可追溯使用了哪个 Agent、哪个 Skill、哪个模型、消耗多少 Token。

### Phase 2：平台 Agent 与多员工协作（4～7 天）

- Company Agent 独立配置；
- 结构化 Planner 和候选员工召回；
- 子任务串/并行、依赖关系、结果汇总；
- 群聊和决策线迁移到结构化运行；
- UI 展示“正在规划 → 已委派 → 正在汇总”。

验收：复杂任务能够委派给 1～3 位员工；部分员工失败时平台能说明失败并汇总已有结果；不会无限互相调用。

### Phase 3：工具与记忆（按业务需要）

- 工具注册、输入 Schema、权限、确认机制；
- 对话摘要与员工长期记忆；
- Skill 版本发布、回滚、测试用例和效果评估；
- 管理台查看成功率、成本、延迟和调用链。

## 10. 测试与验收

至少覆盖：

- 50,000 字符 Skill 的保存、读取、编辑与中文兼容；
- 超长输入返回明确 4xx，不拖垮模型请求；
- 未发布/禁用 Skill 不进入 prompt；
- 优点、缺点和 Skill 的 prompt 组装快照测试；
- 模型返回非法 Plan、未知 Agent ID 时安全失败；
- 子任务超时、部分失败、取消和幂等重试；
- 同一请求不会产生重复子任务；
- Prompt injection 不能修改 Agent 身份或提升工具权限；
- MySQL 事务失败时不留下半套 Agent/Skill 关系；
- 旧档案迁移前后数据数量与内容一致。

## 11. 给 DS V4.0 的实施约束

可以按 Phase 0 → Phase 1 → Phase 2 逐阶段交给 DS V4.0。每阶段都要求：

1. 先阅读本文和现有 `app/api/chat/route.ts`、`app/api/profiles/route.ts`、`lib/db.ts`、`app/im-page.tsx`。
2. 不删除现有用户数据，不做破坏性数据库迁移；迁移必须幂等并可重复运行。
3. 不把 Agent 配置交给前端作为可信输入；由服务端按 ID 读取。
4. 不使用自然语言 `@名字` 作为后端调度协议，必须使用结构化 ID。
5. 不把所有 Skill 全量塞入每次 prompt，必须先选择相关 Skill 并执行 Token 预算。
6. 新增运行时校验、自动化测试、错误日志；每个阶段通过测试后再进入下一阶段。
7. 保持 Kimi/DeepSeek 双提供商兼容，模型专有字段只放在各自 Adapter。

建议给 DS V4.0 的第一条开发任务：

> 实施 Phase 0。先将员工 Skill 描述改造成可编辑的 Markdown 长文本 textarea（至少支持 50,000 字符），补齐前后端长度校验；然后将聊天请求从提交员工资料改为只提交 employeeId，由服务端读取 Employee、EmployeeProfile，并将相关 Skill、优点、缺点、不擅长事项安全组装进 system prompt。保持现有 UI、数据库数据和 Kimi/DeepSeek 功能兼容，补充关键测试，完成后列出修改文件、迁移影响和测试结果。

## 12. 最终建议

最合适的路线不是把“每个员工都换成一个聊天 prompt”，而是建立五个清晰层次：

```text
平台 Agent（理解、规划、汇总）
  → 员工 Agent（身份、边界、行为）
    → Skill（怎么完成某类任务）
      → Tool（真正读取或改变外部世界）
        → Run/Trace（全过程可追踪、可恢复、可审计）
```

这套分层可以沿用当前产品外观和技术栈，但会把现有“角色聊天”升级为真正可调度、可执行、可治理的 Agent 平台。
