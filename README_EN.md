# wechat-cursor-bridge

A bridging process between **WeChat iLink (OpenClaw protocol)** ↔ **Cursor Agent**. It can use WeChat bot plugins to directly control `cursor_cli` to do work. It does not require a public IP; you can deploy locally as long as your environment has internet access.

## What you will get

- WeChat QR-code login to obtain `bot_token` (saved to disk; no need to scan again after restart)
- Long polling to receive messages (`ilink/bot/getupdates`) + send messages (`ilink/bot/sendmessage`)
- `cursor_cli` mode: directly call the local `agent` CLI
  - **Concurrent multiple tasks**: one message creates one task, without blocking subsequent messages
  - **Task control**: `/jobs`, `/cancel`, `/task` (multi-turn dialogue within the same task)
  - **Heartbeat progress reporting**: while running, report 「Task running, elapsed time…」 (auto down-throttling)
  - **Error reporting**: interruptions/exceptions will send the reason back to WeChat
- Output **plain-text formatting**: convert Markdown/code blocks into plain text that is easier to read on WeChat (icons + separators)
- Cross-process **de-duplication** of replies: even if you accidentally start multiple bridge instances, the same message will reply only once as much as possible

## Quick start

### 1) Install dependencies

```bash
npm install
```

### 2) Configure environment variables

```bash
copy .env.example .env
```

### 3) Start

```bash
npm run dev
```

On the first start, it will show a QR code. After you scan and confirm with WeChat, it will begin listening for messages.

## Startup arguments

- `--logout`: clear `data/credentials.json`. Next start will require QR-code scanning again.

```bash
npm run dev -- --logout
```

## Agent integration methods

Controlled by the environment variable `CURSOR_AGENT_MODE`.

### 1) `cursor_cli` (recommended) — directly call the local `agent` CLI

Windows example:

```env
CURSOR_AGENT_MODE=cursor_cli
CURSOR_CLI_MODEL=auto
CURSOR_CLI_PATH=C:\\Users\\admin\\AppData\\Local\\cursor-agent\\agent.ps1
```

### 2) `openai_compat` — OpenAI Chat Completions

Suitable for local running **OpenAI-compatible** proxies (forward requests to Cursor `agent` CLI), such as [cursor-agent-api-proxy](https://github.com/tageecc/cursor-agent-api-proxy).

```bash
npm install -g cursor-agent-api-proxy
cursor-agent-api run
```

`.env` example:

```env
CURSOR_AGENT_MODE=openai_compat
CURSOR_AGENT_URL=http://127.0.0.1:4646/v1
CURSOR_AGENT_API_KEY=not-needed
CURSOR_OPENAI_MODEL=auto
```

`CURSOR_AGENT_URL` can be a full path `.../v1/chat/completions`, or only up to `.../v1` (it will be auto-completed).

### 3) `simple` — plugin custom JSON

- `POST ${CURSOR_AGENT_URL}`
- Body: `userId`, `text`, `meta?`, `systemPrompt?`
- Response: `{ "reply": "..." }`

### Common issue: `TypeError: fetch failed` / `ECONNREFUSED`

This means there is **no HTTP service listening on the current URL**. Start the service corresponding to the ClawBot plugin, or switch to `openai_compat` + start `cursor-agent-api-proxy` first.

### Optional: `CURSOR_AGENT_HEADERS`

Value is a JSON object. It will be merged into request headers (supported by multiple modes). Example: `{"Authorization":"Bearer xxx"}`.

## Commands on the WeChat side (`cursor_cli` multi-task)

> The following commands only take effect for the **current WeChat user**.

- **Normal message**: create a new task, first reply 「received」, then send heartbeat, and finally return the result
  - Each task message will include `【任务#id】`
- **`/status`**: show service status (uptime, memory usage, running tasks, agent mode)
- **`/jobs`**: list tasks currently running
- **`/cancel <id>`**: interrupt/cancel a specific task (e.g. `/cancel 2`)
- **`/cancel all`**: interrupt/cancel all running tasks for the current user
- **`/task <id> <text>`**: continue the conversation within the same task (reuse the Cursor `session_id` of that task)
  - Example: `/task 2 Continue the 2nd step you did before, help me fill in the code`
- **`/clear`**: clear the session mapping “by user” (the session of that user)
- **`/feishu-bugs`**: query Feishu project bugs (fetches real-time data via MCP)
  - Usage: `/feishu-bugs [projectKey] [mine|all] [p=page] [size=pageSize]`
  - Examples: `/feishu-bugs`, `/feishu-bugs all p=1 size=20`, `/feishu-bugs PRJ123 mine p=2 size=10`
  - Paging: `/feishu-bugs-next`, `/feishu-bugs-prev`
  - Help: `/feishu-bugs-help`

## Heartbeat and long-running tasks

- `CURSOR_CLI_HEARTBEAT_MS` default is `10000` (10s tick), but sending will auto-throttle:
  - 0–30s: send on each tick
  - 30–60s: send once every 30s
  - >60s: send once every 60s
- `CURSOR_CLI_TIMEOUT_MS`: cursor_cli child process kill timeout; `0/none` means no force-kill (suitable for extremely long tasks)

## Output formatting (plain text)

iLink text messages do not support Markdown rendering. This project converts common Markdown into plain text that is more suitable for WeChat reading:

- Headings/lists/quotes: add icons and indentation
- Code blocks: `📎 Code (lang)` + `────────` separator line
- Very long content: split by `WECHAT_MAX_CHARS_PER_MESSAGE` and mark with `【2/3】`

## Important data files

- `data/credentials.json`: WeChat login credentials
- `data/bridge.lock`: single-instance lock for the bridge (if stale, delete and restart)
- `data/sessions.json`: Cursor session mapping (used for multi-turn conversations)
- `data/dedupe/`: cross-process de-duplication marks (auto cleaned in the background)

## Common environment variables quick reference

- **Cursor / Agent**
  - `CURSOR_AGENT_MODE`: `cursor_cli` / `openai_compat` / `simple`
  - `CURSOR_CLI_MODEL`: `auto` (or a model id from `agent --list-models`)
  - `CURSOR_CLI_PATH`: absolute path of `agent.ps1/agent.cmd` (Windows)
  - `CURSOR_AGENT_TIMEOUT_MS`: general timeout (ms)
  - `CURSOR_CLI_TIMEOUT_MS`: only for `cursor_cli`, child process kill timeout (0/none=do not force-kill)
  - `CURSOR_CLI_HEARTBEAT_MS`: heartbeat tick interval (ms, 0=off)

- **WeChat prompt templates**
  - `WECHAT_ACK_MESSAGE`: the message sent first after receiving (default: “收到。”)
  - `WECHAT_CLI_PROGRESS_TEMPLATE`: progress template (default: `任务执行中，已耗时 {duration}…`)
  - `WECHAT_CLI_ABORT_TEMPLATE`: abort template (supports `{reason}` `{code}`)
  - `WECHAT_ERROR_TEMPLATE`: other error templates (supports `{message}`)
  - `WECHAT_ERROR_MAX_CHARS`: max characters to keep when truncating error messages

- **Formatting / splitting**
  - `WECHAT_FORMAT_REPLY`: reply formatting toggle
  - `WECHAT_FORMAT_KEYWORDS`: keyword-icon toggle at the beginning of lines
  - `WECHAT_MAX_CHARS_PER_MESSAGE`: maximum characters per message (split if exceeded)

## Feishu MCP (optional)

If you want to query Feishu bugs from WeChat (`/feishu-bugs`), you need to configure an MCP server in Cursor (e.g. `FeishuProjectMcp`) and provide a token.

- **Do not commit tokens**: keep them in Cursor GUI MCP config (e.g. `~/.cursor/mcp.json`). This repo also ignores `.cursor/mcp.json` by default.
- **Optional via env**: you can also provide the token in `.env`. See `.env.example` for `FEISHU_MCP_TOKEN`.

