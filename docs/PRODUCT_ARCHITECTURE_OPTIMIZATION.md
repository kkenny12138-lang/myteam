# MyTeam 产品架构优化审计与实施优先级

> 基于当前代码审计，不改变现有核心交互。本文重点不是重写，而是收口已经存在的新旧架构，并优先修复影响回答质量、Token 成本和数据安全的问题。

## 1. 当前阶段判断

项目已经不只是旧版角色聊天：代码中已有 `agents`、`skills`、`tools`、`memories`、`agent_runs`、Runtime、Planner、Executor、Model Gateway 和 SSE 事件接口。这说明 Agent 化的主方向正确。

目前主要问题是“新内核已经搭起，但旧链路和若干临时实现尚未收口”：

- `/api/chat` 与 `/api/agent/runs` 两套执行链路并存；
- 前端仍以旧聊天同步方式为主；
- 新 Runtime 仍固定携带最近 20 条历史；
- Context Builder 加载全部 Skill 和记忆，没有预算器；
- 多 Agent 汇总仍传递员工完整输出；
- 旧数据整体替换、localStorage 和服务端 Agent 数据三套模式并存；
- 暂未看到用户、租户、鉴权和资源归属边界。

优化策略应是：先修正确性与安全，再省 Token，再完成新旧链路收口，最后扩展工具和多租户。

## 2. P0：必须立即修复

### 2.1 修复旧 Skill 解析

`lib/agent/context-builder.ts` 当前使用 `parseList(r.skills)`。`parseList` 会对数组元素执行 `String()`；当旧 `skills` 是对象数组时会得到 `[object Object]`，后续 `JSON.parse` 失败，导致旧 Skill 内容丢失。

要求：

- 为旧 `skills` 单独实现 `parseLegacySkills()`；
- 直接解析 JSON 数组并验证 `{ name, desc }`；
- 增加对象数组、字符串数组、非法 JSON、空值测试；
- 迁移完成后以新 `skills` 表为主，旧字段仅作兼容。

### 2.2 Skill 必须真正按 `skillId` 选择

当前 Planner/Run 可以携带 `skillId`，但 `executeSingle()` 加载上下文时仍将员工全部已发布 Skill 传入 `buildSystemPrompt()`。

要求：

- 指定 `skillId` 时，只允许加载该员工已绑定、启用、已发布的 Skill；
- 未指定时调用 Skill Retriever，默认选择 0～1 个；
- deep 模式最多 2 个；
- 无匹配时不加载 Skill 全文；
- 未绑定、禁用或不存在的 Skill 返回结构化错误，不可静默加载其他 Skill；
- Run Event 记录候选、命中分数、最终 Skill 和加载 Token。

### 2.3 引入 Context Budgeter，删除固定 `slice(-20)`

当前以下位置仍固定截取历史：

- `app/api/chat/route.ts`；
- `app/api/agent/runs/route.ts`；
- `lib/agent/executor.ts`；
- Company Agent direct answer 分支。

要求所有模型调用统一经过预算器，禁止 Route/Runtime/Executor 自行截取历史。

默认值：

```text
fast：输入 6,000，输出 1,200
deep：输入 16,000，输出 4,000
最近原文：4～8 条，但最终以 Token 预算为准
```

### 2.4 修复并行 Token 统计竞争

多员工并行执行中，多个 Promise 会同时读写外部变量 `execUsage`。应让 `runOne()` 返回独立结果，再在 `Promise.all()` 完成后通过纯函数 `reduce(addUsage)` 汇总。

同样应避免并行函数直接 `push` 到共享 `subResults`，改为返回值并按照 assignment 顺序合并，保证结果顺序稳定。

### 2.5 不允许 draft Agent 执行生产任务

当前 `executeSingle()` 允许 `active` 和 `draft` 执行，而根入口只拒绝 `disabled`。生产运行应只允许 `active`；草稿 Agent 只能通过明确的预览/测试接口运行，并标记 `preview=true`。

### 2.6 服务端错误不能泄露内部信息

当前统一错误体对未知异常直接返回 `error.message`，可能泄露 SQL、供应商或内部配置信息。

要求：

- 服务端日志记录完整错误和 `requestId`；
- 客户端未知 500 只返回“服务暂时不可用”；
- 已知 `ApiError` 才返回可公开 message；
- API Key、SQL、Prompt、连接信息不可进入客户端错误体。

## 3. P1：效果与成本优化

### 3.1 员工运行身份卡

完整档案只用于管理页面；模型每次只读取 300～800 Token 的 `runtimeProfile`：

```ts
{
  identity,
  responsibilities,
  behaviorRules,
  boundaries,
  routingKeywords
}
```

履历、国籍、年龄等信息只有在当前任务相关时才加载。

### 3.2 记忆按相关性召回

当前默认读取最近 20 条 Memory，并可能全部进入 Prompt。改为：

- 先按 `agentId + conversationId/user scope` 做权限过滤；
- 关键词/标签/时间衰减召回候选；
- 默认加载 3～5 条；
- 设置记忆总预算，例如 600 Token；
- 记忆必须包含来源、更新时间、置信度和过期策略；
- 用户可以查看、修正和删除长期记忆。

数据量较小时不必先引入向量数据库，MySQL 关键词和标签足够。

### 3.3 滚动摘要与结构化任务状态

新增 `conversation_contexts`：

- `summary`：旧对话摘要；
- `task_state`：目标、事实、约束、决定、待确认项、已完成工作；
- `summary_through_message_id`：摘要覆盖边界；
- `version`：并发更新控制。

当未摘要历史超过阈值或完成阶段时再总结，不能每轮总结。

### 3.4 Company Agent 快速通道

当前 Company Agent 每次先调用 Planner；即使计划是 `answer`，随后还会再调用一次模型生成答案。简单请求因此至少消耗两次模型调用。

优化顺序：

1. 明确员工单聊：直达员工；
2. 明确 `@员工`：纯代码路由；
3. 唯一高置信度关键词/Skill：纯代码路由；
4. 问候、确认、简短追问：Company Agent 单次直接回答；
5. 只有歧义或跨领域复杂任务才调用 Planner。

Planner 若返回完整 `draftAnswer`，可按配置直接使用，避免无必要的第二次生成；需要高质量润色时才执行 synthesize。

### 3.5 多 Agent 使用 handoff，而不是全文汇总

当前 Runtime 将每位员工完整回答拼接，并截到 20,000 字交给汇总模型。改为员工同时返回：

```ts
{
  displayText,
  handoffSummary,
  keyFacts,
  risks,
  recommendations
}
```

汇总默认只读取 handoff 字段；发现冲突时再按需读取完整结果。

### 3.6 降低默认委派数量

当前默认最多 5 位员工。建议：

- fast：1 位；
- deep：默认 2 位、硬上限 3 位；
- 5 位只允许显式高级配置；
- 每次根任务设置总 Token、总耗时和总模型调用次数上限。

## 4. P1：数据与接口收口

### 4.1 新执行链路成为唯一权威入口

目标：前端聊天最终只调用 `/api/agent/runs`。

迁移期间：

- `/api/chat` 内部转发至 Agent Runtime，不再保留独立 Prompt 拼装；
- 对比新旧返回结果和 usage；
- 全量切换后删除旧业务实现，仅保留兼容适配器；
- Model Provider 调用只允许经过 `lib/models/gateway.ts`。

### 4.2 停止整体替换资源

当前 employees、profiles、groups、messages、org_nodes 仍存在先 `DELETE` 再整体插入的写法。这在多用户或多页面并发时容易覆盖数据。

逐步改成：

- `POST` 创建；
- `PATCH /:id` 局部更新；
- `DELETE /:id` 精确删除；
- `version` 或 `updated_at` 乐观锁；
- 批量排序使用专用 reorder API；
- 数据关系建立外键或至少应用级引用校验。

### 4.3 明确服务端为唯一数据源

正式模式不要在数据库失败后继续把 localStorage 当可写主库，否则会形成数据分叉。

建议：

- Demo 模式：明确显示“本地演示”；
- Production 模式：服务端数据库为唯一权威；
- 数据库不可用：保留只读缓存或明确报错；
- 禁止本地旧数据自动覆盖云端已有数据；
- 提供显式导入，而不是启动时自动全量同步。

## 5. P0/P1：安全和商业化基础

如果产品只在个人本地使用，可以稍后做；只要准备让多位用户使用，就必须优先完成：

- 登录与 Session；
- `tenant_id/workspace_id/user_id`；
- Agent、Skill、Conversation、Run、Memory 的资源归属；
- 每个 API 的读取和写入权限；
- 模型调用限流与并发限制；
- 每用户/租户成本配额；
- 外部 Tool 的独立授权、写操作确认和审计；
- CSRF/Origin、防滥用和请求大小限制；
- 敏感字段加密或密钥托管。

当前无资源归属字段时，所有记录本质上是全局共享，不能安全支持 SaaS 多用户。

## 6. P2：代码可维护性

### 6.1 拆分前端，但不改变交互

`app/im-page.tsx` 继续增大后维护风险高。按功能渐进拆分：

```text
features/chat/
features/agents/
features/skills/
features/groups/
features/organization/
features/runs/
```

先抽数据 hooks 和 API client，再抽大型 Modal/Panel；每次只做小范围无行为变化重构。

### 6.2 迁移不要放在用户请求路径

`POST /api/agent/runs` 每次都会调用 `migrateToAgentPlatform()`。即使内部幂等，也不应长期放在高频执行路径。

改为：

- 部署/启动阶段运行迁移；
- 使用独立 migration command；
- API 只检查 schema version，不执行结构和数据迁移；
- schema 未就绪时返回明确运维错误。

### 6.3 结构化日志与指标

每次 Run 至少记录：

- requestId/runId/rootRunId；
- routeType；
- selectedAgent/Skill；
- 上下文各分区 Token；
- 模型调用类型（route/plan/execute/summarize/synthesize）；
- prompt/completion/cached Token；
- 延迟、重试、错误分类；
- 估算成本。

重点看板：成功率、P50/P95 延迟、平均 Token、单任务成本、Planner 命中率、无 Skill 命中率、摘要失败率。

## 7. 推荐实施顺序

### Sprint 1：正确性和安全（必须先做）

1. 修复旧 Skill 解析；
2. `skillId` 真正限制 Skill 加载；
3. draft Agent 禁止生产执行；
4. 修复并行结果/Token 共享状态；
5. 500 错误脱敏；
6. 为以上内容补自动化测试。

### Sprint 2：Token 预算

1. Context Budgeter；
2. runtime profile；
3. Skill 0～1 个按需加载；
4. 记忆预算与相关性召回；
5. usage 分区统计；
6. 使用固定基准集做优化前后对比。

### Sprint 3：长对话与快速通道

1. conversation summary；
2. task state；
3. Company Agent 快速通道；
4. 降低默认委派数量；
5. 多 Agent handoff 协议。

### Sprint 4：新旧收口

1. 前端全面切换 Agent Runs；
2. `/api/chat` 变成兼容适配器；
3. 资源级 CRUD 替换整体覆盖；
4. 正式环境取消 localStorage 自动回写；
5. 迁移退出请求路径。

### Sprint 5：上线基础

1. 用户、租户和权限；
2. 限流、配额、成本控制；
3. Tool 授权和人工确认；
4. 审计日志、告警与运营看板。

## 8. 给 DS 的下一条开发任务

```text
请阅读 docs/PRODUCT_ARCHITECTURE_OPTIMIZATION.md，先只实施 Sprint 1，不改变现有前端布局和用户交互。

重点完成：
1. 修复 lib/agent/context-builder.ts 对旧 employee_profiles.skills 对象数组的解析；
2. 让 executeSingle 真正按传入 skillId 只加载已绑定、启用、published 的对应 Skill；未指定 skillId 时暂不加载全部 Skill；
3. 生产运行只允许 active Agent，draft 只能通过明确 preview 模式；
4. 重构多 Agent 并行执行，使每个 Promise 返回独立结果，完成后再确定性汇总 usage 和结果，禁止并发修改共享数组/usage；
5. 未知 500 错误对客户端脱敏，完整错误只写服务端日志并带 requestId；
6. 补充旧 Skill 解析、Skill 权限、draft Agent、并行 usage、错误脱敏测试；
7. 不实施 UI 重构、不删除旧 API、不修改现有核心交互。

完成后报告修改文件、测试结果、兼容性影响和仍待处理的问题。Sprint 1 验收通过后再做 Context Budgeter。
```

## 9. 最终原则

当前最优选择不是再增加更多 Agent 功能，而是让已经存在的 Agent Runtime 成为唯一、正确、可控的执行内核。先保证“选对员工、只加载正确 Skill、上下文不失控、运行可追踪、数据不互相覆盖”，再增加工具和更复杂协作。
