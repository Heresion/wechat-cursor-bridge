# 贡献指南（Contributing）

感谢你愿意为本项目做贡献！

## 开发环境

- Node.js >= 22
- Windows / macOS / Linux 皆可（推荐使用最新 LTS/稳定版 Node）

安装依赖：

```bash
npm install
```

开发运行：

```bash
copy .env.example .env
npm run dev
```

构建检查：

```bash
npm run build
```

## 提交规范

- 尽量保持改动小而清晰
- PR 里描述「为什么」而不是只描述「改了什么」
- 不要提交敏感文件（`.env`、`data/*`）

## Issue / PR

- Bug：请附上复现步骤、期望与实际结果、以及相关日志片段（可脱敏）
- Feature：请描述使用场景、交互命令与预期行为

