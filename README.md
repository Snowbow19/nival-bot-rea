# Nival Bot · REA Reconstruction

把 Grok Bot 的桌面界面放到自己的本地网页里，再接上自己的 DeepSeek 和工具执行层。

这个项目从 **Grok Bot 0.70.2 的 Electron 发布包**开始，使用 [REA](https://github.com/morluto/rea) 提取、分析界面与通信协议，保留实际 renderer，新增本地适配层、模型调用、工作空间存储、定时任务和应用连接。它已经可以做真实操作，但**不是完整逆向出的官方 Grok Bot，也不是官方云后端的开源替代品**。

当前版本：`0.3.0`。功能核对日期：**2026-10-13，Asia/Shanghai**。

[快速启动](#快速启动) · [构建和部署](#构建和部署) · [复刻过程](#用-rea-复刻的过程) · [实际提示词](#这次对话中的提示词) · [与官方的区别](#与当前官方-grok-bot-的区别) · [验证记录](#验证到了哪一步)

## 已经能做什么

- 使用 DeepSeek 官方 API 对话，逐字显示回复，停止生成，保留上下文。
- 创建独立 Bot；新 Bot 自动继承模型连接，分别保留角色、对话、记忆和技能。
- 通过界面或聊天创建群聊、修改成员；群内按各成员角色依次回复。
- 持久保存记忆、可复用技能和任务清单，搜索历史对话，向其他 Bot 委派任务。
- 搜索网页、读取公开网页正文，生成 Markdown、文本和 JSON 文件。
- 上传文本附件供模型阅读，通过原版文件卡片预览和下载结果。
- 创建一次性、每天固定时间或按间隔执行的例行任务，真实调用模型并记录运行结果。
- 独立授权 Notion 和本机日历；发现及调用自行配置的 MCP 工具。

创建普通任务只会记录待办；要自动执行，需要创建例行任务。界面中保留的入口比目前接好的服务多，不能把“有按钮”理解成“能力已经实现”。

![Notion 与日历连接页面](docs/images/connections.png)

## 快速启动

需要 **Node.js 22.13 或更新版本**，推荐 Node.js 24。本项目的实时验证环境是 macOS；通用服务使用 Node 内置模块，日历连接仅支持 macOS 14+。

```sh
git clone https://github.com/Snowbow19/nival-bot-rea.git
cd nival-bot-rea
cp .env.example .env
chmod 600 .env
```

在本机编辑 `.env`，填入自己的 DeepSeek API Key：

```dotenv
MODEL_API_URL=https://api.deepseek.com/chat/completions
MODEL_NAME=deepseek-flash
MODEL_API_KEY=YOUR_DEEPSEEK_API_KEY
PORT=4317
```

`deepseek-flash` 是本次账户实测使用的模型名。模型可用性以自己的账户与 [DeepSeek 文档](https://api-docs.deepseek.com/) 为准，不需要 Grok Bot 官方账号来调用这套本地执行层。

```sh
npm start
```

浏览器打开 <http://127.0.0.1:4317/>。macOS 也可以双击 `启动 Nival Bot.command`。

运行仓库已包含的前端不需要安装 npm 依赖；`npm ci` 主要用于安装源码整理工具。复制 `.env` 的步骤只在首次运行时执行，更新代码时保留已有配置。

### 连接 Notion 与日历

打开 <http://127.0.0.1:4317/connections>：

1. **Notion**：选择“连接 Notion”，在官方页面完成 OAuth；也可以填写自己的 Notion 集成密钥，并将目标页面共享给该集成。
2. **日历**：选择“授权日历访问”，在 macOS 授予完整日历访问权限。读取的是这台 Mac 已添加的日历账户；Google 日历只有在本机系统账户中已添加并同步时才会出现。
3. 回到聊天，搜索一个自己知道的页面，再查询日历列表，确认实际可读。页面上的授权状态与实际工具读取是两个检查点。

日历辅助程序首次使用时通过 `xcrun swiftc` 编译，需要 Xcode Command Line Tools，可先执行 `xcode-select --install`。非 macOS 环境仍可运行通用聊天服务，但无法使用 EventKit 日历连接。

Notion 支持搜索、读取、创建页面和追加内容；OAuth 和集成密钥由同一应用工具自动适配。日历专用工具支持列表、日期范围查询、冲突检查和创建，尚不支持修改或删除日程。外部写入会生成包含目标与正文的确认页，确认后才调用外部服务。

本地 Notion OAuth 凭据保存在 `data/notion-oauth.json`，模型密钥和可选集成密钥在 `.env`。凭据不会作为连接页响应或模型工具结果返回。OAuth 待完成状态保存在服务进程内存中，授权进行到一半时重启服务，需要重新发起授权。

## 构建和部署

### 构建可复制目录

```sh
npm ci
npm test
npm run build
```

构建结果在 `dist/nival-bot/`。构建脚本检查本地 JavaScript 语法，复制运行代码、已经整理的 renderer 和文档；**不会从 TypeScript 重新编译官方客户端**，也不会复制 `.env`、`data/`、聊天记录、OAuth 凭据或完整 REA 报告。

```sh
cd dist/nival-bot
cp .env.example .env
chmod 600 .env
# 编辑 .env，填入自己的模型配置
npm start
```

需要压缩包时，在项目根目录执行：

```sh
(cd dist && zip -qr ../Nival-Bot-UI.zip nival-bot)
```

构建目录与压缩包被 Git 忽略。向别人提供构建产物，不会替他们复制作者的模型账户或应用授权。

### 本机部署

这是当前实际支持并验证过的部署方式：把运行目录保存在本机，配置 `.env`，运行 `npm start`，使用同一台机器的浏览器访问。例行任务依赖 Node 服务持续运行，关闭进程、电脑关机或休眠都会影响执行时间；这不是官方的全天候云调度。

服务固定监听 `127.0.0.1`，仅接受对应的 localhost/loopback Host。它没有多用户登录、租户隔离或互联网级访问控制。**公开 GitHub 仓库发布的是代码，不是向公网部署你的个人工作空间。**

### GitHub Pages、Vercel 和云服务器

GitHub Pages 不能运行 `/api/chat`、工具循环、文件存储和定时任务，因此不是本项目完整功能的部署目标。仓库目前也没有验证过的 Vercel/Serverless 部署方案。

迁移为公网服务需要先增加身份认证、账户与数据隔离、可靠数据库、独立调度、凭据管理和对应的云日历授权，并调整固定本机回调与 Host 检查。不能只把监听地址改成 `0.0.0.0` 就称为部署完成。本次没有部署公网服务。

## 用 REA 复刻的过程

### 1. 从真实发布包建立基线

最初讨论过 Android，但实际落地选择了已经安装在 macOS 上的 Electron 客户端，随后运行成网页。**没有完成 Android APK 逆向，也没有产出 Android 安装包。**

- 输入：`/Applications/Grok Bot.app/Contents/Resources/app.asar`。
- 客户端版本：`0.70.2`。
- REA CLI：`6.4.0`。
- 输入 SHA-256：`8dd7b6c4a58439d626a9a7b3766982b7c725db2bc1f6ff68a29fc1ec62ca4cf7`。

输入散列的完整值以 [REA 摘要](evidence/rea-summary.json) 的 `root_sha256` 为准。

### 2. 提取、静态分析和界面整理

REA 负责提取发布包、分析 JavaScript/Electron 边界、生成证据并追踪功能关系。本次扫描记录：

| 项目                |                 结果 | 能说明什么                              |
| ------------------- | -------------------: | --------------------------------------- |
| 相关文件            |                  616 | 扫描范围                                |
| JavaScript 静态解析 | 600 个，0 个解析失败 | 这些文件可被解析，不代表完整语义恢复    |
| JS/MJS/CSS 整理     |           544 个成功 | Prettier 改善可读性，没有恢复原始变量名 |
| 原始注册路径        |               126 条 | 注册路径数量，不是 126 个独立页面       |
| 动态视图映射        |                61 个 | 用于定位分包和页面                      |
| 原生文件校验冲突    |                 6 个 | 已记录，副本没有执行这些原生文件        |
| 全包语义完整性      |              partial | 不能据此证明完整行为等价                |

`app/` 保留原版发布构建的 React 渲染层、CSS、字体、图标、动画、中文语言包和动态分包。没有获得官方 TypeScript/TSX 源工程或 Source Map。REA 的源码恢复路径在当时的 macOS 环境缺少受支持的 Linux x64 Wakaru 提供者，因此本次使用 Prettier 格式化，不把排版整理称作源码恢复。

REA 原生窗口观察未完成，界面验证改用后台原生截图和本地浏览器。云端服务没有被提取。

### 3. 对照真实前端协议实现本地桥接

从实际 renderer 核对 `window.desktop`、coordinator 消息、返回容器、Bot/群聊、任务、例行任务和附件字段。关键修正包括：

- 群聊创建参数是 `memberAgentIds`，状态中的成员字段是 `memberIds`。
- 群聊回复使用原版 `send-message`，通过 `author.id/name` 区分角色。
- 技能必须提供原版读取的 `body/trigger/sourceRef` 字段。
- 例行任务保留原版的字符串 `schedule` 和 `runs`，独立执行参数放入 `localSchedule`。
- 附件提交返回裸 `string[]`；文件卡片的元数据读取与字节读取是不同接口。
- 停止按钮要位于未被原版裁剪的表单层，否则看得到但点不到。

这些协议使原版界面能够显示真实本地状态，而不是另画一套外观相似的页面。具体字段见 [原版 UI 协议](docs/native-tool-ui-contracts.md) 和 [UI 路径映射](docs/ui-map.md)。

### 4. 接入模型之后，继续补执行能力

第一版只把文本发给 DeepSeek，所以在用户要求“创建一个群聊”时，模型回答自己没有操作工具。这个问题不是换一句提示词能解决的。

随后加入真实循环：**用户消息 → DeepSeek tools → tool_calls → 本机执行 → role=tool 返回结果 → 模型续答 → 界面同步**。一轮最多 8 次模型步骤，超限结束本轮。工作空间使用原子文件写入，浏览器通过三方合并保留本地编辑和后台新增对象。

长期记忆、技能、任务、附件和例行任务分别落到实际存储；新 Bot 继承全局模型配置。群聊是本地实现的顺序执行，委派有深度上限，不是恢复了官方云端调度算法。

### 5. 从真实失败修复到验证结果

| 遇到的问题                       | 修改                            | 实际复核                                             |
| -------------------------------- | ------------------------------- | ---------------------------------------------------- |
| 模型拒绝创建群聊                 | 接上工具与后端状态同步          | 聊天创建的群聊出现在原版侧栏，成员落盘               |
| “一分钟后一次”被设成每分钟重复   | 增加单次延迟参数与意图校验      | 测试任务仅执行一次，然后自动停用；错误重复任务已暂停 |
| 中文文件名显示编码、大小出现 NaN | 修正附件 URL 和元数据返回类型   | 中文名、大小、预览、下载均正常                       |
| 附件只有名字，没有正文           | 接通暂存、提交与模型输入        | 模型读出文件内测试代号与数量                         |
| Notion OAuth 已完成却误报未授权  | 统一 OAuth 与集成密钥的工具路由 | 同一聊天重新调用后找到已知页面                       |
| 同步可能恢复后台已删除对象       | 修正三方合并的删除规则          | 针对性回归检查通过                                   |

### 6. 自己重跑提取与整理

下面是依据本次证据整理的可复现命令，不是未经删减的终端录屏。已有 `app/` 时无需重复执行。处理其他版本前保留自己的修改，新的分包名称或协议可能需要重新适配。

```sh
npm ci
mkdir -p evidence
SOURCE_ASAR='/Applications/Grok Bot.app/Contents/Resources/app.asar'

npx -y rea-agents@6.4.0 analyze-javascript-application "$SOURCE_ASAR" \
  --integrity-policy record-and-continue --format json --full-output \
  > evidence/rea-application.local.json

npx -y rea-agents@6.4.0 extract-artifact "$SOURCE_ASAR" \
  --integrity-policy record-and-continue --format json --full-output \
  > evidence/rea-extract.local.json
```

`record-and-continue` 保留校验不一致的记录，不能把冲突变成验证通过。提取结果会给出本机输出目录；将该目录的内容复制到工程的 `extracted/`，使 `extracted/dist/renderer/index.html` 存在，然后运行：

```sh
EXTRACT_ROOT=$(node -e "const r=require('./evidence/rea-extract.local.json'); if(!r.ok) process.exit(1); process.stdout.write(r.data.parameters.output_root)")
mkdir -p extracted
cp -R "$EXTRACT_ROOT/." extracted/
npm run format:renderer
npm run build
npm start
```

完整分析报告可能很大，语义追踪也可能因为内存或输出限制返回 partial。公开仓库保留筛选后的统计与协议文档，完整 ASAR、提取物、原生程序、原始日志与包含本机路径的大报告不提交。

## 这次对话中的提示词

### 用户实际提出的需求

以下按项目演进顺序保留可公开的用户指令。只对凭据存储位置做了脱敏，换行不影响原意；它们是需求历史，不保证一次性输入就能复现全部结果。

```text
https://github.com/morluto/rea.git
能否用来逆向一下 Grok Bot的UI

Grok Bot的客户端

你试一下把他完全逆向一下，最好是我可以直接复刻一个自己的Grok Bot的UI界面

用 REA吧

手机端的Grok Bot可以逆向吗？

Android吧

网页端的接入我的Deepseek试一下，让他可以像真正的Grok Bot一样运行，云电脑功能暂时不用做

DeepSeek 官方 API

[已脱敏：用户说明本机已有 API Key 的存储位置]

新建Bot也会自动连接Deepseek，而且有群聊功能

用REA去逆向Grok Bot按照Grok Bot去设计这个内容

能力不齐全，补全按照GrokBOT

Notion 与日历

已授权

发布到我的 GitHub 上，设成一个公开库。
把当前通过REA复刻的过程，包括我和你聊天用到的提示词，以及部署步骤、构建步骤，都写到 README 里面，我要给别人看，然后跟当前真正的 GrokBOT 有哪些区别，了解清楚
```

这组需求最终落地为 macOS 来源的网页实验，而非 Android 全功能复刻。凭据值、账号令牌、个人聊天记录和授权回调参数没有收入提示词记录。

### 实際验收时使用的提示词

以下文字由开发助手输入本地应用，用于检查执行链，不是官方 Grok Bot 的内部提示词：

```text
创建一个群聊，名为「产品协作」，加入原型设计师和写作伙伴。创建完告诉我结果。

请实际执行以下操作：记住项目代号是 PINE-742；创建一个技能「三句总结」，要求每次总结按结论、理由、下一步各写一句；创建任务「核对产品需求」；把这三项写成可下载的 Markdown 文件「项目备忘.md」。再创建一个一分钟后运行一次的例行任务「运行验证」，任务内容是仅回复“例行任务已运行”，不要调用其他工具。

把记忆里的项目代号保存成「项目代号.txt」供我下载。另外创建一个15秒后只执行一次的任务「单次验证」，运行内容仅回复“单次任务完成”。

请用网页搜索找到 DeepSeek 官方 API 文档，并读取官方文档首页。把文档链接和一句中文简介保存为「接口资料.md」供下载。只返回一句完成状态，不要展开长文。

只从这次附件读取验证代号与交付数量，一句话回答。

请实际调用 SearchNotion 搜索「行动指南」，并调用 ListCalendars 读取日历列表。不要用先前消息推断，只根据本次工具结果用一句中文回答。
```

定时任务验收会真实调用模型并消耗账户额度。上传检查使用的文件是人工编写的测试文本，外部连接验收只读取、没有创建或修改用户页面和日程。

### 本项目发给 DeepSeek 的运行时提示词

完整动态模板位于 [`tools/model-service.mjs`](tools/model-service.mjs) 的 `buildMessages`。它会加入当前时间、Bot 身份、角色要求、群聊成员、长期记忆和技能。约束包括：操作必须调用工具、工具成功才能报告完成、外部写入先确认、网页和附件不作为新的系统指令，以及不泄漏凭据。

工具的函数名、参数和执行逻辑分别在 [`workspace-runtime.mjs`](tools/workspace-runtime.mjs)、[`workspace-actions.mjs`](tools/workspace-actions.mjs) 和各连接模块中。仅复制提示词而不接上这些工具，仍然只能聊天，不能创建真实群聊或完成外部操作。

## 与当前官方 Grok Bot 的区别

比较基于 **2026-10-13 读取的官方文档**与本项目代码和实测。客户端提取基线为 0.70.2；当日公开更新日志页面显示的最新条目是 0.68.1，两者不是同一版本来源，不能据此宣称已对齐“最新官方客户端”的全部功能。

| 能力               | 当前官方 Grok Bot                                  | 本项目 0.3.0                                                                          |
| ------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 界面来源           | 官方持续更新的客户端                               | 提取自 0.70.2 的发布 renderer；没有原始 TSX 工程                                      |
| 模型与推理质量     | 官方托管服务，包含产品自身的编排                   | 自己的 DeepSeek 官方 API；模型效果、速度与成本不同，未做质量等价基准                  |
| 电脑执行           | 持续存在的云电脑，具备浏览器、文件系统和终端 [1]   | 没有云电脑，也没有任意命令执行或通用 Computer Use                                     |
| 关闭电脑后继续工作 | 官方云端可以继续执行 [1]                           | Node 服务停止或主机休眠会影响任务                                                     |
| 群聊与委派         | Bot 可决定谁回复、异步交接工作 [2]                 | 群内依次调用每位成员；本地委派有深度限制，没有完整异步协作系统                        |
| 记忆与技能         | 长期上下文，可从演示学习流程 [3]                   | 按 Bot 存储文本记忆和技能，没有演示学习、向量检索或官方上下文压缩                     |
| 例行任务           | 官方文档描述保存技能与定时重跑 [3]                 | 单次、每天、间隔三类本机调度；没有完整 cron、Webhook 或外部事件系统                   |
| 应用连接           | 账号范围的插件与浏览器登录，会话可持续 [1]         | Notion 独立 OAuth/密钥、本机 EventKit 日历及手动 MCP 配置；没有完整官方市场与账号同步 |
| 文件输入与产出     | 多种文档和媒体文件，可交付表格、文档、幻灯片等 [4] | 已验证文本输入及 Markdown/文本/JSON 输出；PDF/Office 解析未接入，图片输入通路未实测   |
| 语音与媒体         | 官方聊天包含听写、语音通话和语音消息 [2]           | 语音服务未接入；图像/视频生成执行器未接入                                             |
| Team Bots          | 团队共享配置，成员拥有各自对话和授权 [5]           | 单用户本地工作空间，没有团队权限、租户隔离或团队发布                                  |
| 平台与同步         | macOS、Windows、Linux、iOS、Android [3]            | 本机网页；主要实测 macOS，没有移动安装包或跨设备账号同步                              |
| 安装更新           | 官方发行、登录和更新机制                           | Git 拉取与手工本地运行，没有官方签名客户端或自动升级                                  |
| 外部写入验收       | 以官方产品能力为准                                 | 写入实现已提供，但本次未向真实 Notion/日历写入验收数据                                |

**相同的界面不代表相同的执行能力。** 本项目适合研究已发布客户端的协议、界面和本地 Agent 实现；还不能替代官方 Grok Bot 的完整云端工作环境。

资料来源：

1. [Use the computer and apps](https://docs.x.ai/grok-bot/computer-and-apps)
2. [Message and collaborate](https://docs.x.ai/grok-bot/chat-and-collaboration)
3. [Grok Bot overview](https://docs.x.ai/grok-bot/overview)
4. [Files and results](https://docs.x.ai/grok-bot/files-and-results)
5. [Team Bots](https://docs.x.ai/grok-bot/team-bots)
6. [Grok Bot changelog](https://x.ai/changelog/bot)

## 系统结构

```mermaid
flowchart LR
  UI[原版 renderer] --> Bridge[本地桥接]
  Bridge --> Server[Node 本机服务]
  Server <--> DeepSeek[DeepSeek API]
  Server --> Tools[工具执行层]
  Tools --> State[工作空间文件]
  Tools --> Web[网页搜索与读取]
  Tools --> Notion[Notion API / MCP]
  Tools --> Calendar[macOS EventKit]
  Scheduler[本机调度器] --> Server
  State --> Bridge
```

### Context / Object

运行场景为单用户本机工作空间，核心对象是可对话和调用工具的 Bot。全局约束：凭据由服务端持有；同一 Bot 的运行互斥；外部写入经确认；没有云电脑；任务不具备关机后运行保证。

### Attributes / States / Behaviors

| 维度       | 定义与约束                                                                                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attributes | Bot ID 为非空字符串；群成员指向有效 Bot；时间以 Unix 毫秒保存，默认 Asia/Shanghai；单个附件最大 8 MiB；模型历史最近 100 条、总字符最多 250000；`.env` 与 OAuth 文件权限 0600                                                    |
| States     | 对话 idle → generating → tool-running/streaming → idle/stopped/failed；同一对话运行互斥。任务 open/done 与运行状态独立。例行任务 enabled/paused，执行记录 running/completed/failed；配置跨重启保存，活动轮次不能跨进程续跑      |
| Behaviors  | 创建 Bot/群聊以名称、角色和成员为输入，校验后持久化并发布 roster 更新，返回对象；发送消息以前置连接和有效 Bot 为条件，返回流与工具结果；定时触发创建 run 记录并调用模型，结束后保存结果；停止会取消上游请求，不撤销已完成的操作 |

细节见 [模型与群聊协议](docs/deepseek-integration.md)、[能力核对](docs/capability-map.md)、[Notion 连接](docs/notion-connection.md)。

### 目录

| 路径                                               | 内容                                       |
| -------------------------------------------------- | ------------------------------------------ |
| `app/`                                             | 提取并格式化的第三方 renderer 发布构建     |
| `src/config.js`                                    | 产品名称、初始 Bot、语言和功能开关         |
| `src/local-bridge.js`                              | 原版桌面/协调器接口的本地实现              |
| `src/workspace-sync.js`                            | 浏览器与服务端三方状态合并                 |
| `src/connections/`                                 | 应用授权和外部操作确认页                   |
| `tools/model-service.mjs`                          | DeepSeek 流式调用、多轮工具执行和中断      |
| `tools/workspace-*.mjs`                            | 对象操作、运行入口与原子存储               |
| `tools/routine-scheduler.mjs`                      | 本机例行任务调度                           |
| `tools/notion-*.mjs`、`tools/connector-tools.mjs`  | Notion OAuth、API 和 MCP                   |
| `tools/calendar-tools.mjs`、`CalendarBridge.swift` | 本机日历桥接                               |
| `tools/build.mjs`                                  | 无私人配置的可复制目录构建                 |
| `data/`                                            | 运行后产生，包含工作空间和授权状态；不公开 |

## 验证到了哪一步

本次真实模型与浏览器验证包括：新 Bot 自动继承 DeepSeek、多轮上下文、双 Bot 群聊、聊天创建群聊、记忆/技能/任务落盘、单次任务实际执行、网页读取、文件预览与下载、文本附件内容读取，以及 Notion 搜索和日历列表读取。

Notion 授权后发现 49 个工具，聊天实际找到了验收用的已知页面；EventKit 完整授权后实际读到 10 个日历。这些数字是本次账户的验收结果，不是所有用户都应拥有的配置。外部真实写入、图片理解和完整原版交互覆盖仍未验证。

`npm test` 当前有 7 项针对性检查，覆盖角色上下文、中文流式分片、鉴权错误脱敏、取消上游、状态合并、单次调度与原版时间字段。测试不要求真实模型密钥，不把模拟流当作真实模型输出。CI 运行测试和可复制构建，不调用用户外部账户。

可公开证据：[REA 统计](evidence/rea-summary.json)、[前端整理结果](evidence/readable-build.json)、[能力验收摘要](evidence/capabilities-verification.json)。这些是本次记录，不是完整原始证据库或对官方后端的等价性证明。

## 来源

第三方客户端代码、字体、图标和资源保留其原有来源。本项目没有为整个发布包套用统一的 MIT/Apache 许可，也不代表官方。目录归属与输入散列见 [THIRD_PARTY.md](THIRD_PARTY.md)。

公开内容不含模型密钥、Notion 令牌、浏览器 Cookie、私人工作空间、完整个人聊天、原始 ASAR、原生客户端二进制或本机完整运行日志。
