/**
 * 联网能力配置（M4）：~/.agent/net.json（可选）。
 *
 * {
 *   "webfetch":  { "enabled": true,  "maxBytes": 100000, "timeoutMs": 15000 },
 *   "websearch": { "enabled": false, "provider": "tavily", "apiKeyEnv": "TAVILY_API_KEY", "maxResults": 5 }
 * }
 *
 * 缺省（无配置文件 / 解析失败）：webfetch 启用（纯 fetch，出站只读），
 * websearch 不启用（工具不注册，模型看不到）——这就是默认降级路径（本地优先）。
 */
import fs from "node:fs";
import path from "node:path";

export interface WebfetchConfig {
  enabled: boolean;
  maxBytes: number;
  timeoutMs: number;
}

export interface WebsearchConfig {
  enabled: boolean;
  /** P1-8：tavily / exa / duckduckgo（免密） */
  provider: string;
  apiKeyEnv: string;
  maxResults: number;
  /** P1-8：主源失败（含缺 API key）时降级 duckduckgo 免密源（默认 true） */
  fallback: boolean;
}

export interface NetConfig {
  webfetch: WebfetchConfig;
  websearch: WebsearchConfig;
}

/** 缺省值：与文档 §M4 一致（webfetch 开、websearch 关） */
export function defaultNetConfig(): NetConfig {
  return {
    webfetch: { enabled: true, maxBytes: 100_000, timeoutMs: 15_000 },
    websearch: { enabled: false, provider: "tavily", apiKeyEnv: "TAVILY_API_KEY", maxResults: 5, fallback: true },
  };
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

export function loadNetConfig(home?: string): NetConfig {
  const cfg = defaultNetConfig();
  const file = path.join(home ?? process.env.HOME ?? ".", ".agent", "net.json");
  let raw: unknown;
  try {
    if (!fs.existsSync(file)) return cfg;
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return cfg; // 解析失败 → 缺省（websearch 保持关闭，fail-safe）
  }
  if (!raw || typeof raw !== "object") return cfg;
  const o = raw as Record<string, unknown>;

  const wf = o.webfetch as Record<string, unknown> | undefined;
  if (wf && typeof wf === "object") {
    if (typeof wf.enabled === "boolean") cfg.webfetch.enabled = wf.enabled;
    cfg.webfetch.maxBytes = clampInt(wf.maxBytes, cfg.webfetch.maxBytes, 1024, 1_000_000);
    cfg.webfetch.timeoutMs = clampInt(wf.timeoutMs, cfg.webfetch.timeoutMs, 1000, 60_000);
  }

  const ws = o.websearch as Record<string, unknown> | undefined;
  if (ws && typeof ws === "object") {
    if (typeof ws.enabled === "boolean") cfg.websearch.enabled = ws.enabled;
    if (typeof ws.provider === "string" && ws.provider) cfg.websearch.provider = ws.provider;
    if (typeof ws.apiKeyEnv === "string" && ws.apiKeyEnv) cfg.websearch.apiKeyEnv = ws.apiKeyEnv;
    cfg.websearch.maxResults = clampInt(ws.maxResults, cfg.websearch.maxResults, 1, 20);
    if (typeof ws.fallback === "boolean") cfg.websearch.fallback = ws.fallback;
  }
  return cfg;
}
