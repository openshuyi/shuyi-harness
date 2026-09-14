/**
 * 运行时模型注册表：在静态 buildModelRegistry 之上增加
 * - 运行时增删模型（模型管理 API），改动持久化到 ~/.agent/models.json
 * - 按序 fallback：会话请求失败时按 fallback 链切换适配器
 */
import fs from "node:fs";
import path from "node:path";
import type { ModelAdapter, ModelPricing } from "./types.js";
import { OpenAICompatAdapter } from "./openai.js";
import { MockAdapter } from "./mock.js";
import { buildModelRegistry, type ModelConfigEntry } from "./index.js";

export interface ModelListItem {
  id: string;
  label: string;
  provider: string;
  model?: string;
  contextWindow: number;
  pricing?: ModelPricing;
  /** 来源：env / file / runtime（file 与 runtime 可删除，env 只读） */
  source: "env" | "file" | "runtime" | "builtin";
  isDefault: boolean;
  hasApiKey: boolean;
}

export interface AddModelInput {
  id: string;
  baseURL: string;
  apiKey: string;
  model: string;
  label?: string;
  contextWindow?: number;
  pricing?: ModelPricing;
  /** 设为默认模型 */
  makeDefault?: boolean;
}

export class RuntimeModelRegistry {
  readonly adapters = new Map<string, ModelAdapter>();
  defaultModel: string;
  /** id → 来源（决定能否删除） */
  private sources = new Map<string, ModelListItem["source"]>();
  /** 运行时/文件添加的条目，用于持久化 */
  private dynamicEntries = new Map<string, ModelConfigEntry>();

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    private configFile?: string,
  ) {
    const base = buildModelRegistry(env, configFile);
    for (const [id, adapter] of base.adapters) {
      this.adapters.set(id, adapter);
      this.sources.set(id, id === "mock" ? "builtin" : "env");
    }
    // 配置文件来源的条目标记为 file（可删除），并纳入动态条目以便回写
    if (configFile) {
      const fileEntries = readEntries(configFile);
      for (const e of fileEntries) {
        this.sources.set(e.id, "file");
        this.dynamicEntries.set(e.id, e);
      }
    }
    this.defaultModel = base.defaultModel;
  }

  list(): ModelListItem[] {
    return [...this.adapters.values()].map((a) => ({
      id: a.id,
      label: a.label,
      provider: a.meta.provider,
      model: a instanceof OpenAICompatAdapter ? a.config.model : undefined,
      contextWindow: a.meta.contextWindow,
      pricing: a.meta.pricing,
      source: this.sources.get(a.id) ?? "runtime",
      isDefault: a.id === this.defaultModel,
      hasApiKey: a instanceof OpenAICompatAdapter ? a.config.apiKey.length > 0 : false,
    }));
  }

  get(id: string): ModelAdapter | undefined {
    return this.adapters.get(id);
  }

  setDefault(id: string): void {
    if (!this.adapters.has(id)) throw new Error(`模型不存在: ${id}`);
    this.defaultModel = id;
  }

  add(input: AddModelInput): ModelListItem {
    if (this.adapters.has(input.id)) throw new Error(`模型 id 已存在: ${input.id}`);
    const adapter = new OpenAICompatAdapter({
      id: input.id,
      label: input.label || `${input.id} (${input.model})`,
      baseURL: input.baseURL,
      apiKey: input.apiKey,
      model: input.model,
      contextWindow: input.contextWindow,
      pricing: input.pricing,
    });
    this.adapters.set(input.id, adapter);
    this.sources.set(input.id, "runtime");
    this.dynamicEntries.set(input.id, {
      id: input.id,
      baseURL: input.baseURL,
      apiKey: input.apiKey,
      model: input.model,
      label: input.label,
      contextWindow: input.contextWindow,
      pricing: input.pricing,
    });
    this.persist();
    if (input.makeDefault || this.defaultModel === "mock") this.defaultModel = input.id;
    return this.list().find((m) => m.id === input.id)!;
  }

  remove(id: string): void {
    const source = this.sources.get(id);
    if (source === "builtin") throw new Error("内置 mock 模型不可删除");
    if (source === "env") throw new Error(`模型 ${id} 来自环境变量 AGENT_MODELS，请修改环境变量删除`);
    this.adapters.delete(id);
    this.sources.delete(id);
    this.dynamicEntries.delete(id);
    this.persist();
    if (this.defaultModel === id) {
      this.defaultModel = [...this.adapters.keys()].find((k) => k !== "mock") ?? "mock";
    }
  }

  /** 把动态条目回写到配置文件（原子：先写临时文件再重命名） */
  private persist(): void {
    if (!this.configFile) return;
    fs.mkdirSync(path.dirname(this.configFile), { recursive: true });
    const tmp = `${this.configFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.dynamicEntries.values()], null, 2));
    fs.renameSync(tmp, this.configFile);
  }
}

function readEntries(configFile: string): ModelConfigEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 按 fallback 链取适配器：首个不可用则顺延 */
export function resolveWithFallback(
  registry: RuntimeModelRegistry,
  preferredId: string,
  fallbackChain: string[] = [],
): ModelAdapter {
  for (const id of [preferredId, ...fallbackChain]) {
    const adapter = registry.get(id);
    if (adapter) return adapter;
  }
  return registry.get("mock")!;
}
