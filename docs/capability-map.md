# Grok Bot 0.70.2 非云电脑能力核对

## 本轮实现结果

已实现真实 DeepSeek 多轮工具调用、本机原子持久化与前端同步。下方“当前基线缺口”是修改前的审计记录。

| 能力 | 当前实现与证据 |
|---|---|
| 聊天创建群聊 | 真实创建“产品协作”，两位成员保存并在原版侧栏出现 |
| 长期记忆、技能、任务 | 真实保存并读回；新一轮从记忆生成项目代号文件 |
| 文件生成、预览、下载 | “接口资料.md”原版卡片中文名及大小正确；浏览器预览与下载成功 |
| 文本附件 | 原版暂存、提交、模型读取链路实测得到文件内代号和数量 |
| 网页 | WebSearch/WebFetch 执行器已实现；公开搜索和 DeepSeek 官方文档读取验证通过 |
| 例行任务 | 单次、每日、间隔调度，互斥执行、取消和结果记录；单次真实模型运行一次后自动停用 |
| MCP | 官方初始化、工具发现、调用与授权凭据隔离；外部写入生成确认页面 |
| Notion / 日历 | 独立连接页；实际账户读取验证记录在能力验收 JSON，不以界面状态代替读取成功 |

## Context

来源为 REA 已提取的发布版 renderer、coordinator 协议表和当前本地适配层。此清单记录 2026-10-13 的静态核对；旧运行记录只证明当时验证过的路径，不证明本轮改动通过。云电脑排除在当前实现范围之外。第三方账户、搜索供应商、语音和图像生成服务需要各自有效连接，不能由一个 DeepSeek Key 自动获得。

## Object

一个能够调用工具并持久保存结果的 Bot 工作空间。

## Attributes

| 属性 | 类型、单位和边界 | 原版证据 |
|---|---|---|
| Bot identity/profile | `id/name/description/avatarShape/avatarColor: string`；`memberIds: string[]`；`isGroup: boolean`；成员必须指向有效 Bot | `app/assets/index.eager-app-fbmFpqqH.js:59136`，`:59159`；创建参数名为 `memberAgentIds`，渲染字段名为 `memberIds` |
| 时间 | `createdAtMs/updatedAtMs: number`，Unix 毫秒；状态层映射为 `createdAt/updatedAt` | 同文件 `:59159` |
| 记忆 | 模板至少携带 `content: string, createdAt?: number`；`UpdateMemory` 写入参数包含 `action: write, tier: log` | 同文件 `:29877`、`:29909`；完整云端 memory schema 未恢复 |
| 技能 | `name/description/content: string, files?: array`；按 Bot 归属 | 同文件 `:15521`；原版提供 add/update/remove API |
| 文件库 | `agentId, fileName, contentType: string; bytes: Uint8Array`；删除按 `name` | 同文件 `:15559`；必须实际存储并重新读取 |
| 附件 | 草稿 `path/name`，提交 `paths/filenames/progressKey`；发送日志区分 `stagedPath/committedPath` | 同文件 `:65248`、`:68957` |
| 例行任务 | `id/name/trigger/isEnabled/createdAt/runs`；支持 cron、一次性和外部事件的 UI；时区通过 `Intl.DateTimeFormat` 验证 | 同文件 `:26200`、`:28651`、`:47500` 至 `:47675`；不要把所有 UI trigger 当作已实现执行器 |
| 普通任务 | `id/name/description/status/updatedAtMs/unreadEntryId`；原版明确 `status=open|done` | 同文件 `:11419`；任务工作状态另由活动运行推导 |
| MCP 插件 | `pluginId` 或 inline `name/displayName/description/mcpConfigJson`；变量支持 string/number/boolean；工具可逐项禁用 | 同文件 `:15501`；`evidence/coordinator-reply-types.json` |

## States

| 状态空间 | 事件触发与转换 | 互斥、共存与生命周期 |
|---|---|---|
| Bot idle / thinking / tool-running / streaming / waiting-for-user / failed | 用户消息→模型；`tool_calls`→真实执行→工具结果→模型续答；取消或错误终止当前 run | 同一 Bot 一轮互斥；记忆、文件、技能跨轮保存；活动状态不能代替执行成功 |
| 任务 open / done | 创建或继续任务→open；`markAgentTaskDone`→done；read 只清未读信息 | 完成与未读为独立维度；原版保留最近完成任务的展示窗口约 72 小时，不能据此删除底层历史（`:11420`） |
| 例行任务 enabled / paused；run awaiting / running / terminal | 开关修改配置；测试按钮调用 `runAgentAutomationNow`；收到新 run 才转 running | 是否启用与当前运行可共存；原版用 run ID 关联完成，避免点击即假成功（`:47659`） |
| 附件 staged / committing / committed / failed | 选择文件→暂存→提交到 Bot/session→进度事件→发送 | 提交与发送要关联 nonce；不能仅把文件名送入 prompt 当作读过内容 |
| MCP installed / needs-auth / connected / error | 安装→OAuth/配置→认证成功；失效后回到 needs-auth/error | 安装与连接是不同状态；模板引导明确先查安装状态，再认证（`:29905`） |

## Behaviors

| 行为与输入 | 前提 | 执行后变化、事件与返回值 | 当前基线缺口 |
|---|---|---|---|
| 创建 Bot / 群聊：name、description、memberAgentIds | 名称有效；成员存在 | 新增 roster、空对话；返回 agent/activeAgentId/transcript；发 roster 事件 | 手动 UI 已有；模型端没有工具，不能通过聊天创建 |
| 更新 Bot / 成员：id、patch | 目标存在 | 更新 profile/memberIds；持久化→roster 刷新 | 没有模型工具入口 |
| 记忆：write/search/read/delete | Bot 有效；内容不得跨 Bot 混用 | 独立持久存储；后续轮次读取 | 没有独立记忆存储；历史窗口不是长期记忆 |
| 技能：name、description、content | Bot 有效 | 持久保存技能；按需读取并加入模型上下文；返回保存条目 | workflow 有简化 CRUD，不等于完整技能 API；`skillsCatalog` 固定空 |
| 文件库/附件：bytes、filename、mime | 合法类型和大小；实际可解析 | 保存、提取文本、关联 Bot、读回；返回文件记录 | `getGrokBotAgentFiles` 与原版实际 `listGrokBotAgentFiles` 名称不一致；上传没有实现 |
| 任务与例行任务 | 目标 Bot、合法时间/时区/trigger | 保存任务；立即执行或到期运行；更新 runs/status；事件卡片 | CRUD 只有本地配置，runNow 明确抛出未连接服务；任务 API 多为空返回 |
| WebSearch / WebFetch | 搜索供应商或可访问 HTTP(S) URL | 返回真实正文/来源/错误；活动标识 searching/browsing | 原版存在工具活动 UI，副本没有执行器 |
| MCP 发现/认证/调用 | 已安装可用服务、有效账户、允许工具 | tools/list→模型工具列表；调用→实际结构化结果；认证状态刷新 | MCP 状态固定空；返回 `{}` 或 undefined 会误导界面 |
| send-message、请求用户表单、草稿确认 | 对应内容种类合法 | 原版卡片按 message.type 渲染；执行审批需对应真实待处理请求 | 卡片资源存在，不代表后端流程存在 |

## 精确根因与实现顺序

1. `tools/model-service.mjs:66` 在本次核对的基线明确声明没有执行工具；请求只传 messages，没有 tool-calling loop。这是截图中“不能创建群聊”的直接原因。先打通 DeepSeek `tools → tool_calls → 执行 → role=tool → 续答`，不能只改提示词。
2. 第一组工具复用已有真实 bridge：列出/创建/修改 Bot，创建群聊、管理成员、列出/搜索聊天。成功结果必须包含可回查的 id，写入后刷新原版 roster。
3. 然后补独立记忆、技能、任务和文件存储；工作流 body 不应无条件全部拼成系统指令。任务与例行任务的返回数据须符合原版视图；`runNow` 必须实际调用模型并产生 run 记录。
4. 附件走原版暂存/提交协议，解析失败返回错误。长期资料库与一次性消息附件分开记录。
5. 再接网络工具与自定义 MCP；已安装、已认证、已列工具、已执行各自验证。没有第三方授权时保持未连接，不能把 UI 可见当作可用。

## 静态证据和运行证据边界

- 已核对的原版工具活动名称：`WebSearch/WebFetch/Read/Skill/GenerateImage/GenerateVideo/Task/CreateAgent/UpdateAgent/SendToAgent/CallMcpTool/UpdateMemory/UpdateSkill/UpdateRoutine`，来源 `app/assets/index.eager-app-fbmFpqqH.js:25182` 至 `:25334`。这些是名称和 UI 映射，未获得完整云端实现。
- REA 全包摘要与群聊追踪在 `evidence/rea-application.json`、`evidence/rea-group-module-view.json`、`evidence/rea-group-node-trace.json`；原 coordinator 返回容器表在 `evidence/coordinator-reply-types.json`。容器表只约束类型。
- 先前运行证据记录 DeepSeek 单聊、上下文恢复、群聊多成员和停止生成，见 `evidence/deepseek-verification.json`、`evidence/group-cancel-verification.json`。本轮未重复运行这些验证。
- 仍未知：原版云后端任务调度、成员选择算法、记忆检索与压缩、插件权限服务、团队分享、账号同步、媒体模型和发布服务。当前工程应实现自己的等价产品能力，不能宣称恢复了这些服务。
