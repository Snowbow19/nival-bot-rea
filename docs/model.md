# UI 与本地适配层模型

## Context

运行于本机 127.0.0.1 的浏览器页面。原版 Electron renderer 依赖的 `desktop` 与 `coordinatorPort` 由本地 JavaScript 提供。原生主进程、用户账户数据库和云端执行器不运行。

全局约束：页面网络访问限制在同源；模型请求仅由显式配置的本地服务器转发。界面可见不等于后端能力可用。以下状态模型用于副本的适配层；原版未观察路径不推断为已验证。

## Object

一个 Bot 对话工作空间，包含 Bot 属性、对话状态以及用户操作。

## Dimensions / Details

### Attributes

| 属性 | 类型／单位 | 边界与约束 |
|---|---|---|
| id | string | 本地新 Bot 使用 UUID，关联记录按 id 索引 |
| name / description | string | 来自配置或用户编辑；显示文本不作为 HTML 执行 |
| isGroup | boolean | true 时按 memberIds 表示群聊成员 |
| memberIds | string[] | 对应已有 Bot 的 id；用户可通过原版界面选择 |
| createdAt / updatedAt / timestampMs | number，Unix 毫秒 | 来自本地 Date.now()；不是服务器时间 |
| avatarShape / avatarColor | string | 沿用原版形状与色板枚举，原版选择器提供合法选项 |
| theme | light / dark / system | 通过原版设置选择；当前 system 在适配层解析为 light |
| language | 原版语言枚举 string | 默认 zh-CN；界面按原版语言包解析 |
| transcript | message[] | 顺序编号 seq；角色 user 或 assistant；本地持久化 |
| routine.isEnabled | boolean | 仅修改本地配置，不启动系统定时器 |

### States

| 状态空间 | 触发与转换 | 互斥／共存 | 生命周期 |
|---|---|---|---|
| 未选择 / 选中 Bot | 点击列表、新建完成 | 同一主聊天区只选一个 Bot | 选择通过原版持久化协议恢复 |
| 详情关闭 / 详情 / 资料库 / 电脑 | 标题按钮、关闭、标签切换 | 详情标签互斥，和聊天共存 | 面板宽度与选择保存在本地 |
| 输入 / 发送中 / 已接受 / 消息到达 / 失败 | Enter → sendPrompt → 回复与 transcript 事件 | 原版发送队列处理；服务失败可与历史消息共存 | 单次请求；消息长期本地保存 |
| 例行任务启用 / 暂停 | 开关 → setAgentAutomationEnabled | 两态互斥 | 跨刷新；无后台执行生命周期 |
| 普通界面 / 设置 / 应用市场 / 搜索 / 创建 | 菜单与按钮触发 | 原版 overlay 管理互斥与叠层 | 窗口关闭后回到原聊天 |
| 浅色 / 深色 | 设置 → theme-changed | 互斥 | 跨刷新保留 |

### Behaviors

| 操作 | 输入与前提 | 执行后的修改／事件 | 返回值 |
|---|---|---|---|
| createAgent | 名称、描述等 spec；UI 处于创建流程 | 新增 Bot、空 transcript、保存、server-roster-changed | `{agent, activeAgentId, transcript}` |
| updateAgent | 已存在 id 与 patch | 更新属性、updatedAt、保存、刷新 roster | 更新后的 Bot |
| sendPrompt | 已选 Bot、非空文本；附件传输未实现 | 保存 user 消息，发 transcript snapshot；可选请求模型，再保存 assistant 消息 | `{accepted:true}` 表示本地接受 |
| openAgentTail | 已存在 Bot id | 读取本地消息，不访问原账户 | `{entries,nextBeforeSeq:null,cloudAgentPeerIds:[]}` |
| setThemePreference | 主题枚举 | 修改偏好，保存，发 theme-changed | 主题状态 |
| setLanguagePreference | 语言枚举 | 修改偏好，保存，发 language-changed | 语言状态 |
| setHostPinnedAgents | Bot id[] | 修改置顶数组并保存 | 新数组 |
| setHostSidebarSections | 分组数组 | 修改分组并保存 | 新数组 |
| setAgentAutomationEnabled | Bot id、任务 id、boolean | 修改本地例行任务配置并保存 | 当前任务列表 |
| read/writeClientPersistence | string key / string value | 读取／写入当前副本的 localStorage | 值或 void |

原版 coordinator 使用版本 3 的消息帧：hello/ready → request(requestId, method, args) → reply(outcome)，并通过 event(family, payload) 推送变化。本地适配层遵守这一结构；136 个方法的返回容器类型保存在 `evidence/coordinator-reply-types.json`。容器兼容不代表全部方法的业务实现完成。
