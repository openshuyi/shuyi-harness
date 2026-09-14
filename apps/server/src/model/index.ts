/**
 * 模型适配层装配：从环境变量 + 持久化配置文件构建可用适配器列表。
 *
 * 配置来源（后者覆盖前者，同 id 合并）：
 * 1. 环境变量 AGENT_MODELS（竖线分隔字段，逗号分隔多个）：
 *      id|baseURL|apiKey|model[|label][|contextWindow][|input$/M][|output$/M][|cachedInput$/M]
 *    例：
 *      AGENT_MODELS="deepseek|https://api.deepseek.com/v1|sk-xxx|deepseek-chat|DeepSeek V3|64000|0.27|1.10|0.07"
 * 2. 配置文件 ~/.agent/models.json（模型管理 API 写入）：
 *      [{ "id": "...", "baseURL": "...", "apiKey": "...", "model": "...",
 *         "label": "...", "contextWindow": 128000,
 *         "pricing": { "input": 0.27, "output": 1.10, "cachedInput": 0.07 } }]
 *
 * 无配置时仅提供 mock。
 */
import { readFileSync } from "node:fs";
import type { ModelAdapter, ModelPricing } from "./types.js";
import { OpenAICompatAdapter } from "./openai.js";
import { MockAdapter } from "./mock.js";

export type { ModelAdapter, ModelMeta, ModelPricing } from "./types.js";
export { estimateCost } from "./types.js";
export { MockAdapter } from "./mock.js";
export { OpenAICompatAdapter, ModelRequestError } from "./openai.js";

export interface ModelRegistry {
  adapters: Map<string, ModelAdapter>;
  defaultModel: string;
}

/** 持久化模型条目（~/.agent/models.json 元素形状） */
export interface ModelConfigEntry {
  id: string;
  baseURL: string;
  apiKey: string;
  model: string;
  label?: string;
  contextWindow?: number;
  pricing?: ModelPricing;
}

function parsePricing(raw: {
  input?: string | number;
  output?: string | number;
  cachedInput?: string | number;
}): ModelPricing | undefined {
  const input = Number(raw.input);
  const output = Number(raw.output);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;
  const cached = Number(raw.cachedInput);
  return {
    input,
    output,
    cachedInput: Number.isFinite(cached) && cached > 0 ? cached : undefined,
  };
}

function fromEnv(env: NodeJS.ProcessEnv): ModelConfigEntry[] {
  const spec = env.AGENT_MODELS ?? "";
  const entries: ModelConfigEntry[] = [];
  for (const entry of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [id, baseURL, apiKey, model, label, ctx, input, output, cachedInput] = entry
      .split("|")
      .map((s) => s.trim());
    if (!id || !baseURL || !apiKey || !model) {
      console.warn(`[model] 忽略无法解析的 AGENT_MODELS 条目（应为 id|baseURL|apiKey|model[|...]）: ${entry}`);
      continue;
    }
    entries.push({
      id,
      baseURL,
      apiKey,
      model,
      label: label || undefined,
      contextWindow: Number.isFinite(Number(ctx)) && Number(ctx) > 0 ? Number(ctx) : undefined,
      pricing: parsePricing({ input, output, cachedInput }),
    });
  }
  return entries;
}

function fromConfigFile(path: string): ModelConfigEntry[] {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is ModelConfigEntry =>
        e && typeof e.id === "string" && typeof e.baseURL === "string" &&
        typeof e.apiKey === "string" && typeof e.model === "string",
    );
  } catch {
    return []; // 文件不存在或损坏均视为无配置
  }
}

export function buildModelRegistry(
  env: NodeJS.ProcessEnv = process.env,
  configFile?: string,
): ModelRegistry {
  const adapters = new Map<string, ModelAdapter>();
  const mock = new MockAdapter();
  adapters.set(mock.id, mock);

  // 环境变量先加载，配置文件后加载（后者可覆盖同 id）
  const entries = [...fromEnv(env), ...(configFile ? fromConfigFile(configFile) : [])];
  for (const e of entries) {
    adapters.set(
      e.id,
      new OpenAICompatAdapter({
        id: e.id,
        label: e.label || `${e.id} (${e.model})`,
        baseURL: e.baseURL,
        apiKey: e.apiKey,
        model: e.model,
        contextWindow: e.contextWindow,
        pricing: e.pricing,
      }),
    );
  }

  const firstReal = [...adapters.keys()].find((k) => k !== mock.id);
  return { adapters, defaultModel: firstReal ?? mock.id };
}
