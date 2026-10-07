/**
 * M3 权限系统细粒度测试。
 * 对应文档：《编码智能体-v0.3设计-能力追赶计划.md》§M3 验收：
 * - 单元：picomatch 规则匹配矩阵（大小写、`**`、否定模式 `!` 不支持——保持简单）
 * - e2e：.agent/permissions.json 中 "tests/**": "allow" 后 !write tests/foo.ts x 免审批
 *        （在只读沙箱下验证，确为规则放行而非沙箱默认行为）
 * - e2e：rm -rf 规则 fail-closed 命中（deny 规则优先于审批）
 * 另覆盖：裁决链优先级（deny_builtin > agent > user_config > remembered > 工具级+沙箱）、
 * 配置文件两种形态解析、remember_pattern 审批记忆、代理 permissionOverride 接线。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentEvent, SessionRecord } from "@shuyi-harness/types";
import { AgentRegistry } from "../src/agent/agents/index.js";
import { EventBus } from "../src/agent/bus/index.js";
import { RuntimeModelRegistry } from "../src/agent/model/registry.js";
import {
	appendPermissionRule,
	deletePermissionRule,
	loadPermissionRules,
	parsePermissionConfig,
} from "../src/agent/permission/config.js";
import {
	applyRules,
	matchRule,
	matchTargets,
	type PermissionRule,
	PermissionService,
	sanitizeRules,
} from "../src/agent/permission/index.js";
import { SessionManager } from "../src/agent/session/manager.js";
import { SqliteEventStore } from "../src/agent/store/event-store.js";
import { createDefaultRegistry } from "../src/agent/tools/index.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-m3-"));
const workspace = path.join(tmp, "workspace");
fs.mkdirSync(workspace, { recursive: true });

function rule(
	partial: Partial<PermissionRule> & { pattern: string }
): PermissionRule {
	return {
		decision: "allow",
		patternType: "glob",
		source: "user_config",
		tool: "*",
		...partial,
	};
}

// ---------- 单元：picomatch 匹配矩阵（文档 §M3 验收） ----------
describe("M3 单元：picomatch 匹配矩阵", () => {
	test("大小写敏感：SRC/** 不匹配 src/", () => {
		const r = rule({ pattern: "SRC/**" });
		expect(matchRule(r, ["src/a.ts"])).toBe(false);
		expect(matchRule(r, ["SRC/a.ts"])).toBe(true);
	});

	test("** 跨目录层级", () => {
		const r = rule({ pattern: "tests/**" });
		expect(matchRule(r, ["tests/foo.ts"])).toBe(true);
		expect(matchRule(r, ["tests/a/b/c.ts"])).toBe(true);
		expect(matchRule(r, ["src/foo.ts"])).toBe(false);
		// 单层 * 不跨目录
		const single = rule({ pattern: "tests/*" });
		expect(matchRule(single, ["tests/foo.ts"])).toBe(true);
		expect(matchRule(single, ["tests/a/b.ts"])).toBe(false);
	});

	test("否定模式 ! 不支持：按字面处理，无反选语义", () => {
		const r = rule({ pattern: "!src/**" });
		// nonegate：leading ! 是字面字符，匹配不到任何正常路径
		expect(matchRule(r, ["src/a.ts"])).toBe(false);
		expect(matchRule(r, ["other/a.ts"])).toBe(false);
	});

	test("dot 文件可匹配（dot:true）", () => {
		const r = rule({ pattern: ".agent/**" });
		expect(matchRule(r, [".agent/permissions.json"])).toBe(true);
	});

	test("prefix 与 regex 类型", () => {
		expect(
			matchRule(rule({ pattern: "src/", patternType: "prefix" }), ["src/a.ts"])
		).toBe(true);
		expect(
			matchRule(rule({ pattern: "src/", patternType: "prefix" }), ["test/a.ts"])
		).toBe(false);
		expect(
			matchRule(rule({ pattern: "^tests/.*\\.ts$", patternType: "regex" }), [
				"tests/a.ts",
			])
		).toBe(true);
		expect(
			matchRule(rule({ pattern: "^tests/.*\\.ts$", patternType: "regex" }), [
				"tests/a.js",
			])
		).toBe(false);
		// 非法正则按不命中处理（fail-closed：配置错误不放行）
		expect(
			matchRule(rule({ pattern: "[", patternType: "regex" }), ["anything"])
		).toBe(false);
	});

	test("applyRules：tool 过滤与首个命中生效", () => {
		const rules = [
			rule({ decision: "deny", pattern: "git *", tool: "bash" }),
			rule({ decision: "allow", pattern: "git *", tool: "*" }),
		];
		// bash 命中第一条 deny
		expect(applyRules(rules, "bash", ["git status"])?.kind).toBe("deny");
		// write 跳过 bash 专属规则，命中 * allow
		expect(applyRules(rules, "write", ["git status"])?.kind).toBe("allow");
		// 无命中 → null（继续裁决链）
		expect(applyRules(rules, "bash", ["ls -la"])).toBeNull();
	});

	test("matchTargets：bash 提取完整命令行；路径同时给相对与绝对候选", () => {
		const tools = createDefaultRegistry();
		const bash = tools.get("bash");
		const write = tools.get("write");
		if (!bash || !write) throw new Error("bash/write 工具缺失");
		expect(matchTargets(bash, { command: "rm -rf /tmp/x" }, workspace)).toEqual(
			["rm -rf /tmp/x"]
		);
		const targets = matchTargets(write, { path: "tests/foo.ts" }, workspace);
		expect(targets[0]).toBe("tests/foo.ts");
		expect(targets[1]).toBe(path.join(workspace, "tests/foo.ts"));
		// 工作区外绝对路径只有绝对候选
		expect(matchTargets(write, { path: "/etc/hosts" }, workspace)).toEqual([
			"/etc/hosts",
		]);
	});
});

// ---------- 单元：裁决链优先级 ----------
describe("M3 单元：裁决链优先级", () => {
	const tools = createDefaultRegistry();
	const write = tools.get("write");
	const bash = tools.get("bash");
	if (!write || !bash) throw new Error("write/bash 工具缺失");
	const q = (
		ps: PermissionService,
		extra: Partial<Parameters<PermissionService["classify"]>[0]> = {}
	) =>
		ps.classify({
			args: { content: "x", path: "tests/foo.ts" },
			cwd: workspace,
			mode: "build",
			sandboxLevel: "workspace",
			tool: write,
			...extra,
		});

	test("deny_builtin 不可被 agent/user_config 规则覆盖", () => {
		const ps = new PermissionService();
		ps.setUserConfigRules([rule({ decision: "allow", pattern: "**" })]);
		const verdict = ps.classify({
			agentRules: [rule({ decision: "allow", pattern: "**", source: "agent" })],
			args: { content: "SECRET=1", path: ".env.local" },
			cwd: workspace,
			mode: "build",
			sandboxLevel: "full",
			tool: write,
		});
		expect(verdict.kind).toBe("deny");
		expect(verdict.reason).toContain("敏感路径");
	});

	test("agent 规则优先于 user_config", () => {
		const ps = new PermissionService();
		ps.setUserConfigRules([rule({ decision: "allow", pattern: "tests/**" })]);
		const verdict = q(ps, {
			agentRules: [
				rule({ decision: "deny", pattern: "tests/**", source: "agent" }),
			],
		});
		expect(verdict.kind).toBe("deny");
		expect(verdict.reason).toContain("agent");
	});

	test("user_config 优先于 remembered 与沙箱默认", () => {
		const ps = new PermissionService();
		ps.rememberRule("write", "deny"); // 会话级拒绝
		ps.setUserConfigRules([rule({ decision: "allow", pattern: "tests/**" })]);
		const verdict = q(ps, { sandboxLevel: "readonly" }); // 只读沙箱本应在第 5 步拒绝
		expect(verdict.kind).toBe("allow");
		expect(verdict.reason).toContain("user_config");
	});

	test("remembered 模式规则优先于沙箱默认", () => {
		const ps = new PermissionService();
		ps.rememberPatternRule({
			decision: "allow",
			pattern: "tests/**",
			patternType: "glob",
			tool: "write",
		});
		const verdict = q(ps, { sandboxLevel: "readonly" });
		expect(verdict.kind).toBe("allow");
		expect(verdict.reason).toContain("remembered");
	});

	test("user_config 未命中才落到 remembered", () => {
		const ps = new PermissionService();
		ps.setUserConfigRules([rule({ decision: "deny", pattern: "src/**" })]); // 不命中 tests/
		ps.rememberRule("write", "allow");
		expect(q(ps).kind).toBe("allow");
	});

	test("bash 命令行规则：rm -rf * deny 命中（fail-closed）", () => {
		const ps = new PermissionService();
		ps.setUserConfigRules([
			rule({ decision: "deny", pattern: "rm -rf *", tool: "bash" }),
		]);
		// 命令行语义：/ 是普通字符，* 可跨 /（与路径 glob 的 picomatch 语义不同）
		for (const command of ["rm -rf scratch", "rm -rf /tmp/x", "rm -rf ~/a/b"]) {
			const verdict = ps.classify({
				args: { command },
				cwd: workspace,
				mode: "build",
				sandboxLevel: "full",
				tool: bash,
			});
			expect(verdict.kind).toBe("deny");
			expect(verdict.reason).toContain("rm -rf *");
		}
		// 不相似的命令不命中，落到后续裁决（full 沙箱 bash → ask）
		const miss = ps.classify({
			args: { command: "ls /tmp" },
			cwd: workspace,
			mode: "build",
			sandboxLevel: "full",
			tool: bash,
		});
		expect(miss.kind).toBe("ask");
		// 路径 glob 仍保持 picomatch 语义：* 不跨 /
		expect(matchRule(rule({ pattern: "tests/*" }), ["tests/a/b.ts"])).toBe(
			false
		);
	});

	test("sanitizeRules：非法项丢弃，合法项保留并打上来源", () => {
		const rules = sanitizeRules(
			[
				{
					decision: "deny",
					pattern: "deploy *",
					patternType: "glob",
					tool: "bash",
				},
				{ tool: "bash" }, // 缺字段
				{ decision: "allow", pattern: "y", patternType: "nope", tool: "x" }, // 非法类型
				"garbage",
			],
			"agent"
		);
		expect(rules.length).toBe(1);
		expect(rules[0]).toMatchObject({
			decision: "deny",
			source: "agent",
			tool: "bash",
		});
	});
});

// ---------- 单元：配置文件解析 ----------
describe("M3 单元：permissions.json 解析", () => {
	const home = path.join(tmp, "home");
	const proj = path.join(tmp, "proj");

	test("速记映射：自动判定 glob/prefix，tool 为 *", () => {
		const rules = parsePermissionConfig({
			"rm -rf *": "deny",
			"src/": "ask",
			"tests/**": "allow",
		});
		expect(rules).toHaveLength(3);
		// 逐条按 pattern 断言（不依赖对象字面量键序）
		expect(rules.find((r) => r.pattern === "tests/**")).toMatchObject({
			decision: "allow",
			patternType: "glob",
			tool: "*",
		});
		expect(rules.find((r) => r.pattern === "rm -rf *")).toMatchObject({
			decision: "deny",
			patternType: "glob",
		});
		expect(rules.find((r) => r.pattern === "src/")).toMatchObject({
			decision: "ask",
			patternType: "prefix",
		});
		// 非法裁决丢弃
		expect(parsePermissionConfig({ "x/**": "maybe" })).toHaveLength(0);
	});

	test("完整形态：{ rules: [...] } 与裸数组", () => {
		const full = parsePermissionConfig({
			rules: [
				{
					decision: "ask",
					pattern: "git push*",
					patternType: "prefix",
					tool: "bash",
				},
			],
		});
		expect(full[0]).toMatchObject({
			decision: "ask",
			patternType: "prefix",
			tool: "bash",
		});
		const arr = parsePermissionConfig([
			{ decision: "deny", pattern: "dist/**" },
		]);
		expect(arr[0]).toMatchObject({
			decision: "deny",
			patternType: "glob",
			tool: "*",
		});
	});

	test("loadPermissionRules：项目与全局分层加载；坏文件静默为空", () => {
		fs.mkdirSync(path.join(home, ".agent"), { recursive: true });
		fs.mkdirSync(path.join(proj, ".agent"), { recursive: true });
		fs.writeFileSync(
			path.join(home, ".agent", "permissions.json"),
			JSON.stringify({ "global/**": "ask" })
		);
		fs.writeFileSync(
			path.join(proj, ".agent", "permissions.json"),
			"{ 坏 json"
		);
		const { project, global } = loadPermissionRules(proj, home);
		expect(project).toHaveLength(0); // 解析失败 → 空（fail-closed 语义不变）
		expect(global).toHaveLength(1);
		fs.writeFileSync(
			path.join(proj, ".agent", "permissions.json"),
			JSON.stringify({ "tests/**": "allow" })
		);
		expect(loadPermissionRules(proj, home).project).toHaveLength(1);
	});

	test("appendPermissionRule / deletePermissionRule：追加与按索引删除", () => {
		const file = path.join(tmp, "rules", "permissions.json");
		// 旧速记格式升级为 { rules } 完整形态
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ "old/**": "deny" }));
		appendPermissionRule(file, {
			decision: "allow",
			pattern: "new/**",
			patternType: "glob",
			tool: "write",
		});
		let rules = parsePermissionConfig(
			JSON.parse(fs.readFileSync(file, "utf-8"))
		);
		expect(rules).toHaveLength(2);
		expect(rules[1]).toMatchObject({ pattern: "new/**", tool: "write" });

		expect(deletePermissionRule(file, 0)).toBe(true);
		rules = parsePermissionConfig(JSON.parse(fs.readFileSync(file, "utf-8")));
		expect(rules).toHaveLength(1);
		expect(rules[0]?.pattern).toBe("new/**");
		expect(deletePermissionRule(file, 5)).toBe(false);
	});
});

// ---------- e2e：规则生效（文档 §M3 验收） ----------
describe("M3 e2e：权限规则生效", () => {
	let store: SqliteEventStore;
	let manager: SessionManager;
	let agents: AgentRegistry;
	let events: AgentEvent[] = [];
	let savedHome: string | undefined;
	const home = path.join(tmp, "e2e-home");

	async function waitForTurnEnd(
		s: SessionRecord,
		fromIndex: number,
		timeoutMs = 8000
	): Promise<void> {
		const start = Date.now();
		for (;;) {
			const done = events
				.slice(fromIndex)
				.some((e) => e.type === "turn.completed" || e.type === "turn.aborted");
			if (
				done &&
				// biome-ignore lint/performance/noAwaitInLoops: 轮询等待轮次收尾
				(await manager.getSession(s.session_id))?.status === "idle"
			)
				return;
			if (Date.now() - start > timeoutMs) throw new Error("等待轮次结束超时");
			await new Promise((r) => setTimeout(r, 20));
		}
	}

	async function waitForApproval(
		fromIndex: number,
		timeoutMs = 8000
	): Promise<string> {
		const start = Date.now();
		for (;;) {
			const req = events
				.slice(fromIndex)
				.find((e) => e.type === "approval.requested");
			if (req) return (req.payload as { approval_id: string }).approval_id;
			if (Date.now() - start > timeoutMs) throw new Error("等待审批挂起超时");
			await new Promise((r) => setTimeout(r, 20));
		}
	}

	beforeAll(() => {
		savedHome = process.env.HOME;
		process.env.HOME = home; // 隔离真实 ~/.agent/permissions.json
		const bus = new EventBus();
		store = new SqliteEventStore(path.join(tmp, "m3-e2e.db"), bus);
		bus.subscribe((e) => events.push(e));
		agents = new AgentRegistry(home);
		manager = new SessionManager(
			store,
			createDefaultRegistry(),
			new RuntimeModelRegistry({}),
			agents
		);
	});

	afterAll(async () => {
		await store.close();
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		fs.rmSync(tmp, { force: true, recursive: true });
	});

	test('只读沙箱 + 项目规则 "tests/**": "allow" → !write 免审批直接执行', async () => {
		// 项目级配置文件（速记形态，文档验收原样）
		fs.mkdirSync(path.join(workspace, ".agent"), { recursive: true });
		fs.writeFileSync(
			path.join(workspace, ".agent", "permissions.json"),
			JSON.stringify({ "tests/**": "allow" })
		);
		// 只读沙箱：若规则不生效，第 5 步沙箱检查会拒绝写入
		const s = await manager.createSession({
			cwd: workspace,
			mode: "build",
			model: "mock",
			sandbox_level: "readonly",
		});
		const mark = events.length;
		await manager.postMessage(s.session_id, "!write tests/foo.ts x");
		await waitForTurnEnd(s, mark);

		const slice = events.slice(mark);
		const types = slice.map((e) => e.type);
		expect(types).not.toContain("approval.requested"); // 免审批
		expect(types).toContain("tool.call.completed");
		expect(
			fs.readFileSync(path.join(workspace, "tests", "foo.ts"), "utf-8")
		).toBe("x");

		// 规则未覆盖的路径仍被只读沙箱拒绝（规则不是全局放行）
		const mark2 = events.length;
		await manager.postMessage(s.session_id, "!write src/bar.ts y");
		await waitForTurnEnd(s, mark2);
		const failed = events
			.slice(mark2)
			.find((e) => e.type === "tool.call.failed");
		expect(failed).toBeDefined();
		expect(fs.existsSync(path.join(workspace, "src", "bar.ts"))).toBe(false);
	});

	test('deny 规则 "rm -rf *" fail-closed：不弹审批、命令不执行', async () => {
		// 绝对路径目标：命令行 glob 的 * 可跨 /，"rm -rf *" 依然命中
		const victim = path.join(workspace, "should-survive");
		fs.mkdirSync(victim, { recursive: true });
		fs.writeFileSync(
			path.join(workspace, ".agent", "permissions.json"),
			JSON.stringify({ "rm -rf *": "deny" })
		);
		const s = await manager.createSession({
			cwd: workspace,
			mode: "build",
			model: "mock",
			sandbox_level: "workspace",
		});
		const mark = events.length;
		await manager.postMessage(s.session_id, `!bash rm -rf ${victim}`);
		await waitForTurnEnd(s, mark);

		const slice = events.slice(mark);
		expect(slice.map((e) => e.type)).not.toContain("approval.requested"); // deny 优先于 ask
		const failed = slice.find((e) => e.type === "tool.call.failed");
		expect((failed?.payload as { error: string }).error).toContain("权限拒绝");
		expect(fs.existsSync(victim)).toBe(true); // 命令未执行
	});

	test("审批记住 glob 模式：remember_pattern 后续同类命令免审批", async () => {
		fs.rmSync(path.join(workspace, ".agent", "permissions.json"), {
			force: true,
		});
		const s = await manager.createSession({
			cwd: workspace,
			mode: "build",
			model: "mock",
			sandbox_level: "workspace",
		});
		// 第一次：挂起审批，批准并记住模式
		const mark = events.length;
		await manager.postMessage(s.session_id, "!bash echo m3-remember-a");
		const approvalId = await waitForApproval(mark);
		manager.resolveApproval(s.session_id, approvalId, {
			decision: "approve",
			remember_pattern: "echo m3-remember*",
		});
		await waitForTurnEnd(s, mark);

		// approval.resolved 事件携带可选 remember_pattern（事件模型只增不改）
		const resolved = events
			.slice(mark)
			.find((e) => e.type === "approval.resolved");
		if (!resolved) throw new Error("approval.resolved 事件缺失");
		expect(
			(resolved.payload as { remember_pattern?: string }).remember_pattern
		).toBe("echo m3-remember*");

		// 第二次：命中 remembered 模式规则 → 免审批
		const mark2 = events.length;
		await manager.postMessage(s.session_id, "!bash echo m3-remember-b");
		await waitForTurnEnd(s, mark2);
		const slice2 = events.slice(mark2);
		expect(slice2.map((e) => e.type)).not.toContain("approval.requested");
		const completed = slice2.find((e) => e.type === "tool.call.completed");
		expect((completed?.payload as { result: string }).result).toContain(
			"m3-remember-b"
		);
	});

	test("代理 permissionOverride：运行时声明的 deny 规则在 Loop 生效", async () => {
		agents.upsertRuntime({
			description: "禁止 bash 的代理",
			name: "no-bash",
			permissionOverride: [
				{ decision: "deny", pattern: "*", patternType: "glob", tool: "bash" },
			],
			system: "你不允许执行 bash",
			tools: "all",
		});
		const s = await manager.createSession({
			agent: "no-bash",
			cwd: workspace,
			mode: "build",
			model: "mock",
			sandbox_level: "workspace",
		});
		const mark = events.length;
		await manager.postMessage(s.session_id, "!bash echo should-not-run");
		await waitForTurnEnd(s, mark);

		const slice = events.slice(mark);
		expect(slice.map((e) => e.type)).not.toContain("approval.requested");
		const failed = slice.find((e) => e.type === "tool.call.failed");
		expect((failed?.payload as { error: string }).error).toContain("权限拒绝");
		agents.removeRuntime("no-bash");
	});
});
