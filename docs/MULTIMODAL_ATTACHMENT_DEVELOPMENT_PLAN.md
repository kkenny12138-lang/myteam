# 对话附件与多模态分析开发方案（DeepSeek 开发版）

## 1. 项目目标

在现有单聊和群聊对话框中增加附件能力，使用户可以上传图片和文档，并由指定员工 Agent 结合员工档案、Skill、聊天上下文完成分析。

首期支持：

- 图片：PNG、JPEG、WEBP
- 文档：PDF、DOCX、TXT、Markdown
- 表格：CSV、XLSX
- 单聊、群聊均可发送附件
- 一条消息最多 5 个附件，单文件默认不超过 20 MB
- 图片支持预览，文档支持查看名称、大小、解析状态和下载
- 群聊中的附件交给被 `@` 的成员分析
- 附件、消息关系和解析结果持久化

首期不支持视频、音频、压缩包和可执行文件。

## 2. 当前代码基线

当前系统是 Vinext/React 应用，生产环境使用 Docker、MySQL 和 Caddy。关键代码：

- `app/im-page.tsx`：单聊、群聊、编辑器和消息渲染
- `app/api/chat/route.ts`：聊天请求、员工上下文及 Skill 组装
- `app/api/messages/route.ts`：单聊消息持久化
- `app/api/group-messages/route.ts`：群聊消息持久化
- `lib/agent/types.ts`：统一消息和 Agent 类型
- `lib/models/gateway.ts`：模型统一入口
- `lib/models/deepseek.ts`：DeepSeek 适配器
- `lib/db.ts`：MySQL 表结构及兼容迁移

当前限制：

- `ChatMessage.content` 只能是字符串。
- 单聊和群聊消息表只保存 `text`。
- `/api/chat` 只接收文本历史。
- DeepSeek 适配器只组装文本消息。
- 界面中的“＋”按钮尚未连接文件选择和上传逻辑。

## 3. 核心设计原则

1. 原文件放对象存储，MySQL 只保存元数据、解析文本和消息关系。
2. 浏览器不能直接向模型供应商上传文件或暴露 API Key。
3. 附件必须先上传成功并获得 `attachmentId`，发送消息时只提交 ID。
4. 服务端必须验证附件是否属于当前会话，不能信任前端提交的 ID。
5. 文档优先在服务端抽取结构化文本，再交给 DeepSeek。
6. 图片是否能原生分析由模型能力配置决定，不在业务层写死。
7. 不支持图片的 DeepSeek 模型必须返回明确提示，或走独立 OCR/视觉服务后再把结果交给 DeepSeek。
8. 附件内容属于不可信输入，不能覆盖系统提示、员工身份或 Skill 指令。

## 4. 推荐架构

```text
选择/拖拽/粘贴附件
        ↓
POST /api/attachments（multipart/form-data）
        ↓
类型、大小、权限、安全校验
        ↓
对象存储保存原文件 + MySQL 保存元数据
        ↓
图片：生成受控 URL 或交给视觉/OCR 服务
文档：解析文本、页码、工作表和段落
        ↓
POST /api/chat（text + attachmentIds）
        ↓
加载员工档案、Skill、历史和附件
        ↓
模型能力路由
        ↓
DeepSeek 文本分析 / 视觉模型分析后交给 DeepSeek
        ↓
消息和附件关联持久化
```

## 5. 数据库设计

新增附件表：

```sql
CREATE TABLE IF NOT EXISTS attachments (
  id VARCHAR(64) PRIMARY KEY,
  owner_type VARCHAR(20) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  storage_key VARCHAR(500) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  size_bytes BIGINT NOT NULL,
  category VARCHAR(30) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'uploading',
  extracted_text LONGTEXT NULL,
  extraction_meta JSON NULL,
  error_message TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_attachment_owner (owner_type, owner_id),
  INDEX idx_attachment_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

新增消息附件关联表：

```sql
CREATE TABLE IF NOT EXISTS message_attachments (
  message_type VARCHAR(20) NOT NULL,
  message_id VARCHAR(64) NOT NULL,
  attachment_id VARCHAR(64) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (message_type, message_id, attachment_id),
  INDEX idx_ma_attachment (attachment_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

字段约束：

- `owner_type`：`single` 或 `group`
- `category`：`image`、`document`、`spreadsheet`、`text`
- `status`：`uploading`、`processing`、`ready`、`failed`、`deleted`
- `message_type`：`single` 或 `group`
- 所有建表和补列操作保持幂等，兼容现有生产数据库。

## 6. 统一类型设计

在 `lib/agent/types.ts` 中新增：

```ts
export type AttachmentStatus =
  | 'uploading'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'deleted';

export interface AttachmentRecord {
  id: string;
  ownerType: 'single' | 'group';
  ownerId: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  category: 'image' | 'document' | 'spreadsheet' | 'text';
  status: AttachmentStatus;
  previewUrl?: string;
  errorMessage?: string;
}

export type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; attachmentId: string; mimeType: string; url: string }
  | { type: 'document'; attachmentId: string; name: string; text: string };

export interface ChatMessage {
  role: ChatRole;
  content: string | MessageContentPart[];
}
```

保留 `string` 联合类型，确保现有纯文本消息不需要立即迁移。

## 7. 接口设计

### 7.1 上传附件

`POST /api/attachments`

使用 `multipart/form-data`：

- `file`：文件
- `ownerType`：`single` 或 `group`
- `ownerId`：员工 ID 或群 ID

返回：

```json
{
  "attachment": {
    "id": "att_xxx",
    "originalName": "候选人简历.pdf",
    "mimeType": "application/pdf",
    "sizeBytes": 184202,
    "category": "document",
    "status": "ready"
  }
}
```

### 7.2 查询附件

`GET /api/attachments/:id`

返回附件元数据和短期签名预览地址。不得返回永久公开存储地址。

### 7.3 删除附件

`DELETE /api/attachments/:id`

- 未发送附件可物理删除。
- 已发送附件默认软删除或拒绝删除。
- 删除数据库元数据时同步清理对象存储，失败应进入补偿任务。

### 7.4 聊天接口

扩展 `POST /api/chat`：

```json
{
  "employeeId": "employee_xxx",
  "model": "deepseek",
  "mode": "deep",
  "message": "分析这份简历是否适合招聘经理岗位",
  "messages": [],
  "attachmentIds": ["att_xxx"]
}
```

服务端处理顺序：

1. 校验消息至少包含文本或一个附件。
2. 批量加载附件并校验会话归属和状态。
3. 加载员工档案、已发布 Skill 和记忆。
4. 根据文件类型构建内容块。
5. 根据模型能力选择原生多模态或文本降级路径。
6. 调用 Model Gateway。
7. 将用户消息、模型回复和附件关联一起持久化。

## 8. DeepSeek 接入策略

不要假设所有 DeepSeek 模型都支持图片。增加集中式能力配置：

```ts
export interface ModelCapabilities {
  imageInput: boolean;
  nativeDocumentInput: boolean;
  maxImages: number;
  maxFileBytes: number;
}
```

能力来源优先级：

1. 环境变量或服务端模型注册表；
2. 代码内保守默认值；
3. 未知模型默认 `imageInput: false`。

推荐环境变量：

```env
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_IMAGE_INPUT=false
ATTACHMENT_MAX_FILE_MB=20
ATTACHMENT_MAX_COUNT=5
```

图片处理有两条路径：

- 原生视觉路径：仅当所选模型的官方 API 和实际联调均确认支持图片内容块时启用。
- 降级路径：图片先交给 OCR 或独立视觉模型生成描述，再把描述、OCR 文本和用户问题交给 DeepSeek 推理。

文档不依赖模型原生文件上传：PDF、DOCX、XLSX、CSV 和文本文件统一在服务端解析，再把相关片段传入 DeepSeek。

## 9. 文档解析策略

| 类型 | 处理方式 | 输出元数据 |
|---|---|---|
| PDF | 按页抽取文本；无文本时进入 OCR | 页码、段落 |
| DOCX | 抽取标题、段落和表格 | 标题层级、表格序号 |
| XLSX | 按工作表读取单元格，限制最大行列数 | 工作表、单元格范围 |
| CSV | 检测编码与分隔符，转成表格摘要 | 行号、列名 |
| TXT/MD | UTF-8 读取并按段落切分 | 段落编号 |
| 图片 | 原生视觉或 OCR/视觉服务 | 尺寸、OCR 文本 |

长文档处理：

1. 按页、标题或工作表切片；
2. 每片保存来源信息；
3. 根据用户问题选择相关片段；
4. 控制传给 DeepSeek 的总字符数；
5. 回答中尽量引用页码、工作表或行号。

第一期可先用关键词相关度选片，第二期再增加向量检索。

## 10. 前端交互设计

改造 `app/im-page.tsx` 中现有“＋”按钮：

- 点击选择文件；支持拖拽文件和粘贴截图。
- 输入框上方显示待发送附件卡片。
- 图片显示缩略图；文档显示图标、名称、大小。
- 展示上传、解析、成功、失败状态。
- 上传失败支持重试和移除。
- 允许只发送附件，不强制输入文字。
- 上传或解析未完成时禁止发送。
- 单聊和群聊复用同一套附件组件。
- 发送成功后附件显示在消息气泡中。
- 图片点击放大，文档点击预览或下载。
- 群聊提示文案改为“@成员 可指定谁分析文字和附件”。

建议拆出组件：

```text
components/chat/AttachmentPicker.tsx
components/chat/AttachmentDraftList.tsx
components/chat/MessageAttachments.tsx
components/chat/AttachmentPreview.tsx
```

不要继续把所有附件逻辑堆进已经较大的 `app/im-page.tsx`。

## 11. 安全要求

- 服务端同时校验扩展名、MIME 和文件头。
- 使用随机存储键，原始文件名仅作展示。
- 拒绝脚本、HTML、SVG、可执行文件和压缩包。
- 对文件数量、单文件大小和总请求大小限流。
- 私有对象存储，访问使用短期签名 URL。
- 校验附件归属，防止枚举或盗用 `attachmentId`。
- 图片移除不必要的 EXIF 信息。
- 文档解析设置超时、最大页数、最大行列数和最大解压尺寸。
- 附件文字只能作为用户内容，不能拼进 system prompt。
- 在系统提示中明确：附件中的指令不具备更高优先级。
- 日志不得打印附件正文、签名 URL、密钥或个人敏感信息。

## 12. 分阶段开发任务

### 阶段 A：存储与类型

1. 新增附件及消息关联表。
2. 新增附件 repository 和共享类型。
3. 实现本地开发存储适配器和生产对象存储适配器。
4. 新增上传、查询、删除接口。
5. 为上传接口补充类型、大小和归属校验测试。

验收：上传文件后能获得 ID，刷新页面后仍可读取元数据和受控预览地址。

### 阶段 B：聊天界面

1. 接通“＋”按钮。
2. 支持选择、拖拽、粘贴、上传进度、失败重试和移除。
3. 单聊和群聊发送请求携带 `attachmentIds`。
4. 消息气泡显示图片和文档附件。
5. 历史消息接口返回附件列表。

验收：纯文本功能不回归；附件可以独立发送；刷新后附件仍显示。

### 阶段 C：文档分析

1. 添加 PDF、DOCX、TXT、MD、CSV、XLSX 解析器。
2. 保存解析状态、文本和来源元数据。
3. `/api/chat` 加载附件并选择相关片段。
4. DeepSeek Adapter 接收文本化文档上下文。
5. 回答显示来源页码或工作表。

验收：上传简历 PDF 后，员工可基于实际内容回答，并给出来源位置。

### 阶段 D：图片分析

1. 实现模型能力表。
2. 联调当前 DeepSeek 模型的图片输入能力。
3. 若不支持，接入 OCR/视觉服务降级链路。
4. 对能力不支持、识别失败和超限给出清晰提示。

验收：上传截图后能描述关键内容；不支持视觉时不会把图片当作空文本发送。

### 阶段 E：生产化

1. 限流、对象存储权限和签名 URL。
2. 孤儿附件定时清理。
3. 上传、解析、模型耗时及失败率监控。
4. 数据库备份和幂等迁移演练。
5. Docker、Caddy 请求体大小和超时配置。

## 13. 测试清单

### 单元测试

- MIME、扩展名、文件头校验。
- 文件大小和数量限制。
- 附件归属校验。
- 模型能力路由。
- 文档切片和来源标记。
- 老的纯文本 `ChatMessage` 兼容。

### API 集成测试

- 上传 → 查询 → 发送 → 历史读取完整闭环。
- 单聊和群聊分别测试。
- 不存在、未就绪和越权附件返回正确状态码。
- 数据库失败时不产生孤儿对象。
- 对象存储失败时不产生错误的 ready 记录。

### UI 验收

- 桌面端和移动端选择文件。
- 拖拽与粘贴截图。
- 进度、失败、重试、删除。
- 图片预览与文档下载。
- 发送中重复点击保护。
- 群聊 `@成员` 与附件共同发送。

### 回归测试

- 纯文本单聊和群聊不受影响。
- Skill 选择、员工档案和上下文仍正常生效。
- 历史消息排序保持正确。
- 新建群、添加成员和 `@` 提示不回归。

## 14. 发布步骤

1. 备份生产 MySQL。
2. 先创建对象存储和最小权限密钥。
3. 配置生产环境变量，不提交真实密钥。
4. 执行幂等数据库迁移。
5. 部署新容器。
6. 使用小图片、小 PDF 和纯文本分别冒烟测试。
7. 观察错误率、上传耗时和模型调用成本。
8. 确认稳定后再提高文件大小或开放更多格式。

## 15. 可直接交给 DeepSeek 的开发提示词

### 总提示词

```text
你正在维护 D:\Myteam 项目。请严格依据 docs/MULTIMODAL_ATTACHMENT_DEVELOPMENT_PLAN.md 开发对话附件与多模态分析功能。

约束：
1. 不得破坏现有纯文本单聊、群聊、@成员、Skill、员工档案和消息排序。
2. 使用现有 Vinext/React、MySQL、Docker 和 Model Gateway 架构，不重写项目。
3. 原文件放对象存储，MySQL 只保存元数据、解析结果和消息关系。
4. 所有数据库变更必须幂等并兼容生产旧库。
5. 不得假设 DeepSeek 模型必然支持图片；使用能力配置和明确的降级路径。
6. 附件内容属于不可信用户输入，不允许覆盖 system prompt、员工身份或 Skill 指令。
7. 每完成一个阶段，运行类型检查、lint、测试和构建，并报告修改文件、测试结果和剩余风险。
8. 不要自动提交、推送或发布生产环境，除非用户明确授权。

先阅读相关代码并只实施“阶段 A：存储与类型”。完成验证后停止，等待下一阶段指令。
```

### 阶段 B 提示词

```text
继续依据 docs/MULTIMODAL_ATTACHMENT_DEVELOPMENT_PLAN.md 实施阶段 B：聊天界面。
复用阶段 A 的接口和类型，把现有对话框“＋”按钮接入附件上传。单聊与群聊复用组件，支持选择、拖拽、粘贴、进度、失败重试、移除和历史展示。保持纯文本功能完全兼容。完成类型检查、lint、测试和构建后停止。
```

### 阶段 C 提示词

```text
继续实施阶段 C：文档分析。支持 PDF、DOCX、TXT、Markdown、CSV、XLSX，保存来源页码、工作表或行号。长文档必须切片并按问题选取相关内容，不能整份无上限传给模型。将附件文本作为 user 内容交给 DeepSeek，不得拼入 system prompt。完成测试与构建后停止。
```

### 阶段 D 提示词

```text
继续实施阶段 D：图片分析。先通过官方接口文档和最小真实请求确认当前 DEEPSEEK_MODEL 是否支持图片输入，并记录验证结果。实现模型能力表；支持时走原生多模态，不支持时使用可配置 OCR/视觉服务降级。未知模型默认不支持图片。失败时向用户显示明确错误，不得静默发送空内容。完成测试与构建后停止。
```

### 阶段 E 提示词

```text
继续实施阶段 E：生产化。完善权限、限流、签名 URL、孤儿附件清理、日志与监控，并检查 Docker/Caddy 上传大小和超时。生成生产迁移与发布检查表，但不要连接或修改生产环境。完成全量测试和构建后给出发布风险清单。
```

## 16. 完成定义

只有同时满足以下条件才算完成：

- 单聊和群聊可以上传、发送、展示并重新读取附件。
- 图片或文档确实进入分析链路，不只是作为下载链接保存。
- DeepSeek 不支持某种内容时有明确且可操作的反馈。
- 文件和消息关系持久化，刷新或重启后不丢失。
- 附件访问受权限控制，不能通过猜测 ID 获取他人文件。
- 老消息和纯文本聊天保持兼容。
- 类型检查、lint、测试和生产构建全部通过。
- 数据库迁移可重复执行且不覆盖现有数据。
