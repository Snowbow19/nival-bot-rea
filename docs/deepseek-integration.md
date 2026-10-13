# DeepSeek 对话与群聊

## Context

本地网页保留 Grok Bot 0.70.2 的渲染层。DeepSeek 官方 Chat Completions API 提供模型推理；本机服务持有 API Key，浏览器只调用同源 `/api/chat`。工具调用由本机服务执行；Notion 与日历通过独立连接授权。云电脑不参与执行。

## Object

一个 Bot 对话；群聊是带 `isGroup: true` 和 `memberIds` 的同类对象。

## Attributes

| 字段 | 类型与边界 |
|---|---|
| Bot id | 非空字符串，新对象生成 UUID |
| name / description | 角色名称和说明；发送模型时分别限制为 100 / 12000 字符 |
| memberIds | 已存在 Bot id 数组；模型调用排除已删除成员与嵌套群聊 |
| MODEL_NAME | 本机配置；当前连接 `deepseek-flash` |
| 模型密钥 | 仅保存在本机 `.env`，权限 0600；不传入前端、模型上下文或压缩包 |
| 对话历史 | 每个对话独立；请求保留最近 100 条消息，总字符上限 250000 |
| 群聊回复 | 原版 `send-message`，`message.type=text`、`message.content`、`author.id/name` |
| 用量 | DeepSeek 返回的 usage 附在对应回复上；未生成到的内容不伪造 |

## States

- **idle → generating**：`sendPrompt` 接受有效文本，创建 AbortController，发布原版 roster 工作状态。
- **generating → streaming**：收到 SSE content 增量，更新原版消息气泡。
- **streaming → idle**：收到 done，保存模型与用量，发布已回复状态。
- **generating/streaming → stopped**：点击停止或离开页面，取消浏览器请求；服务端连接关闭触发上游取消。群聊后续成员不再启动。
- **generating/streaming → failed**：鉴权、余额、限流、网络或协议错误；保留已收到文本并显示错误。错误提示不作为模型的历史回答继续发送。
- 同一对话互斥执行一轮；不同 Bot 可以各自运行。Bot 的配置与消息跨刷新保存；进行中的请求不跨刷新续跑。

## Behaviors

| 行为 | 输入与前提 | 执行结果与事件 | 返回值 |
|---|---|---|---|
| createAgent | 原版创建表单参数 | 新建 Bot，自动继承全局 DeepSeek 连接；独立角色、历史与草稿 | `{agent, activeAgentId, transcript}` |
| createGroup | 原版 `memberAgentIds`、名称、描述 | 转为 UI 所需 `memberIds`，保留原版选择器、群头像与成员列表 | 同上 |
| sendPrompt | 有效 Bot、非空文本、没有正在执行的同一对话 | 保存用户消息，发布工作状态，逐字写入回复，完成后保存 | `{accepted:true}` |
| 群聊一轮 | 有至少一位有效 Bot 成员 | 按成员顺序调用 DeepSeek；后续成员读到群聊前文，以自己的角色发言 | 每位成员独立 `send-message` |
| interruptAgentRun | 存在活动轮次 | 中断当前连接，保留部分回复，停止后续成员，恢复 idle | `{interrupted:true}` |
| setGroupMembers | 已存在群聊和成员 id | 更新本地成员列表并刷新原版 roster | 更新后的群聊 |

群聊的逐成员执行规则是本地后端实现。原版云端如何自主选择成员、后台调度和执行工具，未从前端包中恢复，不能据此前端复现宣称后端等价。

## REA 与原版协议依据

源 ASAR 摘要：`8dd7b6c4a58439d626a9a7b3766982b7c725db2bc1f6ff68a29fc1ec62ca4cf7`。

- 全包分析：`ev_5e043f13724e2ea834912bb41e552d7f545518afe79187a3a136eed470506c05`。
- 新建聊天模块视图：`ev_456aa23b4d0636a550c84823abbf5291996962b66b24832b8055329ba3ad174b`，视图范围内完整。
- 模块节点追踪：`ev_684e6f0f5c509940fc080347e4e6d0cfcbf5ae3dff0f26ff1989223801912945`，1 个种子、3 个节点、2 条边；源图与追踪仍为 partial，不构成完整语义证明。

从 REA 提取物直接核对的实现位置：

- `app/assets/index.eager-app-fbmFpqqH.js` 的 `sje`：群聊创建传递 `memberAgentIds`，支持已有 Bot 与临时创建 Bot。
- 同文件的 coordinator 方法表：`createAgent`、`createGroup`、`setGroupMembers`、`sendPrompt`、`interruptAgentRun`。
- `app/assets/index-CjjO5fU0.js` 的 `Bl`、`Av`、`Mf`：`send-message.author` 决定成员分组、头像与发言姓名。
- `app/assets/chunk-view-BIq_98l4.js`：文字消息读取 `message.content`，流式状态读取 `streaming`。

原版 UI 继续处理创建、成员选择、聊天切换、消息菜单和气泡。桥接层负责后端数据与模型请求；停止按钮放在未被原版 `overflow: clip` 裁剪的输入表单层。

## 已验证

- DeepSeek `/models` 鉴权成功。
- 新建 Bot 未进行第二次密钥配置，首次提问得到 `23 × 17 = 391`。
- 刷新后追问，正确找回前文的 `青禾-7319`。
- 原版群聊选择器创建两位成员的群聊，收到两次真实 DeepSeek 回复，分别按原型设计师与写作伙伴角色发言。
- 本地模拟流的群聊中断：点击停止后上游连接关闭，仅产生 1 次请求，没有启动第二位成员；原先已收到文本仍保留。
- 4 项针对性检查通过：角色与群聊上下文、SSE 分片与中文、鉴权错误脱敏、停止请求关闭上游。

真实模型验证与本地模拟流验证分别记录，不把模拟输出当作 DeepSeek 输出。本轮已新增真实工具循环、服务端持久化与例行任务执行器；外部连接状态及新增功能验证见 `capability-map.md` 和 `../evidence/capabilities-verification.json`。云电脑没有实现。

接口依据：[DeepSeek 官方文档](https://api-docs.deepseek.com/api/create-chat-completion)。
