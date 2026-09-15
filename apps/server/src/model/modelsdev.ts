/**
 * Models.dev 元数据源（P8-6，对齐 OpenCode 的 models.dev 集成）：
 * 从 https://models.dev/api.json 拉取社区维护的模型元数据
 * （上下文窗口、输入/输出/缓存价格），用户只填 API key 即可获得
 * 准确的压缩阈值与成本估算。
 *
 * 策略：
 * - 24h 磁盘缓存（~/.agent/models-dev-cache.json），离线时回退缓存
 * -  enrich 只补空缺：用户显式配置的 contextWindow/pricing 不被覆盖
 * - 拉取失败静默降级（元数据只是增强，不是必需品）
 */
import fs from "node:fs";
import path from "node:path";
import type { ModelPricing } from "./types.js";
import { OpenAICompatAdapter } from "./openai.js";
import type { RuntimeModelRegistry } from "./registry.js";

const MODELS_DEV_URL = "https://models.dev/api.json";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface ModelsDevEntry {
  contextWindow?: number;
  pricing?: ModelPricing;
}

type Fetcher = (url: string) => Promise<string>;

export interface ModelsDevOptions {
  cacheFile?: string;
  ttlMs?: number;
  /** 测试注入；缺省用全局 fetch */
  fetcher?: Fetcher;
  /** 跳过网络请求（只用磁盘缓存） */
  offline?: boolean;
}

function defaultCacheFile(): string {
  return path.join(process.env.HOME ?? "/root", ".agent", "models-dev-cache.json");
}

/** 解析 models.dev api.json → 扁平映射（key: 模型 id 与 provider/模型 id） */
export function parseModelsDev(raw: string): Map<string, ModelsDevEntry> {
  const out = new Map<string, ModelsDevEntry>();
  const data = JSON.parse(raw) as Record<
    string,
    {
      models?: Record<
        string,
        {
          limit?: { context?: number };
          cost?: { input?: number; output?: number; cache_read?: number };
        }
      >;
    }
  >;
  for (const [provider, p] of Object.entries(data)) {
    for (const [modelId, m] of Object.entries(p.models ?? {})) {
      const entry: ModelsDevEntry = {};
      const ctx = m.limit?.context;
      if (typeof ctx === "number" && ctx > 0) entry.contextWindow = ctx;
      const cost = m.cost;
      if (cost && typeof cost.input === "number" && typeof cost.output === "number") {
        entry.pricing = {
          input: cost.input,
          output: cost.output,
          cachedInput: typeof cost.cache_read === "number" && cost.cache_read > 0 ? cost.cache_read : undefined,
        };
      }
      if (!entry.contextWindow && !entry.pricing) continue;
      // provider/模型 id 精确键优先写入；裸模型 id 只在未占用时填（先到先得）
      out.set(`${provider}/${modelId}`, entry);
      if (!out.has(modelId)) out.set(modelId, entry);
    }
  }
  return out;
}

/** 加载元数据：缓存新鲜直接用，否则拉网络并回写缓存；失败回退旧缓存 */
export async function loadModelsDev(opts: ModelsDevOptions = {}): Promise<Map<string, ModelsDevEntry>> {
  const cacheFile = opts.cacheFile ?? defaultCacheFile();
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;

  const readCache = (): Map<string, ModelsDevEntry> | null => {
    try {
      const { fetchedAt, entries } = JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as {
        fetchedAt: number;
        entries: Record<string, ModelsDevEntry>;
      };
      const map = new Map(Object.entries(entries));
      return Date.now() - fetchedAt < ttl ? map : null;
    } catch {
      return null;
    }
  };

  const fresh = readCache();
  if (fresh) return fresh;
  if (opts.offline) {
    // 离线模式：过期缓存也接受
    try {
      const { entries } = JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as {
        entries: Record<string, ModelsDevEntry>;
      };
      return new Map(Object.entries(entries));
    } catch {
      return new Map();
    }
  }

  try {
    const fetcher: Fetcher =
      opts.fetcher ?? (async (url) => (await fetch(url, { signal: AbortSignal.timeout(10000) })).text());
    const raw = await fetcher(MODELS_DEV_URL);
    const map = parseModelsDev(raw);
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(
        cacheFile,
        JSON.stringify({ fetchedAt: Date.now(), entries: Object.fromEntries(map) }),
      );
    } catch {
      // 缓存写失败不影响返回
    }
    return map;
  } catch {
    // 网络失败：回退任意旧缓存
    if (opts.fetcher) return new Map(); // 测试注入失败不重读缓存
    return loadModelsDev({ ...opts, offline: true });
  }
}

/**
 * 用 models.dev 元数据补全注册表中缺失的 contextWindow/pricing。
 * 只补空缺，不覆盖用户显式配置。返回补全的适配器数量。
 */
export async function enrichFromModelsDev(
  registry: RuntimeModelRegistry,
  opts: ModelsDevOptions = {},
): Promise<number> {
  const meta = await loadModelsDev(opts);
  if (meta.size === 0) return 0;
  let enriched = 0;
  for (const adapter of registry.adapters.values()) {
    if (!(adapter instanceof OpenAICompatAdapter)) continue;
    const entry =
      meta.get(`${adapter.meta.provider}/${adapter.config.model}`) ?? meta.get(adapter.config.model);
    if (!entry) continue;
    let touched = false;
    if (!adapter.config.contextWindow && entry.contextWindow) {
      adapter.meta.contextWindow = entry.contextWindow;
      touched = true;
    }
    if (!adapter.config.pricing && entry.pricing) {
      adapter.meta.pricing = entry.pricing;
      touched = true;
    }
    if (touched) enriched++;
  }
  return enriched;
}
