# wechat-cursor-bridge

一个 **微信 iLink(OpenClaw 协议)** ↔ **Cursor Agent** 的桥接进程。你可以在微信里像“发指令”一样调用本机 Cursor `agent`，无需公网 IP（本机可联网即可）。

English: A bridging process between **WeChat iLink (OpenClaw protocol)** ↔ **Cursor Agent**. Run locally; no public IP required.

> 重要：本项目使用的是腾讯官方 iLink Bot 协议（域名通常为 `ilinkai.weixin.qq.com`），属于合法开放的个人 Bot 能力。具体协议背景可参考开源解析文章：[openclaw-weixin](https://github.com/hao-ji-xing/openclaw-weixin/blob/main/weixin-bot-api.md)。

## 你将得到什么

- 微信扫码登录拿 `bot_token`（凭证落盘，重启免扫码）
- 长轮询收消息（`ilink/bot/getupdates`）+ 发送消息（`ilink/bot/sendmessage`）
- `cursor_cli` 模式：直接调用本机 `agent` CLI
  - **并发多任务**：一条消息一个任务，不阻塞后续消息
  - **任务控制**：`/jobs`、`/cancel`、`/task`（同一任务多轮对话）
  - **心跳进度**：执行中回传「任务执行中，已耗时…」（自动降频）
  - **错误回传**：中断/异常会把原因发回微信
- 输出 **纯文本美化**：将 Markdown/代码块转成更适合微信的纯文本（图标 + 分隔线）
- 跨进程 **防重复回复**：即便误开多个桥接实例，同一条消息尽量只回复一次

## 快速开始

### 1) 安装依赖

```bash
npm install
```

### 2) 配置环境变量

```bash
copy .env.example .env
```

### 3) 启动

```bash
npm run dev
```

首次启动会显示二维码，微信扫码确认后开始监听消息。

## 技术栈

- **运行时**：Node.js（要求 Node >= 22，依赖内置 `fetch`）
- **语言**：TypeScript（`tsx` 开发运行 + `tsc` 构建）
- **微信接入**：腾讯 iLink Bot HTTP API（扫码登录、长轮询、发消息）
- **Cursor 接入**：
  - `cursor_cli`：直接调用本机 Cursor CLI：`agent -p --output-format json ...`
  - `openai_compat`：对接本机 OpenAI 兼容代理（如 `cursor-agent-api-proxy`）

## 系统支持（你当前是 Windows）

### 支持范围

- **Windows 10/11**：✅ 已验证（你的当前环境）
- **macOS / Linux**：✅ 理论支持（Node >= 22 + 可用的 `agent` CLI）

### 关键差异

- **`cursor_cli` 模式**：
  - Windows 通常需要配置 `CURSOR_CLI_PATH` 指向 `agent.ps1/agent.cmd`
  - macOS/Linux 通常只要 `agent` 在 `PATH` 中即可

## 启动参数

- `--logout`：清除 `data/credentials.json`，下次启动重新扫码

```bash
npm run dev -- --logout
```

## Agent 接入方式

由环境变量 `CURSOR_AGENT_MODE` 控制。

### 1) `cursor_cli`（推荐）— 直接调用本机 `agent` CLI

Windows 示例：

```env
CURSOR_AGENT_MODE=cursor_cli
CURSOR_CLI_MODEL=auto
CURSOR_CLI_PATH=C:\\Users\\admin\\AppData\\Local\\cursor-agent\\agent.ps1
```

### 2) `openai_compat` — OpenAI Chat Completions

适用于本机跑 [cursor-agent-api-proxy](https://github.com/tageecc/cursor-agent-api-proxy) 等 **OpenAI 兼容** 代理（把请求转到 Cursor `agent` CLI）。

```bash
npm install -g cursor-agent-api-proxy
cursor-agent-api run
```

`.env` 示例：

```env
CURSOR_AGENT_MODE=openai_compat
CURSOR_AGENT_URL=http://127.0.0.1:4646/v1
CURSOR_AGENT_API_KEY=not-needed
CURSOR_OPENAI_MODEL=auto
```

`CURSOR_AGENT_URL` 可写完整路径 `.../v1/chat/completions`，或只写到 `.../v1`（会自动补全）。

### 3) `simple` — 插件自定义 JSON

- `POST ${CURSOR_AGENT_URL}`
- Body: `userId`, `text`, `meta?`, `systemPrompt?`
- 响应: `{ "reply": "..." }`

### 常见问题：`TypeError: fetch failed` / `ECONNREFUSED`

说明 **当前 URL 上没有 HTTP 服务在监听**。请启动 ClawBot 插件对应服务，或改用 `openai_compat` + 先启动 `cursor-agent-api-proxy`。

### 可选：`CURSOR_AGENT_HEADERS`

值为 JSON 对象，会合并进请求头（多种模式均支持），例如：`{"Authorization":"Bearer xxx"}`。

## 微信端指令（cursor_cli 多任务）

> 以下指令仅对“当前微信用户”生效。

- **普通消息**：创建一个新任务，先回“收到”，再心跳，最后回结果  
  - 每条任务消息都会带 `【任务#id】`
- **`/jobs`**：列出当前运行中的任务
- **`/cancel <id>`**：中断指定任务（例如 `/cancel 2`）
- **`/cancel all`**：中断当前用户所有运行中的任务
- **`/task <id> <text>`**：在同一个任务里继续对话（复用该任务的 Cursor `session_id`）  
  - 示例：`/task 2 继续刚才的第2步，帮我补全代码`
- **`/clear`**：清空“按用户维度”的会话映射（该用户的 session）

## 心跳与超长任务

- `CURSOR_CLI_HEARTBEAT_MS` 默认 10000（10s tick），但发送会自动降频：
  - 0–30s：按 tick 发送
  - 30–60s：每 30s 发送一次
  - >60s：每 60s 发送一次
- `CURSOR_CLI_TIMEOUT_MS`：cursor_cli 子进程 kill 超时；`0/none` 表示不强杀（适合超长任务）

## 输出美化（纯文本）

iLink 文本消息不支持 Markdown 渲染，本项目会将常见 Markdown 转成更适合微信阅读的纯文本：

- 标题/列表/引用：加图标与缩进
- 代码块：`📎 代码（lang）` + `────────` 分隔线
- 超长内容：按 `WECHAT_MAX_CHARS_PER_MESSAGE` 拆分并标注 `【2/3】`

## 重要数据文件

- `data/credentials.json`：微信登录凭证
- `data/bridge.lock`：桥接单实例锁（残留时可删除后重启）
- `data/sessions.json`：Cursor 会话映射（用于多轮对话）
- `data/dedupe/`：跨进程去重标记（后台自动清理）

## 常用环境变量速查

- **Cursor / Agent**
  - `CURSOR_AGENT_MODE`: `cursor_cli` / `openai_compat` / `simple`
  - `CURSOR_CLI_MODEL`: `auto`（或 `agent --list-models` 中的模型 ID）
  - `CURSOR_CLI_PATH`: `agent.ps1/agent.cmd` 的绝对路径（Windows）
  - `CURSOR_AGENT_TIMEOUT_MS`: 通用超时（ms）
  - `CURSOR_CLI_TIMEOUT_MS`: 仅 cursor_cli，子进程 kill 超时（0/none=不强杀）
  - `CURSOR_CLI_HEARTBEAT_MS`: 心跳 tick 间隔（ms，0=关）

- **微信提示文案**
  - `WECHAT_ACK_MESSAGE`: 收到后先回的文案（默认“收到。”）
  - `WECHAT_CLI_PROGRESS_TEMPLATE`: 进度模板（默认 `任务执行中，已耗时 {duration}…`）
  - `WECHAT_CLI_ABORT_TEMPLATE`: 中断模板（支持 `{reason}` `{code}`）
  - `WECHAT_ERROR_TEMPLATE`: 其它报错模板（支持 `{message}`）
  - `WECHAT_ERROR_MAX_CHARS`: 错误信息截断长度

- **格式化 / 拆分**
  - `WECHAT_FORMAT_REPLY`: 回复美化开关
  - `WECHAT_FORMAT_KEYWORDS`: 行首关键词图标开关
  - `WECHAT_MAX_CHARS_PER_MESSAGE`: 单条最大字符（超出拆分）

## 开源与合规提示

- **不要提交敏感信息**：`.env`、`data/*`（含 `credentials.json` / `sessions.json`）请勿提交到 GitHub
- **权限风险**：`cursor_cli` 模式会调用本机 `agent`，其工具能力取决于你的 Cursor 权限设置；请只在可信机器/账号使用


