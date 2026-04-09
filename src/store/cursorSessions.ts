import fs from "node:fs/promises";
import path from "node:path";

export type CursorSessionMap = Record<string, string>;

const SESSIONS_PATH = path.resolve("data/sessions.json");

export async function loadCursorSessions(): Promise<CursorSessionMap> {
  try {
    const raw = await fs.readFile(SESSIONS_PATH, "utf-8");
    const json = JSON.parse(raw) as unknown;
    if (!json || typeof json !== "object") return {};
    const out: CursorSessionMap = {};
    for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export async function saveCursorSessions(map: CursorSessionMap): Promise<void> {
  await fs.mkdir(path.dirname(SESSIONS_PATH), { recursive: true });
  await fs.writeFile(SESSIONS_PATH, JSON.stringify(map, null, 2), "utf-8");
}

