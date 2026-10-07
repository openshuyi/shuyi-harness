/** HTTP API 请求/响应类型（前后端共享） */
import { z } from "zod";
import { SandboxLevel, SessionMode } from "./events.js";

export const CreateSessionRequest = z.object({
	/** M2：起始代理定义名（缺省为内置 build 代理） */
	agent: z.string().optional(),
	cwd: z.string(),
	mode: SessionMode.default("build"),
	/** 缺省由服务端按 项目 shuyi.json → 注册表默认 解析（P8-5） */
	model: z.string().optional(),
	sandbox_level: SandboxLevel.default("workspace"),
	title: z.string().optional(),
	/** P1-6：在独立 git worktree 中运行会话（并行会话写隔离） */
	worktree: z.boolean().optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

export const PostMessageRequest = z.object({
	text: z.string().min(1),
});
export type PostMessageRequest = z.infer<typeof PostMessageRequest>;

export const ResolveApprovalRequest = z.object({
	/** P0：question 工具的回答文本 */
	answer: z.string().optional(),
	decision: z.enum(["approve", "deny"]),
	deny_reason: z.string().optional(),
	/** M3：记住更细粒度规则——glob 模式（如 "tests/**"、"git status*"），仅 approve 时生效 */
	remember_pattern: z.string().optional(),
	remember_rule: z.string().optional(),
});
export type ResolveApprovalRequest = z.infer<typeof ResolveApprovalRequest>;

export const ForkSessionRequest = z.object({
	at_seq: z.number().int().nonnegative(),
});
export type ForkSessionRequest = z.infer<typeof ForkSessionRequest>;

export interface ModelPricing {
	/** 缓存命中输入价（可选） */
	cachedInput?: number;
	/** 输入价，美元/百万 token */
	input: number;
	/** 输出价，美元/百万 token */
	output: number;
}

export interface ModelInfo {
	contextWindow: number;
	hasApiKey: boolean;
	id: string;
	isDefault: boolean;
	label: string;
	/** 上游模型名（openai-compatible 模型有） */
	model?: string;
	pricing?: ModelPricing;
	provider: string;
	source: "env" | "file" | "runtime" | "builtin";
}

/** M2：代理定义（GET /api/agents 响应项；PUT body 兼容 prompt 别名见服务端） */
export interface AgentInfo {
	description: string;
	modeDefault?: "plan" | "build";
	model?: string;
	name: string;
	permissionOverride?: unknown[];
	source: "builtin" | "user" | "project" | "runtime";
	system: string;
	tools: "readonly" | "all" | string[];
}

export interface UpsertAgentRequest {
	description?: string;
	modeDefault?: "plan" | "build";
	model?: string;
	system?: string;
	tools?: "readonly" | "all" | string[];
}

export interface AddModelRequest {
	apiKey: string;
	baseURL: string;
	contextWindow?: number;
	id: string;
	label?: string;
	makeDefault?: boolean;
	model: string;
	pricing?: ModelPricing;
}
