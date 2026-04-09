/**
 * iLink 文本消息无 Markdown 渲染，将常见 Markdown / Agent 输出转成微信里更易读的纯文本（图标 + 分隔线）。
 */

export function shouldFormatWeChatReply(): boolean {
  const raw = process.env.WECHAT_FORMAT_REPLY?.trim().toLowerCase();
  if (!raw) return true;
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "plain");
}

export function formatReplyForWeChat(input: string): string {
  let s = input.replace(/\r\n/g, "\n");
  if (!s.trim()) return s;

  // 围栏代码块 ```lang\n...\n```
  s = s.replace(/```([\w+-]*)\n([\s\S]*?)```/g, (_, lang: string, code: string) => {
    const header = lang ? `📎 代码（${lang}）` : "📎 代码片段";
    const body = code.replace(/\n+$/g, "").trimEnd();
    return `\n${header}\n${body}\n────────\n`;
  });

  // 剩余单行 ```
  s = s.replace(/```([\s\S]*?)```/g, (_, inner: string) => {
    const body = inner.trim();
    return body ? `\n📎 ${body}\n────────\n` : "";
  });

  // 标题
  s = s.replace(/^####\s+(.+)$/gm, "🔹 $1");
  s = s.replace(/^###\s+(.+)$/gm, "📌 $1");
  s = s.replace(/^##\s+(.+)$/gm, "━━\n📋 $1");
  s = s.replace(/^#\s+(.+)$/gm, "━━\n⭐ $1");

  // 粗体 **x**（保留一层，避免嵌套灾难）
  s = s.replace(/\*\*([^*]+)\*\*/g, "「$1」");

  // 行内 `code`
  s = s.replace(/`([^`\n]+)`/g, "「$1」");

  // 无序列表
  s = s.replace(/^[\t ]*[-*]\s+(.+)$/gm, "  ▸ $1");

  // 有序列表
  s = s.replace(/^[\t ]*(\d+)\.\s+(.+)$/gm, "  $1. $2");

  // 引用 >
  s = s.replace(/^>\s?(.+)$/gm, "💬 $1");

  // 分隔线
  s = s.replace(/^[\t ]*([-*_]){3,}[\t ]*$/gm, "────────");

  // 常见小节关键词（轻量增强，可关）；长词在前避免「注意」误匹配「注意事项」
  if (process.env.WECHAT_FORMAT_KEYWORDS?.trim().toLowerCase() !== "0") {
    s = s.replace(/^注意事项[:：]?\s*/gim, "⚠️ 注意事项：");
    s = s.replace(/^注意[:：]?\s*/gim, "⚠️ 注意：");
    s = s.replace(/^警告[:：]?\s*/gim, "⚠️ 警告：");
    s = s.replace(/^Warning[:：]?\s*/gim, "⚠️ Warning：");
    s = s.replace(/^总结[:：]?\s*/gim, "📝 总结：");
    s = s.replace(/^结论[:：]?\s*/gim, "📝 结论：");
    s = s.replace(/^小结[:：]?\s*/gim, "📝 小结：");
    s = s.replace(/^操作步骤[:：]?\s*/gim, "🔢 操作步骤：");
    s = s.replace(/^步骤[:：]?\s*/gim, "🔢 步骤：");
    s = s.replace(/^示例[:：]?\s*/gim, "💡 示例：");
    s = s.replace(/^例子[:：]?\s*/gim, "💡 例子：");
  }

  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/** 按长度切分，优先在空行处断开，避免单条过长。 */
export function splitReplyForWeChat(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const chunk = rest.slice(0, maxChars);
    let end = maxChars;
    const pp = chunk.lastIndexOf("\n\n");
    if (pp > maxChars * 0.25) end = pp;
    else {
      const nl = chunk.lastIndexOf("\n");
      if (nl > maxChars * 0.5) end = nl;
    }
    let piece = rest.slice(0, end).trimEnd();
    if (!piece) {
      piece = rest.slice(0, maxChars);
      end = maxChars;
    }
    parts.push(piece.trimEnd());
    rest = rest.slice(end).replace(/^\n+/, "").trimStart();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

export function envWeChatMaxCharsPerMessage(): number {
  const raw = process.env.WECHAT_MAX_CHARS_PER_MESSAGE?.trim();
  if (!raw) return 3500;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 500 ? Math.floor(n) : 3500;
}
