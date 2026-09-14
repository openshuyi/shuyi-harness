/** HTTP API 请求/响应类型（前后端共享） */
import { z } from "zod";
import { SessionMode, SandboxLevel } from "./events.js";

export const CreateSessionRequest = z.object({
  title: z.string().optional(),
  cwd: z.string(),
  mode: SessionMode.default("build"),
  model: z.string().default("mock"),
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

export interface ModelInfo {
  id: string;
  label: string;
  provider: string;
}
