/**
 * 模型适配层装配：从环境变量构建可用适配器列表。
 * AGENT_MODELS（竖线分隔字段，逗号分隔多个）例：
 *   AGENT_MODELS="deepseek|https://api.deepseek.com/v1|sk-xxx|deepseek-chat,openai|https://api.openai.com/v1|sk-yyy|gpt-4o"
 * 无配置时仅提供 mock。
 */

import { MockAdapter } from "./mock.js";
import { OpenAICompatAdapter } from "./openai.js";
import type { ModelAdapter } from "./types.js";

// biome-ignore lint/performance/noBarrelFile: 模型适配层的装配缝——上层只 import 此模块即可拿到全部适配器
export { MockAdapter } from "./mock.js";
export type { ModelAdapter } from "./types.js";

export interface ModelRegistry {
	adapters: Map<string, ModelAdapter>;
	defaultModel: string;
}

export function buildModelRegistry(
	env: NodeJS.ProcessEnv = process.env
): ModelRegistry {
	const adapters = new Map<string, ModelAdapter>();
	const mock = new MockAdapter();
	adapters.set(mock.id, mock);

	const spec = env.AGENT_MODELS ?? "";
	for (const entry of spec
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)) {
		const [id, baseURL, apiKey, model] = entry.split("|").map((s) => s.trim());
		if (!(id && baseURL && apiKey && model)) {
			console.warn(
				`[model] 忽略无法解析的 AGENT_MODELS 条目（应为 id|baseURL|apiKey|model）: ${entry}`
			);
			continue;
		}
		adapters.set(
			id,
			new OpenAICompatAdapter({
				apiKey,
				baseURL,
				id,
				label: `${id} (${model})`,
				model,
			})
		);
	}

	const firstReal = [...adapters.keys()].find((k) => k !== mock.id);
	return { adapters, defaultModel: firstReal ?? mock.id };
}
