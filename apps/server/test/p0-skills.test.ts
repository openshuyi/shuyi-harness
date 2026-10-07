/**
 * P0-3：Skills 层——目录化技能包（SKILL.md + frontmatter），渐进披露。
 * - 系统提示只放名称+描述清单；skill 工具按需加载正文
 * - 全局 ~/.agent/skills ← 项目 <cwd>/.agent/skills（同名覆盖）
 * - 附属文件清单随正文返回（供 read/bash 使用）
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentEvent } from "@shuyi-harness/types";
import { EventBus } from "../src/agent/bus/index.js";
import { RuntimeModelRegistry } from "../src/agent/model/registry.js";
import type {
	ChatRequest,
	ChatResult,
	ModelAdapter,
	StreamHandlers,
} from "../src/agent/model/types.js";
import { SessionManager } from "../src/agent/session/manager.js";
import { loadSkills, skillsPromptSection } from "../src/agent/skills/index.js";
import { SqliteEventStore } from "../src/agent/store/event-store.js";
import { createDefaultRegistry } from "../src/agent/tools/index.js";

let tmp: string;
let home: string;

function writeSkill(root: string, name: string, raw: string): void {
	const dir = path.join(root, ".agent", "skills", name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "SKILL.md"), raw);
}

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p0-skills-"));
	home = path.join(tmp, "home");
});

afterEach(() => {
	fs.rmSync(tmp, { force: true, recursive: true });
});

describe("P0-3 Skills 层", () => {
	test("加载：frontmatter 解析、缺省 name 取目录名、项目覆盖全局", () => {
		writeSkill(home, "pdf", "---\ndescription: 全局 PDF 处理\n---\n全局正文");
		writeSkill(tmp, "pdf", "---\ndescription: 项目 PDF 处理\n---\n项目正文");
		writeSkill(tmp, "review", "无 frontmatter 的正文");
		const skills = loadSkills(tmp, home);
		expect(skills.map((s) => s.name)).toEqual(["pdf", "review"]);
		const pdf = skills.find((s) => s.name === "pdf")!;
		expect(pdf.description).toBe("项目 PDF 处理");
		expect(pdf.body).toBe("项目正文");
		expect(pdf.source).toBe("project");
		const review = skills.find((s) => s.name === "review")!;
		expect(review.description).toBe("");
		expect(review.body).toBe("无 frontmatter 的正文");
	});

	test("skillsPromptSection：只放名称+描述，无技能返回 undefined", () => {
		expect(skillsPromptSection(tmp, home)).toBeUndefined();
		writeSkill(tmp, "deploy", "---\ndescription: 部署到生产\n---\n步骤……");
		const section = skillsPromptSection(tmp, home);
		if (!section) throw new Error("技能清单段落缺失");
		expect(section).toContain("## 可用技能");
		expect(section).toContain("deploy：部署到生产");
		expect(section).not.toContain("步骤……"); // 正文不进系统提示（渐进披露）
	});

	test("e2e：!skill 加载正文 + 附属文件清单；未知技能报错附可用清单", async () => {
		writeSkill(
			tmp,
			"pdf",
			"---\ndescription: PDF 处理\n---\n用 extract.py 提取文本。"
		);
		fs.writeFileSync(
			path.join(tmp, ".agent", "skills", "pdf", "extract.py"),
			"print(1)"
		);
		const bus = new EventBus();
		const store = new SqliteEventStore(path.join(tmp, "events.db"), bus);
		const events: AgentEvent[] = [];
		bus.subscribe((e) => events.push(e));
		const manager = new SessionManager(
			store,
			createDefaultRegistry(),
			new RuntimeModelRegistry({})
		);
		const session = await manager.createSession({
			cwd: tmp,
			mode: "build",
			model: "mock",
			sandbox_level: "workspace",
		});

		await manager.postMessage(session.session_id, "!skill pdf");
		let start = Date.now();
		while (!events.some((e) => e.type === "turn.completed")) {
			if (Date.now() - start > 6000) throw new Error("超时");
			await new Promise((r) => setTimeout(r, 20));
		}
		const completed = events.find((e) => e.type === "tool.call.completed");
		const result = (completed?.payload as { result: string }).result;
		expect(result).toContain("技能 pdf（项目）已加载");
		expect(result).toContain("用 extract.py 提取文本。");
		expect(result).toContain("extract.py");

		// 未知技能：下一轮
		await manager.postMessage(session.session_id, "!skill nonexist");
		start = Date.now();
		const before = events.length;
		while (!events.slice(before).some((e) => e.type === "turn.completed")) {
			if (Date.now() - start > 6000) throw new Error("超时");
			await new Promise((r) => setTimeout(r, 20));
		}
		const failed = events
			.slice(before)
			.find((e) => e.type === "tool.call.failed");
		expect((failed?.payload as { error: string }).error).toContain(
			"技能不存在: nonexist"
		);
		expect((failed?.payload as { error: string }).error).toContain("pdf");
	});

	test("e2e：技能清单注入系统提示", async () => {
		writeSkill(tmp, "deploy", "---\ndescription: 部署到生产\n---\n步骤……");
		let capturedSystem = "";
		const spy: ModelAdapter = {
			id: "spy",
			label: "spy",
			meta: { contextWindow: 128_000, provider: "local" },
			async streamChat(
				req: ChatRequest,
				_h: StreamHandlers,
				_s: AbortSignal
			): Promise<ChatResult> {
				capturedSystem = req.system;
				return {
					finishReason: "stop",
					text: "好的",
					toolCalls: [],
					usage: { completion_tokens: 1, prompt_tokens: 1 },
				};
			},
		};
		const bus = new EventBus();
		const store = new SqliteEventStore(path.join(tmp, "e2.db"), bus);
		const events: AgentEvent[] = [];
		bus.subscribe((e) => events.push(e));
		const models = new RuntimeModelRegistry({});
		models.adapters.set("spy", spy);
		const manager = new SessionManager(store, createDefaultRegistry(), models);
		const session = await manager.createSession({
			cwd: tmp,
			mode: "build",
			model: "spy",
			sandbox_level: "workspace",
		});
		await manager.postMessage(session.session_id, "你好");
		const start = Date.now();
		while (!events.some((e) => e.type === "turn.completed")) {
			if (Date.now() - start > 6000) throw new Error("超时");
			await new Promise((r) => setTimeout(r, 20));
		}
		expect(capturedSystem).toContain("## 可用技能");
		expect(capturedSystem).toContain("deploy：部署到生产");
	});
});
