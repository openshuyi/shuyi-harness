/**
 * 联网工具（M4）：webfetch / websearch。
 *
 * 安全红线（文档 §M4）：
 * - SSRF 防护：仅 http/https；内网/环回/链路本地地址一律拒绝（权限链 deny_builtin + 执行时双重把关）
 * - 输出统一截断：响应体按 maxBytes 截断，最终输出沿用 32KB 上限
 * - 两个工具对子代理默认隐藏（subagentVisible: false）
 *
 * 本地优先：webfetch 默认启用（纯出站只读）；websearch 默认不注册（见 config/net.ts）。
 * 测试可注入 fetchFn，不触网。
 */
import { z } from "zod";
import type { ToolDefinition, ToolResult } from "./index.js";
import type { WebfetchConfig, WebsearchConfig } from "../config/net.js";

const MAX_OUTPUT = 32 * 1024;

// ---------- SSRF 防护 ----------

/** 内网/环回/链路本地 IPv4 判定 */
function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a > 255 || b > 255 || Number(m[3]) > 255 || Number(m[4]) > 255) return true; // 畸形按内网处理（fail-closed）
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 || // 10.0.0.0/8
    a === 127 || // 127.0.0.0/8 环回
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 169 && b === 254) // 169.254.0.0/16 链路本地（云元数据）
  );
}

/**
 * URL 安全性检查：返回拒绝原因，null 表示允许。
 * fail-closed：解析失败、非 http/https、内网地址一律拒绝。
 */
export function urlSafetyDenyReason(rawUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return `无法解析的 URL：${rawUrl}`;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return `禁止的协议 ${u.protocol}（仅允许 http/https，file:// 等被 SSRF 防护拦截）`;
  }
  const host = u.hostname.toLowerCase();
  if (!host) return "URL 缺少主机名";
  if (host === "localhost" || host.endsWith(".localhost")) return `禁止访问环回地址 ${host}`;
  if (host === "::1" || host === "[::1]") return "禁止访问环回地址 ::1";
  if (isPrivateIpv4(host)) return `禁止访问内网/环回地址 ${host}（SSRF 防护）`;
  return null;
}

// ---------- HTML → markdown（轻量自研） ----------

const VOID_STRIP = /<(script|style|nav|footer|header|aside|noscript|template|iframe|svg|form)\b[^>]*>[\s\S]*?<\/\1>/gi;

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ""));
}

function inline(s: string): string {
  let out = s;
  // 行内代码（先于去标签，保留反引号语义）
  out = out.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, c) => `\`${stripTags(c).replace(/`/g, "'")}\``);
  // 链接：[text](href)
  out = out.replace(/<a\b[^>]*?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
    const label = stripTags(text).trim();
    if (!label) return "";
    return href && !href.startsWith("javascript:") ? `[${label}](${href})` : label;
  });
  out = out.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, c) => `**${stripTags(c)}**`);
  out = out.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, c) => `*${stripTags(c)}*`);
  return stripTags(out.replace(/<br\s*\/?>/gi, "\n"));
}

/** 表格 → markdown 表格（简单实现：首行为表头） */
function convertTable(tableHtml: string): string {
  const rows: string[][] = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(tableHtml))) {
    const cells: string[] = [];
    const cellRe = /<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rm[1]))) cells.push(inline(cm[1]).trim().replace(/\|/g, "\\|").replace(/\n+/g, " "));
    if (cells.length) rows.push(cells);
  }
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const norm = rows.map((r) => [...r, ...Array(width - r.length).fill("")]);
  const lines = [
    `| ${norm[0].join(" | ")} |`,
    `| ${norm[0].map(() => "---").join(" | ")} |`,
    ...norm.slice(1).map((r) => `| ${r.join(" | ")} |`),
  ];
  return `\n\n${lines.join("\n")}\n\n`;
}

/**
 * HTML → markdown：去 script/style/nav/footer 等噪声，保留正文结构、
 * 代码块（pre/code）、表格、链接、标题、列表。
 */
export function htmlToMarkdown(html: string): string {
  let h = html.replace(VOID_STRIP, "");
  // 代码块先行提取（防止内部标签被处理）；占位符用不可能出现在正文的形式
  const codeBlocks: string[] = [];
  h = h.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, c) => {
    codeBlocks.push(decodeEntities(c.replace(/<[^>]+>/g, "")).replace(/^\n+|\n+$/g, ""));
    return `\n\nSHUYIPRE${codeBlocks.length - 1}SHUYI\n\n`;
  });
  // 表格提取
  const tables: string[] = [];
  h = h.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (m) => {
    tables.push(convertTable(m));
    return `\n\nSHUYITBL${tables.length - 1}SHUYI\n\n`;
  });
  // 标题
  h = h.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, c) => `\n\n${"#".repeat(Number(lvl))} ${inline(c).trim()}\n\n`);
  // 列表项
  h = h.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, c) => `\n- ${inline(c).trim()}`);
  // 引用
  h = h.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, c) => {
    const body = inline(c).trim().split("\n").map((l: string) => `> ${l}`).join("\n");
    return `\n\n${body}\n\n`;
  });
  // 段落与块级换行
  h = h.replace(/<\/(p|div|section|article|ul|ol|main|figure)>/gi, "\n\n");
  h = h.replace(/<br\s*\/?>/gi, "\n");
  // 剩余行内元素（a/code/strong/em）
  h = h.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, c) => `\`${stripTags(c)}\``);
  h = h.replace(/<a\b[^>]*?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
    const label = stripTags(text).trim();
    return href && !href.startsWith("javascript:") ? `[${label}](${href})` : label;
  });
  h = h.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  h = h.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");
  // 去剩余标签 + 实体解码
  let text = stripTags(h);
  // 回填代码块与表格
  text = text.replace(/SHUYIPRE(\d+)SHUYI/g, (_, i) => `\n\n\`\`\`\n${codeBlocks[Number(i)]}\n\`\`\`\n\n`);
  text = text.replace(/SHUYITBL(\d+)SHUYI/g, (_, i) => tables[Number(i)]);
  // 收敛空行与行首空白
  return text
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, "").replace(/^[ \t]+(?=\S)/, (m) => (m.length > 8 ? " " : m)))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 纯文本模式：去全部标签，保留换行结构 */
export function htmlToText(html: string): string {
  const h = html.replace(VOID_STRIP, "");
  return stripTags(h.replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n").replace(/<br\s*\/?>/gi, "\n"))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------- 可注入的 fetch（测试 mock，不触网） ----------

export interface WebToolsDeps {
  fetchFn?: typeof fetch;
}

function truncateOut(text: string): ToolResult {
  if (text.length <= MAX_OUTPUT) return { result: text, truncated: false };
  return {
    result: text.slice(0, MAX_OUTPUT) + `\n… [输出过长已截断，共 ${text.length} 字符]`,
    truncated: true,
  };
}

// ---------- webfetch ----------

export function createWebfetchTool(cfg: WebfetchConfig, deps: WebToolsDeps = {}): ToolDefinition {
  const doFetch = deps.fetchFn ?? fetch;
  return {
    name: "webfetch",
    description:
      "抓取 URL 内容并转为 markdown（也可选 text/html 原文）。仅允许公网 http/https 地址；内网与 file:// 被内置规则拒绝。",
    permission: "always-ask", // 出站请求必须用户可见
    subagentVisible: false, // 对子代理默认隐藏（文档 §M4 安全红线）
    argsSchema: z.object({
      url: z.string().describe("要抓取的 http/https URL"),
      format: z.enum(["markdown", "text", "html"]).default("markdown").describe("输出格式"),
      maxBytes: z.number().int().min(1024).max(1_000_000).optional().describe("响应体读取上限（字节）"),
    }),
    involvedUrls: (args) => [args.url as string],
    riskSummary: (args) => `出站请求 ${args.url}`,
    async execute(args) {
      const url = args.url as string;
      const deny = urlSafetyDenyReason(url);
      if (deny) throw new Error(deny); // 执行时双重把关（权限链 deny_builtin 已先拦）
      const maxBytes = Math.min((args.maxBytes as number) ?? cfg.maxBytes, cfg.maxBytes);
      const res = await doFetch(url, {
        signal: AbortSignal.timeout(cfg.timeoutMs),
        headers: { "user-agent": "shuyi-agent/0.3 (+https://local)" },
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      const sliced = buf.slice(0, maxBytes);
      const body = new TextDecoder("utf-8", { fatal: false }).decode(sliced);
      const contentType = res.headers.get("content-type") ?? "";
      const format = (args.format as string) ?? "markdown";
      const isHtml = contentType.includes("html") || /^\s*<!doctype html|^\s*<html/i.test(body);
      let out: string;
      if (format === "html" || !isHtml) {
        out = body;
      } else if (format === "text") {
        out = htmlToText(body);
      } else {
        out = htmlToMarkdown(body);
      }
      const header = `[${url} · ${res.status} · ${contentType || "unknown"}${buf.length > maxBytes ? ` · 已按 maxBytes=${maxBytes} 截断` : ""}]`;
      return truncateOut(`${header}\n\n${out}`);
    },
  };
}

// ---------- websearch ----------

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
}

/** P1-8：统一搜索结果模型（各 provider 归一化到此结构） */
interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function searchTavily(
  cfg: WebsearchConfig,
  query: string,
  maxResults: number,
  doFetch: typeof fetch,
): Promise<SearchResult[]> {
  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`未配置搜索 API Key：请设置环境变量 ${cfg.apiKeyEnv}（见 ~/.agent/net.json）`);
  }
  const res = await doFetch("https://api.tavily.com/search", {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults }),
  });
  if (!res.ok) throw new Error(`Tavily 搜索请求失败 HTTP ${res.status}`);
  const data = (await res.json()) as { results?: TavilyResult[] };
  return (data.results ?? []).slice(0, maxResults).map((r) => ({
    title: r.title ?? "(无标题)",
    url: r.url ?? "",
    snippet: (r.content ?? "").slice(0, 300),
  }));
}

interface ExaResult {
  title?: string;
  url?: string;
  text?: string;
}

async function searchExa(
  cfg: WebsearchConfig,
  query: string,
  maxResults: number,
  doFetch: typeof fetch,
): Promise<SearchResult[]> {
  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`未配置搜索 API Key：请设置环境变量 ${cfg.apiKeyEnv}（见 ~/.agent/net.json）`);
  }
  const res = await doFetch("https://api.exa.ai/search", {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      query,
      numResults: maxResults,
      contents: { text: { maxCharacters: 300 } },
    }),
  });
  if (!res.ok) throw new Error(`Exa 搜索请求失败 HTTP ${res.status}`);
  const data = (await res.json()) as { results?: ExaResult[] };
  return (data.results ?? []).slice(0, maxResults).map((r) => ({
    title: r.title ?? "(无标题)",
    url: r.url ?? "",
    snippet: (r.text ?? "").slice(0, 300),
  }));
}

/**
 * DuckDuckGo 免密源（P1-8）：GET html.duckduckgo.com 的轻量 HTML 端点，正则提取结果。
 * 无需 API key，作为主源失败/未配 key 时的降级路径（本地优先的联网兜底）。
 */
async function searchDuckDuckGo(
  query: string,
  maxResults: number,
  doFetch: typeof fetch,
): Promise<SearchResult[]> {
  const res = await doFetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
      accept: "text/html",
    },
  });
  if (!res.ok) throw new Error(`DuckDuckGo 搜索请求失败 HTTP ${res.status}`);
  const html = await res.text();
  const results: SearchResult[] = [];
  // 结果块：<a class="result__a" href="//duckduckgo.com/l/?uddg=<urlencoded>">标题</a>
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html))) snippets.push(stripTags(sm[1]).slice(0, 300));
  let lm: RegExpExecArray | null;
  let i = 0;
  while ((lm = linkRe.exec(html)) && results.length < maxResults) {
    let url = decodeEntities(lm[1]);
    // 跳转链接 //duckduckgo.com/l/?uddg=<encoded> → 取真实目标
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    else if (url.startsWith("//")) url = `https:${url}`;
    results.push({
      title: stripTags(lm[2]) || "(无标题)",
      url,
      snippet: snippets[i] ?? "",
    });
    i++;
  }
  return results;
}

export function createWebsearchTool(cfg: WebsearchConfig, deps: WebToolsDeps = {}): ToolDefinition {
  const doFetch = deps.fetchFn ?? fetch;
  return {
    name: "websearch",
    description: `联网搜索（provider: ${cfg.provider}），返回标题/链接/摘要列表。`,
    permission: "always-allow", // 只出站查询无副作用
    subagentVisible: false,
    argsSchema: z.object({
      query: z.string().describe("搜索查询"),
      maxResults: z.number().int().min(1).max(20).optional().describe("返回条数"),
    }),
    async execute(args) {
      const maxResults = Math.min((args.maxResults as number) ?? cfg.maxResults, 20);
      const query = args.query as string;
      let results: SearchResult[];
      let sourceNote = "";
      try {
        if (cfg.provider === "tavily") {
          results = await searchTavily(cfg, query, maxResults, doFetch);
        } else if (cfg.provider === "exa") {
          results = await searchExa(cfg, query, maxResults, doFetch);
        } else if (cfg.provider === "duckduckgo") {
          results = await searchDuckDuckGo(query, maxResults, doFetch);
        } else {
          throw new Error(`不支持的搜索 provider：${cfg.provider}（支持 tavily / exa / duckduckgo）`);
        }
      } catch (err) {
        // P1-8：主源失败（含缺 key/HTTP 错误）→ 免密降级源（本地优先的联网兜底）
        if (!cfg.fallback || cfg.provider === "duckduckgo") throw err;
        results = await searchDuckDuckGo(query, maxResults, doFetch);
        sourceNote = `[主搜索源（${cfg.provider}）不可用：${err instanceof Error ? err.message : String(err)}；已降级 DuckDuckGo 免密源]\n\n`;
      }
      if (results.length === 0) return { result: `(无结果：${query})`, truncated: false };
      const lines = results.map(
        (r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`,
      );
      return truncateOut(`${sourceNote}搜索「${query}」共 ${results.length} 条：\n\n${lines.join("\n\n")}`);
    },
  };
}
