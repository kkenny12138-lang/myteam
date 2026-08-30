# MyTeam 低 Token Agent 架构实施方案

> 本文供 DS 直接实施。与 `AGENT_PLATFORM_TECHNICAL_DESIGN.md` 配套使用。  
> 核心目标：在不改变现有单聊、群聊、@员工、组织架构和员工档案交互的前提下，把平台升级为低 Token 的 Agent 系统。

## 1. 目标与验收指标

### 1.1 产品目标

- 平台是 Company Agent，每位员工是 Employee Agent。
- 员工档案和 Skill 可以保存大量文字。
- 每次调用只加载当前任务必要的信息。
- 简单聊天不经过昂贵的多 Agent 规划。
- 长对话不重复发送全部历史。
- 多员工协作使用精简交接信息，不重复传递全文。

### 1.2 必须保持不变的交互

- 左侧选择员工后直接对话；
- 输入框、发送、新对话、删除对话等操作路径；
- 群聊与 `@员工`；
- 组织架构与员工资料查看；
- 现有快速/深度模式；
- 现有 Kimi/DeepSeek 模型选择。

允许增加但不能强制用户操作的 UI：Skill 长文本编辑器、执行状态、Token 用量、摘要状态。

### 1.3 量化指标

- 普通员工单聊目标输入上下文：2,000～6,000 Token；
- 长对话目标输入上下文：不超过配置预算，默认 8,000 Token；
- 未命中 Skill 时，Skill 全文 Token 消耗为 0；
- 单聊和明确 `@员工` 的请求不得调用 LLM 路由器；
- 默认一次只加载 1 个 Skill，最多 2 个；
- 默认多 Agent 最多调用 2 位员工，最大递归深度 2；
- 每次运行记录 prompt、completion、累计 Token 及各上下文分区占用；
- 与优化前基准用例相比，普通聊天平均输入 Token 至少降低 40%。

## 2. 总体架构

```text
用户消息
  ↓
Request Classifier（纯代码，零模型 Token）
  ├─ 当前员工单聊 ──────────────┐
  ├─ 明确 @员工 ────────────────┤
  ├─ 明确关键词/Skill ──────────┤→ Employee Agent
  └─ 无法确定 ─→ 轻量 LLM Router ┘
                                  ↓
Context Budgeter
  ├─ 固定短身份卡
  ├─ 结构化任务状态
  ├─ 历史滚动摘要
  ├─ 最近 4～8 条消息
  └─ 仅命中的 0～2 个 Skill
                                  ↓
Model Gateway（DeepSeek/Kimi）
                                  ↓
回复 + 结构化交接摘要 + 用量记录
```

复杂跨部门任务才进入：

```text
Company Agent Planner
  → 1～2 个 Employee Agent 子任务
  → 使用 handoffSummary 汇总
  → Company Agent 最终回复
```

## 3. 核心省 Token 机制

### 3.1 员工“双档案”

完整档案用于管理和展示；运行身份卡用于每次模型调用。

```ts
type AgentRuntimeProfile = {
  identity: string;
  responsibilities: string[];
  behaviorRules: string[];
  boundaries: string[];
  routingKeywords: string[];
  version: number;
};
```

要求：

- `runtimeProfile` 默认控制在 300～800 Token；
- 保存完整员工档案后异步/显式生成运行身份卡；
- 运行身份卡必须可人工编辑；
- 运行时不直接注入完整履历、全部优缺点和长篇介绍；
- 缺点必须转换为可执行约束，例如“数据不足时先声明假设”。

### 3.2 Skill 三级渐进加载

```ts
type Skill = {
  id: string;
  name: string;             // Level 1
  keywords: string[];       // Level 1
  summary: string;          // Level 2，建议 100～200 字
  instructions: string;     // Level 3，Markdown 长文本
  estimatedTokens: number;
  status: 'draft' | 'published' | 'disabled';
  version: number;
};
```

加载流程：

1. 纯代码使用名称、关键词、员工绑定关系召回候选。
2. 候选只有一个且分数达到阈值，直接选择。
3. 候选不确定时，只把候选 `name + summary` 交给轻量路由器。
4. 最终只加载选中 Skill 的 `instructions`。
5. 普通聊天没有相关 Skill 时不加载任何 Skill 全文。

默认最多加载 1 个 Skill；深度模式最多 2 个。禁止每次加载员工的全部 Skill。

### 3.3 短窗口与滚动摘要

每个会话保存：

```ts
type ConversationContext = {
  summary: string;
  summaryThroughMessageId: string | null;
  taskState: TaskState;
  recentMessages: Message[];
  summaryVersion: number;
};

type TaskState = {
  goal: string;
  confirmedFacts: string[];
  constraints: string[];
  decisions: string[];
  openQuestions: string[];
  completedWork: string[];
};
```

策略：

- 保留最近 6 条原始消息，配置范围 4～8 条；
- 更早消息由 `summary` 和 `taskState` 表达；
- 不按固定消息数无脑保留最近 20 条；
- 仅当未摘要历史估算超过 4,000 Token、完成一个任务阶段或开始新对话时生成摘要；
- 不允许每条消息都调用一次摘要模型；
- 摘要采用便宜/快速模型，输出固定 JSON；
- 摘要失败不能阻塞当前回复，回退为截断旧消息。

### 3.4 快速通道

按以下顺序决定是否调用路由模型：

```text
1. 当前是员工单聊                 → 当前员工
2. 消息明确 @某员工              → 指定员工
3. 用户明确选择某个 Skill         → 指定 Skill
4. 关键词高置信度唯一匹配          → 对应员工/Skill
5. 其他情况                       → 轻量 LLM Router
```

Company Agent 只有在以下情况下启动完整规划：

- 用户明确要求多位员工协作；
- 涉及两个以上专业领域；
- 需要交叉审查或冲突判断；
- 单员工无法覆盖任务且路由置信度不足。

简单问候、追问、当前员工职责内任务不得启动 Planner。

### 3.5 多 Agent 精简交接

员工 Agent 的模型输出建议使用结构化协议：

```ts
type AgentResult = {
  displayText: string;
  handoffSummary: string;  // 建议不超过 500 Token
  keyFacts: string[];
  risks: string[];
  recommendations: string[];
};
```

Company Agent 汇总时默认只读取：

- `handoffSummary`；
- `keyFacts`；
- `risks`；
- `recommendations`。

只有检测到结论冲突或用户要求查看完整推理材料时，才读取 `displayText`。禁止将每位员工的完整回答无条件再次放进汇总 prompt。

## 4. Context Budgeter

新增统一预算器，所有模型调用必须经过该模块，不允许 API Route 自行拼接无限上下文。

### 4.1 默认预算

```ts
const DEFAULT_BUDGET = {
  maxInputTokens: 8000,
  reservedOutputTokens: 1800,
  systemRules: 500,
  runtimeProfile: 700,
  taskState: 600,
  conversationSummary: 800,
  recentMessages: 2500,
  skills: 2200,
  currentMessage: 700,
};
```

建议配置：

| 模式 | 输入预算 | 输出预算 | Skill 数 | 员工数 |
|---|---:|---:|---:|---:|
| fast | 6,000 | 1,200 | 1 | 1 |
| deep | 16,000 | 4,000 | 2 | 2 |

预算应通过环境变量或数据库配置，不能写死在 UI。

### 4.2 裁剪顺序

超预算时按以下顺序处理：

1. 删除 Skill 示例；
2. 删除未选中的候选 Skill 摘要；
3. 减少较旧原始消息；
4. 压缩 conversation summary；
5. 删除次要 Skill；
6. 缩短非关键 task state 字段；
7. 若仍超限，返回明确的上下文过长错误或要求用户拆分任务。

禁止裁剪：安全规则、Agent 身份边界、当前用户消息、工具权限约束。

### 4.3 Token 估算

- Model Gateway 提供统一 `estimateTokens(text, provider, model)`；
- 若供应商没有本地 tokenizer，第一版允许使用保守估算并乘安全系数 1.2；
- 请求完成后以供应商 `usage` 的真实 Token 校正估算数据；
- `estimatedTokens` 仅用于预算，计费和统计必须使用响应中的真实 usage。

## 5. 数据库改造

在 Agent 总体方案的表基础上增加：

```sql
ALTER TABLE agents
  ADD COLUMN runtime_profile JSON NULL,
  ADD COLUMN runtime_profile_tokens INT NOT NULL DEFAULT 0;

ALTER TABLE skills
  ADD COLUMN keywords JSON NULL,
  ADD COLUMN estimated_tokens INT NOT NULL DEFAULT 0;

CREATE TABLE conversation_contexts (
  conversation_id VARCHAR(64) PRIMARY KEY,
  summary MEDIUMTEXT NOT NULL,
  summary_through_message_id VARCHAR(64) NULL,
  task_state JSON NULL,
  summary_version INT NOT NULL DEFAULT 1,
  estimated_tokens INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE model_usage (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  run_id VARCHAR(64) NOT NULL,
  call_type ENUM('route','plan','execute','summarize','synthesize') NOT NULL,
  agent_id VARCHAR(64) NULL,
  model_provider VARCHAR(30) NOT NULL,
  model_name VARCHAR(100) NOT NULL,
  prompt_tokens INT NOT NULL DEFAULT 0,
  completion_tokens INT NOT NULL DEFAULT 0,
  cached_tokens INT NOT NULL DEFAULT 0,
  estimated_cost DECIMAL(16,8) NULL,
  latency_ms INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_usage_run (run_id),
  INDEX idx_usage_created (created_at)
);
```

迁移要求：新建或增加字段，不删除现有数据；脚本幂等；旧 `employee_profiles.skills` 双读兼容。

## 6. 服务端模块

```text
lib/agent/request-classifier.ts   # 零 Token 快速通道
lib/agent/skill-retriever.ts      # Skill 候选召回和评分
lib/agent/context-budgeter.ts     # Token 分配与裁剪
lib/agent/context-builder.ts      # 组装最终上下文
lib/agent/task-state.ts           # 结构化任务状态
lib/agent/summarizer.ts           # 滚动摘要
lib/agent/runtime.ts              # Agent 状态机
lib/agent/result-parser.ts        # 结构化结果校验
lib/models/gateway.ts             # 模型统一接口
lib/usage/recorder.ts             # Token/延迟/成本记录
```

关键接口：

```ts
type BuildContextInput = {
  agentId: string;
  conversationId: string;
  currentMessage: string;
  mode: 'fast' | 'deep';
  selectedSkillIds?: string[];
};

type BuiltContext = {
  messages: Array<{ role: string; content: string }>;
  selectedSkillIds: string[];
  estimatedInputTokens: number;
  sections: Record<string, number>;
  truncations: string[];
};
```

所有执行入口先调用 `buildContext()`，再调用 Model Gateway。

## 7. API 改造

前端不再提交员工完整档案：

```json
POST /api/agent/runs
{
  "conversationId": "conv_xxx",
  "agentId": "employee_buffett",
  "message": "帮我检查这份预算",
  "mode": "fast"
}
```

响应增加使用信息，但 UI 可暂时不展示：

```json
{
  "runId": "run_xxx",
  "text": "...",
  "usage": {
    "promptTokens": 4210,
    "completionTokens": 860,
    "totalTokens": 5070,
    "selectedSkillIds": ["budget_review"],
    "routeType": "direct",
    "contextSections": {
      "runtimeProfile": 430,
      "taskState": 280,
      "summary": 510,
      "recentMessages": 1120,
      "skills": 1460,
      "currentMessage": 110
    }
  }
}
```

服务端必须按 `agentId` 读取配置，禁止信任前端提交的姓名、岗位、Skill 或权限。

## 8. 前端改动范围

前端保持现有交互，仅做以下内部适配：

1. `/api/chat` 请求逐步切换为 `/api/agent/runs`，传 `agentId`、`conversationId`、`message`、`mode`。
2. Skill 描述输入改为 Markdown 长文本 `textarea`，支持已有 Skill 编辑、折叠和字符数显示。
3. 可选增加 Token 详情入口，默认只显示本次总 Token，不影响聊天阅读。
4. 多 Agent 时使用一个通用状态卡展示“分析、委派、执行、汇总”，不改变输入与发送方式。
5. 保留旧 `/api/chat` 作为迁移期兼容入口，内部可转发到新 Runtime。

不要重做页面布局，不要改变左侧员工选择与聊天操作。

## 9. 分阶段开发任务

### Phase A：建立基准和可观测性

- 给现有 `/api/chat` 增加真实 usage 持久化；
- 建立 20～30 条固定测试消息作为 Token 基准；
- 记录模型、模式、输入/输出 Token 和耗时；
- 输出优化前平均值、P50、P95。

验收：每次模型调用都能按 run 查询真实 Token，不能只使用估算值。

### Phase B：单员工低 Token 上下文

- 前端改传 `employeeId/agentId`；
- 建立 runtime profile；
- 实现 Context Budgeter；
- 最近消息从固定 20 条改为预算窗口；
- 将相关优缺点转换为短行为规则；
- 未命中 Skill 时不加载 Skill。

验收：普通员工单聊平均输入 Token 比基准下降至少 25%，回答仍体现员工身份。

### Phase C：Skill 渐进加载

- Skill 独立表和长文本编辑；
- 增加关键词、摘要、Token 估算；
- 实现纯代码召回和必要时的轻量模型选择；
- 默认只加载一个 Skill；
- 记录每次选择的 Skill 和选择原因。

验收：员工有多个长 Skill 时，单次请求只包含命中 Skill；无关 Skill 不进入最终 prompt。

### Phase D：滚动摘要和任务状态

- 建立 `conversation_contexts`；
- 实现摘要触发阈值；
- 最近保留 4～8 条原始消息；
- 旧内容写入 summary/taskState；
- 摘要失败安全回退。

验收：100 条消息的长对话，单次输入仍不超过预算；关键事实、约束和决定能够保留。

### Phase E：低 Token 多 Agent

- 实现快速通道和 Company Agent Planner；
- 默认最多调用两位员工；
- Employee Agent 返回 handoffSummary；
- 汇总默认不读取完整 displayText；
- 增加循环、递归、总 Token 和超时限制。

验收：简单消息不触发 Planner；多员工任务的汇总输入只使用结构化交接信息；不会无限互相调用。

## 10. 测试清单

- 单聊请求不会额外调用路由模型；
- `@员工` 能零模型路由；
- 0、1、10 个 Skill 场景下只加载必要 Skill；
- 50,000 字 Skill 能保存，但无关请求不会加载它；
- fast 模式超预算时按规定顺序裁剪；
- 安全规则、身份边界和当前消息永不被裁剪；
- 100 条历史消息仍保持预算上限；
- 摘要保留金额、日期、目标、否定约束等关键事实；
- 摘要服务失败时当前聊天仍能回复；
- 多 Agent 只传 handoffSummary 给汇总 Agent；
- usage 统计等于所有 route/plan/execute/summarize/synthesize 调用之和；
- 禁用 Skill、越权 Agent、未知 ID 被服务端拒绝；
- 原有单聊、群聊、新对话、组织架构交互回归测试通过。

## 11. 给 DS 的首轮开发提示词

```text
请先阅读 docs/AGENT_PLATFORM_TECHNICAL_DESIGN.md 和
docs/LOW_TOKEN_AGENT_IMPLEMENTATION.md，并检查当前项目的
app/api/chat/route.ts、app/api/profiles/route.ts、app/im-page.tsx、lib/db.ts。

先实施 LOW_TOKEN_AGENT_IMPLEMENTATION 的 Phase A 和 Phase B：
1. 保持现有前端布局、单聊、群聊、@员工、新对话和组织架构交互不变；
2. 建立每次模型调用的 usage/run 记录和固定 Token 基准测试；
3. 聊天请求改为提交 employeeId/agentId，由服务端加载权威员工资料；
4. 为员工建立精简 runtime profile；
5. 实现统一 Context Budgeter，fast 默认输入预算 6000、deep 默认 16000；
6. 将固定最近 20 条历史改为 Token 预算窗口；
7. 未命中 Skill 时禁止加载任何 Skill 全文；
8. 保持 Kimi/DeepSeek 双模型兼容，供应商差异封装到 adapter；
9. 数据库迁移必须幂等、无损并兼容旧数据；
10. 补充测试，最后报告修改文件、数据库影响、优化前后 Token 对比和未完成项。

不要一次实施多 Agent，不要重构现有 UI，不要删除旧 API；Phase A/B 验收通过后再继续 Phase C。
```

## 12. 实施底线

- 资料“能写很多”不等于“每次全部发送”。
- 不允许任何页面或 API 绕过 Context Budgeter。
- 不允许用完整聊天历史代替任务状态。
- 不允许简单单聊启动 Company Agent Planner。
- 不允许多 Agent 汇总时重复传递所有完整回答。
- 不允许为了省 Token 丢失安全规则、当前问题和关键业务约束。

最终运行链路应是：先零成本确定能否直达，再按需选择 Skill，再由预算器组装最小充分上下文，最后记录真实 Token 并持续用基准测试验证节省效果。
