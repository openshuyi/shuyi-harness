/** HTTP API 请求/响应类型（前后端共享） */
import { z } from "zod";
import { SessionMode, SandboxLevel } from "./events.js";

export const CreateSessionRequest = z.object({
  title: z.string().optional(),
  cwd: z.string(),
  mode: SessionMode.default("build"),
  /** 缺省由服务端按 项目 shuyi.json → 注册表默认 解析（P8-5） */
  model: z.string().optional(),
  sandbox_level: SandboxLevel.default("workspace"),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

export const PostMessageRequest = z.object({
  text: z.string().min(1),
});
export type PostMessageRequest = z.infer<typeof PostMessageRequest>;

export const ResolveApprovalRequest = z.object({
  decision: z.enum(["approve", "deny"]),
  remember_rule: z.string().optional(),
  deny_reason: z.string().optional(),
});
export type ResolveApprovalRequest = z.infer<typeof ResolveApprovalRequest>;

export const ForkSessionRequest = z.object({
  at_seq: z.number().int().nonnegative(),
});
export type ForkSessionRequest = z.infer<typeof ForkSessionRequest>;

export interface ModelPricing {
  /** 输入价，美元/百万 token */
  input: number;
  /** 输出价，美元/百万 token */
  output: number;
  /** 缓存命中输入价（可选） */
  cachedInput?: number;
}

export interface ModelInfo {
  id: string;
  label: string;
  provider: string;
  /** 上游模型名（openai-compatible 模型有） */
  model?: string;
  contextWindow: number;
  pricing?: ModelPricing;
  source: "env" | "file" | "runtime" | "builtin";
  isDefault: boolean;
  hasApiKey: boolean;
}

export interface AddModelRequest {
  id: string;
  baseURL: string;
  apiKey: string;
  model: string;
  label?: string;
  contextWindow?: number;
  pricing?: ModelPricing;
  makeDefault?: boolean;
}
