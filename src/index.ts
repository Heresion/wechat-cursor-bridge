import "dotenv/config";

import { clearCredentials, login } from "./weixin/auth.js";
import { Bot } from "./bot.js";
import { CursorAgentClient } from "./cursor/agentClient.js";
import fs from "node:fs";
import path from "node:path";

async function main(): Promise<void> {
  if (process.argv.includes("--logout")) {
    clearCredentials();
    console.log("已清除登录凭证，下次启动需要重新扫码。");
    return;
  }

  const releaseLock = acquireSingleInstanceLock();

  const agent = new CursorAgentClient();
  const credentials = await login();
  const bot = new Bot(credentials, agent);

  const shutdown = () => {
    console.log("\n正在关闭...");
    bot.stop();
    releaseLock();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await bot.start();
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});

function acquireSingleInstanceLock(): () => void {
  const lockPath = path.resolve("data/bridge.lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const tryOpen = () => fs.openSync(lockPath, "wx");
  let fd: number;
  try {
    fd = tryOpen();
  } catch (err) {
    // lock exists -> likely another instance; exit to avoid multi-reply
    console.error(`[lock] 检测到已有桥接进程在运行（${lockPath}）。请先停止旧进程再启动。`);
    process.exit(2);
  }

  const content = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2);
  fs.writeFileSync(fd, content, "utf-8");

  const release = () => {
    try {
      fs.closeSync(fd);
    } catch {}
    try {
      fs.unlinkSync(lockPath);
    } catch {}
  };

  // best-effort cleanup on exit
  process.on("exit", release);
  return release;
}

