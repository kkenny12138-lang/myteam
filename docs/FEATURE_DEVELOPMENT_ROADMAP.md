# MyTeam 功能优化开发文档

版本：v1.0  
日期：2026-09-05  
状态：开发方案，尚未实施  
适用范围：当前 MyTeam 单体应用、AI 员工、单聊、群聊和 Agent Runtime。

## 1. 目标与使用说明

本轮目标是让用户能够观察任务进展、复用专业能力、沉淀项目知识和交付物，并逐步支持模板化、定时化工作。

本文可用于需求评审、任务拆分和逐阶段实施。所有新增接口、字段、默认阈值和性能目标均为建议设计，不代表当前代码已经实现或实测达到。工期为粗估，不是交付承诺。

配套文档：

- [架构优化审计](./PRODUCT_ARCHITECTURE_OPTIMIZATION.md)：既有架构问题与修复思路。
- [Agent 平台技术设计](./AGENT_PLATFORM_TECHNICAL_DESIGN.md)：基础概念和历史设计。
- [低 Token 实施方案](./LOW_TOKEN_AGENT_IMPLEMENTATION.md)：上下文控制与低成本路由。
- [多模态附件计划](./MULTIMODAL_ATTACHMENT_DEVELOPMENT_PLAN.md)：附件处理设计。

历史文档描述的“当前问题”可能已经部分修复。执行开发任务前应核对代码，不能把文档条目直接当作未完成清单。本文为本轮功能范围与排期依据；具体迁移必须保留已有数据与可用功能。

## 2. 当前基线与差距

| 能力 | 当前实现证据 | 本轮需要补齐 |
| --- | --- | --- |
| 任务运行 | `lib/agent/runtime.ts`；创建接口等待执行完成后返回 | 持久化异步执行、立即返回任务 ID、恢复与取消 |
| 执行轨迹 | 已有事件表、SSE 接口和前端协作卡片 | 实时订阅、断线续传、历史任务入口 |
| 取消 | cancel 接口只处理 queued/waiting/planning 等状态 | 执行中取消、子任务传播、防止结果覆盖取消状态 |
| Skill | 独立表、绑定、发布状态、精确 ID 加载 | 自动匹配、版本快照、评估；Planner 当前移除 skillId |
| 记忆 | `lib/repositories/memories.ts` 有增查删；默认取员工最近 20 条 | 作用域、相关性检索、管理界面、来源与过期策略 |
| 产物 | `lib/db.ts` 预留 artifacts 表 | 产物写入、列表、预览、版本与下载闭环 |
| 群聊 | `app/im-page.tsx` 中群聊仍调用旧 chat 接口 | 与 Runtime 统一并保留 @、成员身份和附件能力 |
| 工具和通知 | 有工具注册器；notify 仅返回受理标记 | 实际落库、权限检查、执行闭环与通知中心 |
| 数据同步 | localStorage 与服务端并存；消息 PUT 全量替换 | 服务端增量持久化、分页、冲突处理 |
| 工程验证 | 本次审查 25 个测试通过、Lint 0 错误/3 警告、构建通过 | 新增状态机、接口集成和核心用户流程测试 |

验证基线不等于线上验证：本次没有进行真实模型、生产数据库、并发或浏览器端到端测试。

已确认完成的修复包括旧 Skill 对象解析、指定 Skill 校验、并行结果确定性汇总等，不重复列为新功能。

## 3. 范围、优先级与共同约定

### 3.1 功能优先级

| 编号 | 模块 | 优先级 | 核心交付 |
| --- | --- | --- | --- |
| F01 | 实时任务面板 | P1 | 实时状态、取消、重试、刷新恢复 |
| F02 | Skill 自动匹配与评估 | P1 | 自动选择、使用记录、试跑、发布回滚 |
| F03 | 记忆管理中心 | P1 | 相关召回、可编辑记忆、范围与来源 |
| F04 | 任务产物中心 | P1 | 报告和文件交付、预览、下载、版本 |
| F05 | 群聊统一 Runtime | P1 | 统一执行、交接、附件、负责人汇总 |
| F06 | 工作流模板 | P2 | 参数化模板、步骤依赖、复用和审批 |
| F07 | 定时任务与提醒 | P2 | 时区调度、运行记录、站内通知 |
| F08 | 反馈与返工 | P2 | 评价、定向重做、换员工、版本关联 |
| B01 | 运行和数据基础 | 前置 | 持久任务、增量消息、配额、上下文预算 |
| B02 | 多人使用基础 | 多人上线前 P0 | 登录、工作区、权限、资源归属 |

首版保留现有单体部署，增加同仓库独立 Worker 进程；数据库承担任务持久化。暂不引入微服务、向量数据库和任意代码插件。先提供 Markdown/纯文本/CSV 产物，Office 与 PDF 渲染后续扩展。

### 3.2 产品和接口约定

- 聊天仍是主要入口；复杂配置放在侧栏或管理页。
- 用户界面显示“任务、员工、能力、交付物”，仅调试详情展示技术字段。
- 新对话生成独立 conversationId；不再仅以员工 ID 代表该员工全部对话。
- 服务端保存消息、任务和产物；浏览器缓存不能自动覆盖服务端已有内容。
- 前端提交资源 ID 和用户输入；服务端加载配置、权限与权威历史。
- 新接口采用 `/api/v2`，避免立即改变旧同步接口契约。
- 错误格式统一为 `{ requestId, code, message }`；未知错误只给公开提示。
- 列表使用游标分页；修改资源携带 version，冲突返回 409。
- 创建任务、返工、调度触发接受幂等键；同范围同键返回同一结果，不重复计费。相同键不同请求内容返回 409。
- 所有日期持久化为 UTC；页面按用户时区显示，调度额外保存 IANA 时区。

## 4. B01/B02：前置基础设计

### 4.1 持久任务执行

请求路径：校验输入和权限 → 在同一事务中保存用户消息、queued Run 和 Job → 提交后返回 202。Worker 获取 Job 后调用 Runtime，执行状态与事件持久化，前端订阅事件。

禁止只用请求返回后的未等待 Promise 作为后台执行机制；服务重启后必须能够发现未完成任务。

新增 `run_jobs`：id、run_id、state、available_at、lease_owner、lease_expires_at、attempt、last_error_code、created_at。run_id 唯一。Worker 使用事务内条件更新领取任务，并以租约和心跳防止并发领取；锁实现按实际 MySQL/MariaDB 版本验证。

状态约定：

```text
queued → planning → running → succeeded / failed
                  ↘ waiting → queued（用户补充或批准后恢复）
queued / planning / running / waiting → cancelled
```

- Employee 直达可以从 queued 进入 running。
- waiting 必须持久化等待原因和恢复检查点；用户补充信息建立新的输入记录。
- 终态写入使用条件更新，已取消任务不能被迟到的模型响应覆盖成成功。
- 根任务聚合子任务；部分失败使用 `partialFailure` 标识并明确缺少的交付，全部失败不得标为成功。
- Worker 崩溃后回收过期租约。只读模型步骤允许有限重试；具有外部副作用的步骤先核对操作记录，不确定时转人工处理。
- 同一任务只提交一次最终消息；结果写入使用唯一键和执行尝试标识防重。
- 取消请求落库，并传播到当前 Worker 的 AbortController 与子任务。不能承诺供应商停止计费，但取消后不得再发布该执行尝试的结果。

### 4.2 服务端消息与迁移

- 新建 conversations；新增消息接口按 conversationId 追加、分页查询，保留员工和群组的关联。
- 消息保存与附件关联在同一事务中完成；不再删除整张消息表后重新插入。
- Message 关联 run_id，刷新后从服务端重建轨迹，避免协作卡片只存在浏览器内存。
- 历史单聊按员工、群聊按群映射成默认会话，保留原 message ID、顺序和附件关联；原来仅由前端标记的上下文分界不能假定在服务端可完整还原。
- 正式模式数据库不可用时显示失败或只读缓存。导入本地历史必须显式操作、预览冲突并去重。
- Schema 迁移作为部署命令执行，不放在聊天请求中。

### 4.3 上下文与成本

新增 `lib/agent/context-budgeter.ts`，所有模型调用统一经过预算器：身份卡、当前任务、摘要、近期历史、选中 Skill、相关记忆、附件片段分别记账。

建议默认：fast 输入 6,000/输出 1,600 Token；deep 输入 16,000/输出 4,000 Token，且必须低于所选模型可用窗口。超长输入提供明确处理提示，不无声截断关键指令。首版可保守估算 Token 并留余量，记录估算与真实 usage 差异。

新增 conversation_contexts：conversation_id、summary、task_state、summary_through_message_id、version。只在历史超过阈值或阶段完成时更新摘要；摘要失败仍须按预算运行或明确报错。

根任务限制总调用次数、并发数、Token 与耗时；调用前预留预算，完成后按实际用量结算。价格采用可维护且带生效日期的配置，未知价格显示“费用不可用”，不能算作零费用。失败但已产生用量的尝试也应记账。

### 4.4 多人上线边界

准备多人使用时，必须先接入登录、Session、workspace_members 与服务端授权，并给 conversation、agent、skill、run、memory、artifact、attachment、template、schedule 增加 workspace_id。角色建议 owner/admin/member/viewer，权限默认拒绝，权限结果由服务端确定。

附件上传、下载、记忆共享、模型配置管理、SSE 和 Run 查询均校验资源归属。限制上传与请求大小、模型调用速率和用户并发；完整错误只写脱敏日志，客户端不返回 SQL、连接信息或密钥。预览草稿执行必须受管理权限约束。

本地单用户模式可使用默认工作区，但不能据此宣称已经具备多人隔离能力。

## 5. F01：实时任务执行面板

### 5.1 用户流程

发送后立即显示任务卡片：排队、规划、各员工执行、汇总、完成。卡片显示耗时与可获得的实际 Token，支持展开原因、取消、重试失败步骤；刷新页面后仍可看到正在执行的任务。

首版只保证实时步骤事件；逐字输出单独实现模型流式适配，不能把事件 SSE 等同于模型流式回答。

### 5.2 接口与数据

| 接口 | 行为 |
| --- | --- |
| POST /api/v2/runs | 输入 conversationId、agentId、message、mode、attachmentIds、幂等键；返回 202 和 runId/status/eventsUrl |
| GET /api/v2/runs?conversationId=&cursor= | 历史任务分页 |
| GET /api/v2/runs/:id | 状态、子任务、产物、usage 和公开错误 |
| GET /api/v2/runs/:id/events | SSE，支持 Last-Event-ID 或 after 游标 |
| POST /api/v2/runs/:id/cancel | 幂等取消，返回实际状态或取消请求已受理 |
| POST /api/v2/runs/:id/retry | 建立新 Run，关联 retry_of_run_id，保留原记录 |
| POST /api/v2/runs/:id/resume | 提交补充输入/批准信息，在检查权限和版本后恢复 |

事件格式：`{ id, runId, type, createdAt, payload }`。类型包含 queued、planning、skill_selected、started、child_started、child_completed、waiting、usage、artifact_created、completed、failed、cancelled。

断线后按事件 ID 补发并由客户端去重；周期性发送心跳；完成后关闭连接。waiting 时页面显示等待输入，允许关闭订阅并在恢复后重新连接。结束订阅时释放轮询与计时器。

### 5.3 验收

- 测试环境中，创建接口不等待模型完成；预热且数据库正常时 p95 接受延迟目标小于 1 秒，不含附件上传。
- 页面在事件落库后 2 秒内显示新状态；刷新和断线重连不重复最终消息。
- 取消排队任务不调用模型；取消运行中任务后，迟到响应不覆盖 cancelled。
- Worker 重启后任务可恢复或明确失败，不永久停在“正在思考”。
- 重试只创建新尝试，并保留原始错误和用量。

## 6. F02：Skill 自动匹配、评估和版本

### 6.1 选择与运行

显式指定 Skill 时，校验员工绑定、启用和已发布状态；无效返回明确错误。自动模式先在有权限的已绑定 Skill 中按名称、摘要、关键词评分，fast 取 0～1 个，deep 取 0～2 个；低于阈值不加载全文。

Planner 候选需要提供真实 Skill ID 与简短摘要，或由 Executor 接到员工任务后自行召回。建议首版使用 Executor 召回，避免 Planner 编造 ID。记录候选分数、选中原因、版本和输入预算；评分相同使用稳定排序。

超过预算的 Skill 不能因“至少选一个”而绕过上限；返回过长提示或选择经过人工维护的运行摘要。单聊、群聊、模板共用选择逻辑。

### 6.2 版本与测试数据

- `skill_versions`：id、skill_id、version、完整指令/schema/examples 快照、created_by、created_at；唯一约束 skill_id + version。
- `skill_test_cases`：id、skill_id、input、expected_criteria、fixture_refs、enabled。
- `skill_eval_runs`：id、skill_version_id、case_id、run_id、status、latency_ms、usage、evaluation_result。
- 已发布版本不可原位修改；编辑产生草稿，发布切换指针。回滚重新发布历史内容并生成新版本，保留审计链。
- Run 保存实际 Skill 版本或快照，防止修改配置后无法解释历史结果。

接口：`POST /api/v2/skills/:id/test`、`GET /:id/evaluations`、`GET /:id/versions`、`POST /:id/publish`、`POST /:id/rollback`。这些路径均以 `/api/v2/skills` 为前缀；请求携带版本与幂等键（适用时）。

### 6.3 验收

- 已绑定但禁用、未发布或跨工作区 Skill 不得进入上下文。
- 已知测试问题匹配到预期 Skill，无匹配问题的 Skill 全文占用为零。
- 聊天卡片显示实际使用的 Skill 和版本，试跑展示输出、耗时与用量。
- 区分“执行成功率”和“内容质量评分”；人工评分与模型评分分开显示，不互相冒充。
- 回滚后新任务使用新发布指针，旧任务仍能读取原版本。

## 7. F03：记忆管理中心

### 7.1 功能与数据

员工侧栏提供记忆列表、搜索、编辑、删除、置顶和禁用。每条显示内容、来源消息、更新时间和作用范围。自动提取先形成待确认候选；用户确认后成为长期记忆，也可显式启用自动保存偏好。

扩展 memories：workspace_id、conversation_id、scope（conversation/agent/workspace）、kind、status（suggested/active/disabled）、source_message_id、source_run_id、confidence、expires_at、pinned、version、updated_at。共享范围修改需要相应权限；首版可只支持一个来源，后续增加多来源表。

检索先按权限、范围、状态和过期时间过滤，再按关键词、置顶、时间和相关性排序。建议加载 3～5 条、总计不超过 600 Token；置顶不能绕过权限和总预算。

记忆是可修正的参考材料，不能提升为系统指令。相互矛盾的信息标注冲突，不能无条件以最新内容替换用户明确确认的事实。

接口：`GET/POST /api/v2/memories`、`PATCH/DELETE /api/v2/memories/:id`、`POST /api/v2/memories/:id/confirm`。列表按 scope、agentId、conversationId 和关键词过滤。

### 7.2 验收

- 删除、禁用和过期记忆不再参与新任务召回。
- 会话私有记忆不进入其他会话，工作区隔离测试通过。
- 每次运行可查看实际使用的记忆来源；不存在来源时明确标记“手动录入”。
- 编辑并发冲突返回 409；记忆过多不突破预算。
- 自动提取失败不阻断原始聊天回答。

## 8. F04：任务产物中心

### 8.1 功能

员工生成报告、方案、会议纪要或结构化表格时，同时创建产物记录。聊天显示产物卡片，产物中心支持按项目/会话、员工、类型和时间筛选。

首版支持 Markdown、纯文本、经过校验的 CSV、代码文本文件；可预览、下载、复制和基于已有产物继续修改。Office/PDF 文件需要专门生成器和渲染验证，作为后续任务，不能只更改扩展名交付。

### 8.2 数据和接口

- 扩展 artifacts：workspace_id、conversation_id、created_by_agent_id、current_version、status。
- 新增 `artifact_versions`：artifact_id、version、run_id、mime_type、content 或 storage_key、size_bytes、checksum、created_at；artifact_id + version 唯一。
- 一版内容不可覆盖；修订建立新版本。首版文本仍可存数据库，二进制存储方案独立扩展。
- Runtime 先校验产物结构和大小，再事务性保存；保存失败不能显示“文件已生成”。
- `GET /api/v2/artifacts`、`GET /api/v2/artifacts/:id`、`GET /api/v2/artifacts/:id/versions/:version`、`GET /api/v2/artifacts/:id/download?version=`。
- `POST /api/v2/artifacts/:id/revise` 创建关联原产物版本的新任务。

### 8.3 验收

- 下载与预览内容一致，文件名、MIME、版本和来源 Run 正确。
- 历史版本可打开，失败修订不覆盖成功版本。
- Markdown/HTML 预览不执行脚本；CSV 导出处理公式注入风险。
- 非授权用户不能凭 URL 下载其他工作区文件。

## 9. F05：群聊统一执行与交接

### 9.1 路由规则

- 单聊明确指定员工时直达该员工；指定总控入口或开启委派时才允许 Company Planner。
- 群聊明确 @某员工时采用代码路由；多位 @限制人数和并发，无 @时按负责人和任务复杂度选择回答或规划。
- 根任务默认 fast 委派 1 位，deep 最多 3 位，递归只允许平台到员工一层。与旧文档的默认值不同，本轮以此为建议起点。
- 服务端保存 groupId、发送者身份、会话消息和成员快照；员工输出中的 @文本不直接成为不受限制的执行命令。
- 自动建议拉人时展示候选和原因，由有权限的用户确认后变更成员。

### 9.2 执行与附件

统一向 Runtime 传 attachmentIds，由服务端验证会话归属并解析；保留图片输入、文档提取及不支持模型的明确提示，不能迁移后退化为只传文件名。

交接结果建议结构：displayText、handoffSummary、keyFacts、risks、recommendations、artifactIds。后续依赖任务读取前序的精简交接与产物引用，汇总按需查全文。

dependsOn 必须校验未知依赖、自依赖、循环和重复执行。前序失败时按任务策略跳过或明确降级；禁止将死锁的剩余步骤当作无依赖全部执行。步骤以 stepId 标识，允许同一员工在不同步骤参与。

### 9.3 验收

- 普通单聊、明确 @、多员工协作分别走预期路径；明确 @不调用模型路由器。
- 两位员工并行时结果身份、顺序、Token 汇总正确。
- 后续步骤实际收到依赖结果，失败步骤不被描述为已经完成。
- 图片和文档在单聊、群聊和委派三种路径中均通过回归。
- 旧 chat 入口迁移为适配器，最终只保留一套上下文与模型调用逻辑。

## 10. F06：快捷工作流与任务模板

首批内置模板建议：竞品分析、周报、营销方案评审、文档审阅、项目复盘。用户选择模板 → 填写目标与附件 → 查看员工与步骤 → 启动 → 查看结果。

模板包含参数 schema、步骤列表、stepId、agentId、skillId、dependsOn、输出要求、是否需要审批、预算和版本。保存时验证 DAG 和资源权限；运行时再次校验员工/Skill 是否仍然可用。

新增 `workflow_templates` 与 `workflow_template_versions`；Run 保存模板版本及解析后的配置快照。首版使用表单和步骤列表，不要求可视化拖拽编辑器。

接口：`GET/POST /api/v2/templates`、`PATCH /api/v2/templates/:id`、`POST /api/v2/templates/:id/publish`、`POST /api/v2/templates/:id/run`。

审批步骤将 Run 转 waiting，保存待执行动作及参数摘要。审批仅对该版本和参数有效；参数变更后重新审批，不能复用宽泛 confirmed 布尔值批准任意动作。

验收：相同模板可参数化复用；缺参在启动前提示；循环依赖无法发布；模板更新不改变已运行任务；审批前对应写操作不执行。

## 11. F07：定时任务与主动提醒

首版支持每日、每周和一次性定时运行已发布模板，以及站内完成/失败通知；外部邮件和即时通信通知作为独立扩展。

新增 schedules：workspace_id、template_version_id、input_json、timezone、schedule_spec、next_run_at、enabled、misfire_policy、created_by、version。新增 schedule_occurrences：schedule_id、scheduled_for、run_id，唯一约束 schedule_id + scheduled_for，防止多调度器重复触发。

调度器只持久化入队，不直接运行模型。默认同一计划不重叠执行，错过触发不集中补跑，记录跳过原因；用户可选择“合并补跑一次”。日光节约时间不存在的本地时刻默认跳过，重复时刻只执行一次，并通过测试固定行为。

新增 notifications：recipient_id、workspace_id、type、run_id、title、content、read_at、created_at、dedupe_key。仅完成、失败或需要用户操作时通知；重复事件不重复通知。定时内部通知通过创建计划时的明确授权执行，不能绕过其他工具授权。

接口：`GET/POST /api/v2/schedules`、`PATCH /api/v2/schedules/:id`、`POST /api/v2/schedules/:id/run-now`、`GET /api/v2/notifications`、`PATCH /api/v2/notifications/:id`。

验收：保存时区与下次触发时间一致；两个调度器同一时刻只创建一个任务；暂停后不再产生未来任务；已有运行是否取消通过独立操作决定；通知实际落库且可读/标记已读。当前 builtin.notify 受理标记不能作为验收依据。

## 12. F08：结果反馈与定向返工

消息和产物提供“有用/无用”、事实错误、过长/过短及自由备注。返工支持重新生成、换员工和只重做某一步/某个产物部分。

新增 feedback：workspace_id、user_id、run_id、message_id 或 artifact_version_id、rating、tags、comment、created_at。反馈必须关联实际输出版本。

`POST /api/v2/feedback` 保存反馈；`POST /api/v2/runs/:id/rework` 输入目标 stepId/产物版本、修改要求、可选新员工，创建独立新 Run 并关联 rework_of_run_id。

局部返工复用明确未变的输入和上游产物；下游若依赖被修改内容，标记过期并允许重跑，不能继续把旧汇总标为最新。用户评价只用于分析和候选改进，不自动改写已发布 Skill 或全团队记忆。

验收：原回答不丢失；返工前可见修改范围；新旧结果可对比；汇总报告能区分执行成功率与用户满意度；同一用户对同一结果的更新不重复计票。

## 13. 实施任务拆分与交付顺序

估算假设：一名熟悉项目的全栈开发者；包含基础测试、联调和迁移验证，不包含外部渠道审批及大规模数据治理。可在首个阶段完成后重新估算。

| 阶段 | 工作包 | 前置依赖 | 粗估人日 | 交付门槛 |
| --- | --- | --- | --- | --- |
| S0 | B01 增量消息、会话迁移、部署迁移脚本 | 无 | 4～7 | 历史和附件不丢失，并发追加不覆盖 |
| S1 | B01 Worker/Job/状态机 + F01 面板 | S0 | 7～12 | 创建即返回、重连、取消、恢复通过 |
| S2 | 预算器、摘要 + F02 Skill 匹配和版本试跑 | S1 | 6～10 | 上下文受控，匹配、发布、回滚可验收 |
| S3 | F05 群聊链路、附件、结构化交接 | S1、S2 | 5～8 | 三条对话路径行为一致 |
| S4 | F03 记忆管理 + F04 文本产物 | S2、S3 | 7～12 | 记忆范围与产物版本闭环 |
| S5 | F08 反馈返工 + F06 工作流模板 | S3、S4 | 6～10 | 返工关联清楚，模板可复用 |
| S6 | F07 调度与站内通知 | S1、S5 | 4～7 | 幂等触发、时区、失败通知通过 |
| 上线门槛 | B02 登录、归属、权限、配额 | 多人部署前完成，建议从 S0 开始 | 6～12 | API/SSE/附件跨工作区访问被拒绝 |

建议第一批交付 S0～S2，形成“任务看得见、执行能取消、Skill 真正被调用”的完整版本；第二批交付群聊、记忆和产物；最后提供模板和自动运行。

## 14. 代码组织建议

渐进拆分 `app/im-page.tsx`：先抽 API client 和状态订阅，再抽面板，最后迁移各业务组件。功能开发不要求一次性重写全部页面。

```text
app/api/v2/                 新契约路由
features/chat/              会话与消息
features/runs/              任务卡片、详情、事件订阅
features/skills/            选择、测试、版本
features/memories/          记忆管理
features/artifacts/         预览与版本
features/workflows/         模板、定时计划
lib/agent/context-budgeter.ts
lib/agent/skill-retriever.ts
lib/agent/memory-retriever.ts
lib/jobs/                   入队、领取、租约、调度
lib/repositories/           事务和资源查询
scripts/migrations/         显式部署迁移
workers/                    持久执行进程入口
```

新增目录属于建议，实施时遵循当时项目约定。模型供应商继续通过现有 gateway 访问；领域逻辑放在服务层，Route 只负责协议、校验和授权。

## 15. 测试、指标与发布

### 15.1 必测场景

- 状态机：重复提交、执行中取消、取消和完成竞争、Worker 崩溃、租约过期、多 Worker 领取、waiting 恢复。
- 数据：两标签页并发发消息、旧消息迁移、附件关联事务失败、历史轨迹重建。
- 能力：Skill 无匹配/无权限/过预算、版本回滚、记忆过期/冲突/跨会话隔离。
- 协作：循环依赖、部分失败、后续步骤收到交接、群聊附件、人数和调用预算超限。
- 产物和工作流：版本冲突、局部返工导致下游过期、审批参数变更、调度重复触发和时区边界。
- 权限：从接口和 SSE 直接读取非授权资源、附件下载、草稿预览和模型配置修改。

使用可控模型适配器验证确定性流程；数据库事务、锁、租约必须用实际目标数据库做集成测试。关键验收后再做小规模真实模型冒烟，避免依靠付费模型测试状态机。

### 15.2 观测指标

记录创建请求耗时、排队时长、首事件时长、任务成功/部分失败/失败率、取消延迟、重试率、按步骤实际 Token、上下文各分区占用、Skill 命中率、产物保存失败率、调度延迟和用户评分。

性能结果附环境、样本数和并发条件。上线前先记录当前版本基准，不能直接把设计目标写成已达成收益。

### 15.3 迁移与发布步骤

1. 备份数据库并演练恢复；验证新增表、字段、索引和旧数据映射。
2. 部署兼容 Schema 与 Worker，暂不开启新入口；确认 Worker 心跳和任务租约。
3. 通过功能开关切换少量新会话到 v2；每个会话只使用一个执行入口，避免双调用模型。
4. 验证单聊、群聊、附件、刷新恢复和取消，并比较成本、错误率与消息数量。
5. 逐步扩展新入口。旧接口保留适配；完成历史兼容验证后再单独下线旧代码。
6. 回退时停止新任务入队并处理在途任务，再切换入口；保留新增表与历史 Run，不通过删除表实现回退。旧页面读不到新会话时提供只读兼容视图。

### 15.4 每阶段完成定义

- 用户流程、失败提示和刷新恢复可演示。
- 数据迁移可重复执行，并有恢复方案；原有消息、配置和附件保持可读取。
- 对应状态机/接口/核心流程检查通过，构建与 Lint 无新增错误。
- 对未实现项、已知限制和性能实测结果有明确记录。
- 文档、接口契约和实际行为一致；不能以表结构或占位返回值代替功能交付。
