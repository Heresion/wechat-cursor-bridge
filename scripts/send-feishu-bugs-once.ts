import fs from "node:fs/promises";
import https from "node:https";
import crypto from "node:crypto";
import { CursorAgentClient } from "../src/cursor/agentClient.ts";

type Credentials = {
  token: string;
  baseUrl: string;
  userId: string;
};

async function loadDotEnvFile(filePath: string): Promise<void> {
  const raw = await fs.readFile(filePath, "utf-8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

async function sendTextMessageRaw(
  baseUrl: string,
  token: string,
  to: string,
  text: string,
): Promise<void> {
  const u = new URL("ilink/bot/sendmessage", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const payload = JSON.stringify({
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: `bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text } }],
    },
  });

  await new Promise<void>((resolve, reject) => {
    const req = https.request(
      u,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          AuthorizationType: "ilink_bot_token",
          "X-WECHAT-UIN": randomWechatUin(),
          Authorization: `Bearer ${token}`,
          "Content-Length": String(Buffer.byteLength(payload, "utf-8")),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`sendmessage HTTP ${res.statusCode}: ${body}`));
            return;
          }
          resolve();
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function buildPrompt(wechatUserId: string): string {
  const page = 1;
  const size = 20;
  const offset = (page - 1) * size;
  return [
    "请通过 MCP 服务器 FeishuProjectMcp 查询飞书项目缺陷列表，并给出简洁结果。",
    `当前微信用户ID：${wechatUserId}`,
    "查询范围：仅我相关（指向我/分配给我）",
    `分页参数：page=${page}, size=${size}, offset=${offset}`,
    "指定项目Key：未指定（自动选择最近/默认项目）",
    "",
    "执行要求：",
    "1) 必须优先使用 MCP（FeishuProjectMcp）获取实时数据，不要臆造。",
    "2) 若指定了项目Key，优先使用该项目；否则自动尝试可用默认/最近项目。",
    "3) 按优先级和更新时间排序，返回本页数据（最多 size 条）。",
    "4) 输出字段：缺陷ID、标题、状态、优先级、负责人、更新时间。",
    "5) 最后给出统计：总数、进行中、待处理、已解决，并提示下一页命令示例。",
  ].join("\n");
}

async function main(): Promise<void> {
  await loadDotEnvFile(".env");
  const creds = JSON.parse(
    await fs.readFile("data/credentials.json", "utf-8"),
  ) as Credentials;

  const agent = new CursorAgentClient();
  const resp = await agent.chat({
    userId: creds.userId,
    text: buildPrompt(creds.userId),
  });

  const fullText = `【/feishu-bugs 查询结果】\n\n${resp.reply}`;
  const maxChars = 2600;
  const chunks: string[] = [];
  for (let i = 0; i < fullText.length; i += maxChars) {
    chunks.push(fullText.slice(i, i + maxChars));
  }

  for (let i = 0; i < chunks.length; i++) {
    const body =
      chunks.length > 1 && i > 0 ? `【${i + 1}/${chunks.length}】\n${chunks[i]}` : chunks[i];
    await sendTextMessageRaw(creds.baseUrl, creds.token, creds.userId, body);
  }

  console.log(`sent chunks=${chunks.length}, replyLen=${resp.reply.length}`);
}

void main();
