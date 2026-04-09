import { getUpdates, sendTextMessage, extractTextFromMessage } from "./weixin/api.js";
import { MessageType } from "./weixin/types.js";
import type { LoginCredentials, WeixinMessage } from "./weixin/types.js";
import { CursorAgentClient, CursorCliAbortedError } from "./cursor/agentClient.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { loadCursorSessions, saveCursorSessions } from "./store/cursorSessions.js";
import {
  envWeChatMaxCharsPerMessage,
  formatReplyForWeChat,
  shouldFormatWeChatReply,
  splitReplyForWeChat,
} from "./format/wechatReply.js";

const MAX_CONSECUTIVE_FAILURES = 5;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

const contextTokens = new Map<string, string>();

const DEDUPE_TTL_MS = 2 * 60_000;
const DEDUPE_DIR = path.resolve("data/dedupe");
const DEDUPE_JANITOR_INTERVAL_MS = 60_000;

function isCursorCliMode(): boolean {
  const m = process.env.CURSOR_AGENT_MODE?.trim().toLowerCase();
  return m === "cursor_cli" || m === "cli";
}

/** cursor_cli 微信进度心跳间隔（毫秒）。0 / off 关闭。默认 10000。 */
function getCliHeartbeatIntervalMs(): number {
  const raw = process.env.CURSOR_CLI_HEARTBEAT_MS?.trim();
  if (!raw) return 10_000;
  const lower = raw.toLowerCase();
  if (lower === "0" || lower === "off" || lower === "false" || lower === "none") return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 10_000;
}

function formatDurationCn(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}秒`;
  const min = Math.floor(sec / 60);
  const rs = sec % 60;
  if (min < 60) return rs > 0 ? `${min}分${rs}秒` : `${min}分钟`;
  const h = Math.floor(min / 60);
  const rm = min % 60;
  return rm > 0 ? `${h}小时${rm}分` : `${h}小时`;
}

function envErrorMaxChars(): number {
  const raw = process.env.WECHAT_ERROR_MAX_CHARS?.trim();
  if (!raw) return 3500;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 200 ? Math.floor(n) : 3500;
}

function truncateForWeChat(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 40))}\n\n…(已截断，原文约 ${text.length} 字符)`;
}

function errorMessageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export class Bot {
  private credentials: LoginCredentials;
  private agent: CursorAgentClient;
  private running = false;
  private getUpdatesBuf = "";
  private sessions = new Set<string>();
  private seen = new Map<string, number>();
  private janitor?: NodeJS.Timeout;
  private cursorSessions: Record<string, string> = {};
  private savingSessions?: NodeJS.Timeout;
  private taskSeq = 0;
  private tasks = new Map<
    string,
    {
      id: string;
      userId: string;
      createdAt: number;
      lastActiveAt: number;
      sessionId?: string;
      running: boolean;
      startedAt?: number;
      pid?: number;
      cancelRequested: boolean;
      kill?: () => void;
    }
  >();
  /** 每个用户拥有的 task ids（包含运行中/已完成可继续对话的任务）。 */
  private userTasks = new Map<string, Set<string>>();

  constructor(credentials: LoginCredentials, agent: CursorAgentClient) {
    this.credentials = credentials;
    this.agent = agent;
  }

  async start(): Promise<void> {
    this.running = true;
    console.log("[bot] 桥接进程已启动，开始监听微信消息...");
    this.janitor = startDedupeJanitor();
    this.cursorSessions = await loadCursorSessions();

    let failures = 0;

    while (this.running) {
      try {
        const resp = await getUpdates(
          this.credentials.baseUrl,
          this.credentials.token,
          this.getUpdatesBuf,
        );

        if (resp.ret !== undefined && resp.ret !== 0) {
          failures++;
          console.error(
            `[bot] getUpdates 错误: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg}`,
          );
          if (failures >= MAX_CONSECUTIVE_FAILURES) {
            console.error(`[bot] 连续失败 ${failures} 次，等待 ${BACKOFF_DELAY_MS / 1000}s 后重试`);
            failures = 0;
            await sleep(BACKOFF_DELAY_MS);
          } else {
            await sleep(RETRY_DELAY_MS);
          }
          continue;
        }

        failures = 0;

        if (resp.get_updates_buf) this.getUpdatesBuf = resp.get_updates_buf;

        const messages = resp.msgs ?? [];
        for (const msg of messages) {
          await this.handleMessage(msg);
        }
      } catch (err) {
        failures++;
        console.error(`[bot] 轮询异常: ${String(err)}`);
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          failures = 0;
          await sleep(BACKOFF_DELAY_MS);
        } else {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }
  }

  stop(): void {
    this.running = false;
    if (this.janitor) {
      clearInterval(this.janitor);
      this.janitor = undefined;
    }
    if (this.savingSessions) {
      clearTimeout(this.savingSessions);
      this.savingSessions = undefined;
    }
    console.log("[bot] 已停止");
  }

  private async handleMessage(msg: WeixinMessage): Promise<void> {
    if (msg.message_type !== MessageType.USER) return;

    const fromUser = msg.from_user_id;
    if (!fromUser) return;

    if (await this.isDuplicate(fromUser, msg)) return;

    if (msg.context_token) contextTokens.set(fromUser, msg.context_token);

    const text = extractTextFromMessage(msg);
    if (!text.trim()) return;

    console.log(`[bot] 收到消息 from=${fromUser}: ${text.slice(0, 200)}`);

    // 多任务控制指令（仅对当前用户生效）
    if (text.trim() === "/jobs") {
      const ids = Array.from(this.userTasks.get(fromUser) ?? []);
      const running = ids
        .map((id) => this.tasks.get(id))
        .filter((t): t is NonNullable<typeof t> => Boolean(t?.running));
      if (!running.length) {
        await this.reply(fromUser, "当前没有运行中的任务。");
        return;
      }
      const lines = running
        .map((t) => {
          const dur = t.startedAt ? formatDurationCn(Date.now() - t.startedAt) : "?";
          const pid = t.pid ? ` pid=${t.pid}` : "";
          return `- 【任务#${t.id}】已运行 ${dur}${pid}`;
        })
        .join("\n");
      await this.reply(fromUser, `运行中的任务：\n${lines}\n\n用法：/cancel <任务号>`);
      return;
    }

    if (text.trim().startsWith("/cancel")) {
      const parts = text.trim().split(/\s+/);
      const id = parts[1];
      if (!id) {
        await this.reply(fromUser, "用法：/cancel <任务号> 或 /cancelall");
        return;
      }
      if (id === "all" || id === "ALL" || id === "all@" || id === "cancelall" || id === "all-tasks") {
        await this.cancelAllTasks(fromUser);
        return;
      }
      const task = this.tasks.get(id);
      if (!task || task.userId !== fromUser) {
        await this.reply(fromUser, `未找到任务：${id}`);
        return;
      }
      if (!task.running || !task.kill) {
        await this.reply(fromUser, `【任务#${id}】当前不在运行。`);
        return;
      }
      task.cancelRequested = true;
      task.kill();
      await this.reply(fromUser, `已请求中断 【任务#${id}】`);
      return;
    }

    if (text.trim().startsWith("/task")) {
      // /task <id> <text...>
      const m = text.trim().match(/^\/task\s+(\S+)\s+([\s\S]+)$/);
      if (!m) {
        await this.reply(fromUser, "用法：/task <任务号> <内容>\n示例：/task 2 继续刚才的任务");
        return;
      }
      const id = m[1];
      const prompt = m[2].trim();
      if (!prompt) {
        await this.reply(fromUser, "用法：/task <任务号> <内容>");
        return;
      }
      const task = this.tasks.get(id);
      if (!task || task.userId !== fromUser) {
        await this.reply(fromUser, `未找到任务：${id}`);
        return;
      }
      if (task.running) {
        await this.reply(fromUser, `【任务#${id}】仍在运行中，请稍后或 /cancel ${id}`);
        return;
      }
      await this.runCursorCliTask({
        taskId: id,
        fromUser,
        text: prompt,
        msg,
        existing: true,
      });
      return;
    }

    if (text.trim() === "/clear") {
      this.sessions.delete(fromUser);
      delete this.cursorSessions[fromUser];
      void this.scheduleSaveSessions();
      await this.reply(fromUser, "对话已重置");
      return;
    }

    // cursor_cli 并发任务：每条消息启动一个子进程任务，避免阻塞 getUpdates
    if (isCursorCliMode()) {
      const taskId = this.nextTaskId();
      await this.runCursorCliTask({ taskId, fromUser, text, msg, existing: false });
      return;
    }

    try {
      const hbMs = getCliHeartbeatIntervalMs();
      const cliHeartbeat =
        isCursorCliMode() && hbMs > 0
          ? {
              intervalMs: hbMs,
              onTick: async (elapsedMs: number) => {
                const tpl =
                  process.env.WECHAT_CLI_PROGRESS_TEMPLATE?.trim() ||
                  "任务执行中，已耗时 {duration}…";
                const line = tpl.replace("{duration}", formatDurationCn(elapsedMs));
                await this.reply(fromUser, line);
              },
            }
          : undefined;

      const resp = await this.agent.chat({
        userId: fromUser,
        text,
        resumeSessionId: this.cursorSessions[fromUser],
        cliHeartbeat,
        meta: {
          contextToken: contextTokens.get(fromUser),
          hasSession: this.sessions.has(fromUser),
          weixin: {
            session_id: msg.session_id,
            message_id: msg.message_id,
            seq: msg.seq,
          },
        },
      });
      this.sessions.add(fromUser);
      if (resp.sessionId && typeof resp.sessionId === "string") {
        this.cursorSessions[fromUser] = resp.sessionId;
        void this.scheduleSaveSessions();
      }
      console.log(`[bot] agent 回复 to=${fromUser}: ${resp.reply.slice(0, 200)}`);
      await this.replyFormatted(fromUser, resp.reply);
    } catch (err) {
      console.error(`[bot] 调用 Cursor Agent 失败: ${String(err)}`);
      const maxChars = envErrorMaxChars();

      if (err instanceof CursorCliAbortedError) {
        const reason = truncateForWeChat(errorMessageOf(err), maxChars);
        const tpl =
          process.env.WECHAT_CLI_ABORT_TEMPLATE?.trim() ||
          "任务中断，请重试。\n\n原因：{reason}";
        const text = tpl
          .replaceAll("{reason}", reason)
          .replaceAll("{code}", err.abortCode);
        await this.replyFormatted(fromUser, truncateForWeChat(text, maxChars + 200), {
          beautify: false,
        });
        return;
      }

      const detail = truncateForWeChat(errorMessageOf(err), maxChars);
      const genericTpl = process.env.WECHAT_ERROR_TEMPLATE?.trim();
      const body = genericTpl
        ? genericTpl.replaceAll("{message}", detail)
        : `Cursor Agent 执行报错：\n${detail}`;
      await this.replyFormatted(fromUser, truncateForWeChat(body, maxChars + 200), {
        beautify: false,
      });
    }
  }

  private nextTaskId(): string {
    this.taskSeq += 1;
    // short readable id
    return this.taskSeq.toString(36);
  }

  private cleanupTask(id: string): void {
    const t = this.tasks.get(id);
    if (!t) return;
    t.running = false;
    t.startedAt = undefined;
    t.pid = undefined;
    t.kill = undefined;
    t.cancelRequested = false;
    t.lastActiveAt = Date.now();
  }

  private async cancelAllTasks(userId: string): Promise<void> {
    const ids = Array.from(this.userTasks.get(userId) ?? []);
    if (!ids.length) {
      await this.reply(userId, "当前没有运行中的任务。");
      return;
    }
    let n = 0;
    for (const id of ids) {
      const t = this.tasks.get(id);
      if (!t?.running || !t.kill) continue;
      t.cancelRequested = true;
      t.kill();
      n++;
    }
    await this.reply(userId, `已请求中断 ${n} 个任务。`);
  }

  private async runCursorCliTask(opts: {
    taskId: string;
    fromUser: string;
    text: string;
    msg: WeixinMessage;
    existing: boolean;
  }): Promise<void> {
    const { taskId, fromUser, text, msg, existing } = opts;
    const now = Date.now();

    let rec = this.tasks.get(taskId);
    if (!rec) {
      rec = {
        id: taskId,
        userId: fromUser,
        createdAt: now,
        lastActiveAt: now,
        sessionId: undefined,
        running: false,
        cancelRequested: false,
      };
      this.tasks.set(taskId, rec);
      if (!this.userTasks.has(fromUser)) this.userTasks.set(fromUser, new Set());
      this.userTasks.get(fromUser)!.add(taskId);
    }

    if (rec.running) {
      await this.reply(fromUser, `【任务#${taskId}】仍在运行中，请稍后或 /cancel ${taskId}`);
      return;
    }

    rec.running = true;
    rec.startedAt = now;
    rec.lastActiveAt = now;
    rec.cancelRequested = false;

    const ack = process.env.WECHAT_ACK_MESSAGE?.trim() || "收到。";
    const head = existing ? `【任务#${taskId}】继续执行` : `【任务#${taskId}】已开始`;
    const hint = existing ? "" : `\n用法：/task ${taskId} <内容> 继续该任务`;
    await this.reply(fromUser, `${ack}\n${head}${hint}`);

    const hbMs = getCliHeartbeatIntervalMs();
    let lastHeartbeatSentMs = 0;
    const heartbeatGateMs = (elapsedMs: number): number => {
      if (elapsedMs > 60_000) return 60_000;
      if (elapsedMs > 30_000) return 30_000;
      return hbMs;
    };
    const cliHeartbeat =
      hbMs > 0
        ? {
            intervalMs: hbMs,
            onTick: async (elapsedMs: number) => {
              const gate = heartbeatGateMs(elapsedMs);
              if (elapsedMs - lastHeartbeatSentMs < gate) return;
              lastHeartbeatSentMs = elapsedMs;
              const tpl =
                process.env.WECHAT_CLI_PROGRESS_TEMPLATE?.trim() ||
                "任务执行中，已耗时 {duration}…";
              const line = tpl.replace("{duration}", formatDurationCn(elapsedMs));
              await this.reply(fromUser, `【任务#${taskId}】${line}`);
            },
          }
        : undefined;

    const task = await this.agent.startCursorCliTask({
      userId: fromUser,
      text,
      // 同一任务多轮对话：复用该 task 的 sessionId
      resumeSessionId: rec.sessionId,
      cliHeartbeat,
      meta: {
        contextToken: contextTokens.get(fromUser),
        hasSession: this.sessions.has(fromUser),
        weixin: {
          session_id: msg.session_id,
          message_id: msg.message_id,
          seq: msg.seq,
        },
      },
    });

    rec.pid = task.pid;
    rec.kill = task.kill;

    void task.promise
      .then(async (resp) => {
        if (resp.sessionId) rec!.sessionId = resp.sessionId;
        this.cleanupTask(taskId);
        await this.replyFormatted(fromUser, `【任务#${taskId}】✅ 完成\n\n${resp.reply}`);
      })
      .catch(async (err) => {
        const maxChars = envErrorMaxChars();
        const cur = this.tasks.get(taskId);
        const cancelled = cur?.cancelRequested === true;
        this.cleanupTask(taskId);

        if (cancelled) {
          await this.reply(fromUser, `【任务#${taskId}】已中断`);
          return;
        }
        if (err instanceof CursorCliAbortedError) {
          const reason = truncateForWeChat(errorMessageOf(err), maxChars);
          const tpl =
            process.env.WECHAT_CLI_ABORT_TEMPLATE?.trim() ||
            "任务中断，请重试。\n\n原因：{reason}";
          const text2 = tpl.replaceAll("{reason}", reason).replaceAll("{code}", err.abortCode);
          await this.replyFormatted(fromUser, `【任务#${taskId}】❌ ${text2}`, { beautify: false });
          return;
        }
        const detail = truncateForWeChat(errorMessageOf(err), maxChars);
        await this.replyFormatted(fromUser, `【任务#${taskId}】❌ Cursor Agent 报错：\n${detail}`, {
          beautify: false,
        });
      });
  }

  private async scheduleSaveSessions(): Promise<void> {
    if (this.savingSessions) return;
    this.savingSessions = setTimeout(() => {
      this.savingSessions = undefined;
      void saveCursorSessions(this.cursorSessions);
    }, 300);
  }

  private async reply(to: string, text: string): Promise<void> {
    const contextToken = contextTokens.get(to);
    try {
      await sendTextMessage(this.credentials.baseUrl, this.credentials.token, to, text, contextToken);
    } catch (err) {
      console.error(`[bot] 发送消息失败 to=${to}: ${String(err)}`);
    }
  }

  /**
   * 美化 Markdown→纯文本（类 OpenClaw 观感）并按长度拆成多条微信，避免单条过长。
   */
  private async replyFormatted(
    to: string,
    text: string,
    opts?: { beautify?: boolean; split?: boolean },
  ): Promise<void> {
    const beautify = opts?.beautify !== false;
    const split = opts?.split !== false;
    let out =
      beautify && shouldFormatWeChatReply() ? formatReplyForWeChat(text) : text;
    const maxChars = envWeChatMaxCharsPerMessage();
    const chunks =
      split && out.length > maxChars ? splitReplyForWeChat(out, maxChars) : [out];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const body =
        chunks.length > 1 && i > 0 ? `【${i + 1}/${chunks.length}】\n${chunk}` : chunk;
      await this.reply(to, body);
    }
  }

  private async isDuplicate(fromUser: string, msg: WeixinMessage): Promise<boolean> {
    const now = Date.now();

    // purge old entries (simple O(n) is fine for small map)
    for (const [k, exp] of this.seen.entries()) {
      if (exp <= now) this.seen.delete(k);
    }

    const keyParts = [
      "wx",
      fromUser,
      msg.session_id ?? "",
      msg.message_id?.toString() ?? "",
      msg.seq?.toString() ?? "",
      msg.client_id ?? "",
      msg.create_time_ms?.toString() ?? "",
    ];
    const key = keyParts.join("|");

    if (this.seen.has(key)) {
      console.log(`[bot] 去重：忽略重复消息 key=${key}`);
      return true;
    }

    // Cross-process dedupe: only mark if we have at least some stable id info
    if (msg.message_id || msg.seq || msg.client_id || msg.create_time_ms) {
      this.seen.set(key, now + DEDUPE_TTL_MS);
      const dup = await dedupeMarkOnce(key, now + DEDUPE_TTL_MS);
      if (dup) {
        console.log(`[bot] 去重（跨进程）：忽略重复消息 key=${key}`);
        return true;
      }
    }

    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function dedupeMarkOnce(key: string, expiresAtMs: number): Promise<boolean> {
  await fs.mkdir(DEDUPE_DIR, { recursive: true });
  const hash = crypto.createHash("sha1").update(key).digest("hex");
  const filePath = path.join(DEDUPE_DIR, `${hash}.json`);

  // Try create exclusively: first writer wins.
  try {
    const handle = await fs.open(filePath, "wx");
    try {
      await handle.writeFile(JSON.stringify({ key, expiresAtMs }, null, 2), "utf-8");
    } finally {
      await handle.close();
    }
    return false;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "EEXIST") {
      // If dedupe store has issues, do not block replying (fail-open).
      console.error(`[bot] 去重存储异常（忽略）：${String(err)}`);
      return false;
    }
  }

  // Exists: check expiry; if expired, remove and retry once.
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const json = JSON.parse(raw) as { expiresAtMs?: number };
    const exp = typeof json.expiresAtMs === "number" ? json.expiresAtMs : 0;
    if (exp > 0 && exp <= Date.now()) {
      await fs.unlink(filePath).catch(() => {});
      return await dedupeMarkOnce(key, expiresAtMs);
    }
  } catch {
    // If file is unreadable, treat as duplicate to be safe (avoid multi-reply storm)
    return true;
  }

  return true;
}

function startDedupeJanitor(): NodeJS.Timeout {
  return setInterval(() => {
    void cleanupDedupeDir();
  }, DEDUPE_JANITOR_INTERVAL_MS);
}

async function cleanupDedupeDir(): Promise<void> {
  try {
    await fs.mkdir(DEDUPE_DIR, { recursive: true });
    const files = await fs.readdir(DEDUPE_DIR);
    const now = Date.now();

    await Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map(async (f) => {
          const p = path.join(DEDUPE_DIR, f);
          try {
            const raw = await fs.readFile(p, "utf-8");
            const json = JSON.parse(raw) as { expiresAtMs?: number };
            const exp = typeof json.expiresAtMs === "number" ? json.expiresAtMs : 0;
            if (!exp || exp <= now) {
              await fs.unlink(p).catch(() => {});
            }
          } catch {
            // unreadable/corrupt -> delete to prevent accumulation
            await fs.unlink(p).catch(() => {});
          }
        }),
    );
  } catch (err) {
    console.error(`[bot] 去重清理异常（忽略）：${String(err)}`);
  }
}

