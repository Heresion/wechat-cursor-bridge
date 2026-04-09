/** cursor_cli 子进程被桥接超时 kill、或异常退出且无有效 JSON 时抛出，供上层回复「请重试」等。 */
export class CursorCliAbortedError extends Error {
  readonly abortCode: "timeout" | "exit" | "incomplete";

  constructor(abortCode: CursorCliAbortedError["abortCode"], message: string) {
    super(message);
    this.name = "CursorCliAbortedError";
    this.abortCode = abortCode;
  }
}

export interface CursorAgentChatRequest {
  userId: string;
  text: string;
  systemPrompt?: string;
  resumeSessionId?: string;
  meta?: Record<string, unknown>;
  /** 仅 cursor_cli：子进程仍运行时周期性回调（用于微信心跳）。 */
  cliHeartbeat?: {
    intervalMs: number;
    onTick: (elapsedMs: number) => void | Promise<void>;
  };
}

export interface CursorAgentChatResponse {
  reply: string;
  sessionId?: string;
}

type AgentMode = "simple" | "openai_compat" | "cursor_cli";

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** cursor_cli 专用：0 / -1 / none 表示不设置 kill 超时（一直等到 agent 进程结束）。 */
function getCursorCliKillTimeoutMs(): number | null {
  const cliRaw = process.env.CURSOR_CLI_TIMEOUT_MS?.trim();
  if (cliRaw) {
    const lower = cliRaw.toLowerCase();
    if (lower === "0" || lower === "-1" || lower === "none" || lower === "off" || lower === "infinity") {
      return null;
    }
    const n = Number(cliRaw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return envNumber("CURSOR_AGENT_TIMEOUT_MS", 60_000);
}

function getMode(): AgentMode {
  const m = process.env.CURSOR_AGENT_MODE?.trim().toLowerCase();
  if (m === "openai_compat" || m === "openai") return "openai_compat";
  if (m === "cursor_cli" || m === "cli") return "cursor_cli";
  return "simple";
}

function normalizeOpenAiChatUrl(url: string): string {
  const u = url.trim();
  if (u.includes("/chat/completions")) return u;
  return `${u.replace(/\/$/, "")}/chat/completions`;
}

function parseExtraHeaders(): Record<string, string> {
  const raw = process.env.CURSOR_AGENT_HEADERS?.trim();
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function formatFetchError(err: unknown, url: string): Error {
  if (!(err instanceof Error)) return new Error(String(err));
  const msg = err.message;
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ECONNREFUSED") {
      return new Error(
        `${msg} (${code}) — 无法连接 ${url}。请确认 ClawBot/HTTP 服务已启动，或改用 openai_compat + cursor-agent-api-proxy（默认 4646 端口）。`,
      );
    }
    return new Error(`${msg} | cause: ${cause.message}`);
  }
  if (err.name === "AbortError") {
    return new Error(`请求超时（${url}），可调大 CURSOR_AGENT_TIMEOUT_MS`);
  }
  return err;
}

/** 解析 `agent -p --output-format json` 的最后一行或整段 JSON（成功时优先信任内容，不依赖 exit code）。 */
function parseAgentCliJsonOutput(stdout: string): CursorAgentChatResponse | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  const tryParse = (s: string): CursorAgentChatResponse | null => {
    let json: unknown;
    try {
      json = JSON.parse(s);
    } catch {
      return null;
    }
    const o = json as {
      type?: string;
      subtype?: string;
      is_error?: boolean;
      result?: unknown;
      session_id?: unknown;
    };

    if (o.type === "result" && o.subtype === "success" && o.is_error === false) {
      const reply = typeof o.result === "string" ? o.result : "";
      const sessionId = typeof o.session_id === "string" ? o.session_id : undefined;
      return {
        reply: reply.trim() ? reply : "（Cursor agent 未返回内容）",
        sessionId,
      };
    }

    if (o.type === "result" && o.is_error === true) {
      const msg = typeof o.result === "string" ? o.result : JSON.stringify(o);
      throw new Error(`agent CLI 返回错误: ${msg}`);
    }

    return null;
  };

  const oneLine = tryParse(trimmed);
  if (oneLine) return oneLine;

  // 多行输出时取最后一行 JSON（避免 ANSI/日志前缀）
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith("{")) continue;
    const fromLine = tryParse(line);
    if (fromLine) return fromLine;
  }

  return null;
}

export class CursorAgentClient {
  private url: string;
  private timeoutMs: number;
  private systemPrompt?: string;
  private mode: AgentMode;
  private extraHeaders: Record<string, string>;

  constructor(opts?: { url?: string; timeoutMs?: number; systemPrompt?: string }) {
    const url = opts?.url ?? process.env.CURSOR_AGENT_URL;
    if (!url) {
      throw new Error("请设置环境变量 CURSOR_AGENT_URL（指向可调用 Cursor agent 的 HTTP 服务）");
    }
    this.url = url.trim();
    this.timeoutMs = opts?.timeoutMs ?? envNumber("CURSOR_AGENT_TIMEOUT_MS", 60_000);
    this.systemPrompt = opts?.systemPrompt ?? process.env.CURSOR_SYSTEM_PROMPT;
    this.mode = getMode();
    this.extraHeaders = parseExtraHeaders();
  }

  async chat(req: CursorAgentChatRequest): Promise<CursorAgentChatResponse> {
    if (this.mode === "openai_compat") {
      const reply = await this.chatOpenAiCompat(req);
      return { reply };
    }
    if (this.mode === "cursor_cli") {
      const task = await this.startCursorCliTask(req);
      return await task.promise;
    }
    const reply = await this.chatSimple(req);
    return { reply };
  }

  private async chatSimple(req: CursorAgentChatRequest): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.extraHeaders,
        },
        body: JSON.stringify({
          userId: req.userId,
          text: req.text,
          meta: req.meta,
          systemPrompt: req.systemPrompt ?? this.systemPrompt,
        } satisfies CursorAgentChatRequest),
        signal: controller.signal,
      });

      const text = await res.text();
      if (!res.ok) throw new Error(`Cursor agent HTTP ${res.status}: ${text}`);

      const json = JSON.parse(text) as Partial<CursorAgentChatResponse>;
      const reply = typeof json.reply === "string" ? json.reply : "";
      if (!reply.trim()) return "（Cursor agent 未返回内容）";
      return reply;
    } catch (err) {
      throw formatFetchError(err, this.url);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * OpenAI 兼容 POST /v1/chat/completions（例如 npm 包 cursor-agent-api-proxy，默认 http://localhost:4646）
   */
  private async chatOpenAiCompat(req: CursorAgentChatRequest): Promise<string> {
    const endpoint = normalizeOpenAiChatUrl(this.url);
    const apiKey = process.env.CURSOR_AGENT_API_KEY?.trim() || "not-needed";
    const model = process.env.CURSOR_OPENAI_MODEL?.trim() || "auto";
    const system = req.systemPrompt ?? this.systemPrompt;

    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
    if (system?.trim()) messages.push({ role: "system", content: system });
    messages.push({
      role: "user",
      content: `[wechat userId=${req.userId}]\n${req.text}`,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          ...this.extraHeaders,
        },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
        }),
        signal: controller.signal,
      });

      const text = await res.text();
      if (!res.ok) throw new Error(`OpenAI-compat HTTP ${res.status}: ${text}`);

      const json = JSON.parse(text) as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      const content = json.choices?.[0]?.message?.content;
      const reply = typeof content === "string" ? content : "";
      if (!reply.trim()) return "（Cursor agent 未返回内容）";
      return reply;
    } catch (err) {
      throw formatFetchError(err, endpoint);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 直接调用本机 Cursor CLI：agent -p --output-format json --trust --model auto "<prompt>"
   * 用于绕过任何 HTTP 插件/代理不稳定问题。
   */
  async startCursorCliTask(req: CursorAgentChatRequest): Promise<{
    pid?: number;
    kill: () => void;
    promise: Promise<CursorAgentChatResponse>;
  }> {
    if (this.mode !== "cursor_cli") {
      throw new Error("startCursorCliTask 仅支持 CURSOR_AGENT_MODE=cursor_cli");
    }
    const { spawn } = await import("node:child_process");
    const fs = await import("node:fs");

    const model = process.env.CURSOR_CLI_MODEL?.trim() || "auto";
    const system = (req.systemPrompt ?? this.systemPrompt)?.trim();
    const prompt = system
      ? `${system}\n\n[wechat userId=${req.userId}]\n${req.text}`
      : `[wechat userId=${req.userId}]\n${req.text}`;

    const agentPath = resolveAgentExecutable();
    const env = withCursorAgentPath(process.env);

    const args = ["-p", "--output-format", "json", "--trust", "--model", model];
    if (req.resumeSessionId?.trim()) {
      args.push("--resume", req.resumeSessionId.trim());
    }
    args.push(prompt);
    const isWin = process.platform === "win32";
    const lower = agentPath.toLowerCase();
    const isCmdLike = isWin && (lower.endsWith(".cmd") || lower.endsWith(".bat"));
    const isPs1 = isWin && lower.endsWith(".ps1");

    // Defensive: only fail fast when user explicitly set CURSOR_CLI_PATH.
    if (process.env.CURSOR_CLI_PATH?.trim()) {
      if (!fs.existsSync(agentPath)) {
        throw new Error(`未找到 Cursor CLI 可执行文件：${agentPath}（请检查 CURSOR_CLI_PATH）`);
      }
    }

    const child = isCmdLike
      ? spawn("cmd.exe", ["/d", "/s", "/c", `"${agentPath}"`, ...args], {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          cwd: process.cwd(),
          env,
        })
      : isPs1
        ? spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", agentPath, ...args], {
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
            cwd: process.cwd(),
            env,
          })
        : spawn(agentPath, args, {
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
            cwd: process.cwd(),
            env,
          });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const killAfterMs = getCursorCliKillTimeoutMs();
    let killedByTimeout = false;
    const killTimer =
      killAfterMs === null
        ? null
        : setTimeout(() => {
            killedByTimeout = true;
            try {
              child.kill();
            } catch {}
          }, killAfterMs);

    let finished = false;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    const hb = req.cliHeartbeat;
    const startedAt = Date.now();
    if (hb && hb.intervalMs > 0) {
      let tickBusy = false;
      heartbeatTimer = setInterval(() => {
        if (finished) return;
        if (tickBusy) return;
        tickBusy = true;
        void Promise.resolve(hb.onTick(Date.now() - startedAt))
          .catch((e) => console.error(`[agent] cliHeartbeat: ${String(e)}`))
          .finally(() => {
            tickBusy = false;
          });
      }, hb.intervalMs);
    }

    const promise = (async (): Promise<CursorAgentChatResponse> => {
      child.stdout.on("data", (d) => stdoutChunks.push(Buffer.from(d)));
      child.stderr.on("data", (d) => stderrChunks.push(Buffer.from(d)));

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve(code));
      });

      const stdout = Buffer.concat(stdoutChunks).toString("utf-8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();

      // Windows 上经 powershell/agent.ps1 启动时，子进程 exit code 常为 null，但 stdout 已是合法 JSON 成功结果。
      // 因此：优先按 stdout 解析；只有解析不到成功结果时，才用 exitCode 判失败。
      const parsed = parseAgentCliJsonOutput(stdout);
      if (parsed) {
        return parsed;
      }

      if (killedByTimeout) {
        throw new CursorCliAbortedError(
          "timeout",
          `agent CLI 因超时已被终止（${killAfterMs}ms），无完整结果`,
        );
      }

      if (exitCode !== 0 && exitCode !== null) {
        throw new CursorCliAbortedError(
          "exit",
          `agent CLI 异常退出 code=${exitCode}: ${stderr || stdout.slice(0, 300) || "no output"}`,
        );
      }

      throw new CursorCliAbortedError(
        "incomplete",
        `agent CLI 无有效 JSON 输出（exit=${exitCode ?? "null"}）: ${stderr || stdout.slice(0, 500) || "no output"}`,
      );
    })().finally(() => {
      finished = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (killTimer) clearTimeout(killTimer);
    });

    return {
      pid: child.pid ?? undefined,
      kill: () => {
        try {
          child.kill();
        } catch {}
      },
      promise,
    };
  }
}

function resolveAgentExecutable(): string {
  const explicit = process.env.CURSOR_CLI_PATH?.trim();
  if (explicit) return explicit;

  if (process.platform === "win32") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require("node:fs") as typeof import("node:fs");
      const localAppData = process.env.LOCALAPPDATA;
      if (localAppData) {
        const ps1 = `${localAppData}\\cursor-agent\\agent.ps1`;
        const cmd = `${localAppData}\\cursor-agent\\agent.cmd`;
        if (fs.existsSync(ps1)) return ps1;
        if (fs.existsSync(cmd)) return cmd;
      }
    } catch {
      // ignore
    }
  }

  return "agent";
}

function withCursorAgentPath(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform !== "win32") return base;
  const localAppData = base.LOCALAPPDATA;
  if (!localAppData) return base;

  const extra = [
    `${localAppData}\\cursor-agent`,
    `${localAppData}\\Programs\\cursor\\resources\\app\\bin`,
  ];
  const current = base.PATH || base.Path || "";
  const sep = ";";
  const pathValue = `${extra.join(sep)}${sep}${current}`;

  return {
    ...base,
    PATH: pathValue,
    Path: pathValue,
  };
}
