# 安全政策（Security Policy）

## 支持版本

目前仅维护主分支（`main`）的最新版本。

## 报告漏洞

如果你发现了可能的安全问题（包括但不限于：凭证泄露、任意命令执行、越权访问、SSRF、敏感信息输出等），请不要在公开 Issue 里披露。

建议通过以下方式私下联系维护者：

- 提交 GitHub Security Advisory（推荐）
- 或通过仓库 README 中的联系方式联系

我们会尽快确认并给出修复计划。

## 安全注意事项（使用方）

- 请勿提交/上传 `.env`、`data/credentials.json`、`data/sessions.json` 等包含敏感信息的文件到公开仓库。
- `cursor_cli` 模式会调用本机 `agent` 并具备工具调用能力，请仅在你信任的机器与账号上使用，并合理配置 Cursor 的权限策略。

