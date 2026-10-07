/**
 * F10（v0.4）：内嵌预览面板——iframe 加载用户自填地址（按会话记忆），
 * 「发送给 Agent」把当前 URL（同源时含点选元素的 CSS 选择器）注入消息。
 * 本地优先：不预置任何远端地址。外壳由右栏 Tabs 提供。
 */

import type { SessionRecord } from "@shuyi-harness/types";
import { Button } from "@shuyi-harness/ui/components/ui/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@shuyi-harness/ui/components/ui/empty";
import { Input } from "@shuyi-harness/ui/components/ui/input";
import { CrosshairIcon, RotateCwIcon, SendIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type PaneSlot, useSessionStore } from "../core/store.js";

export function PreviewPanel({
	slot = "primary",
	session,
}: {
	slot?: PaneSlot;
	session: SessionRecord;
}) {
	const { sendMessage } = useSessionStore();
	const storageKey = `shuyi-preview-url:${session.session_id}`;
	const [url, setUrl] = useState(() => localStorage.getItem(storageKey) ?? "");
	const [loaded, setLoaded] = useState(url);
	const [picking, setPicking] = useState(false);
	const iframeRef = useRef<HTMLIFrameElement>(null);

	useEffect(() => {
		localStorage.setItem(storageKey, loaded);
	}, [storageKey, loaded]);

	/** 同源时点选元素生成选择器；跨域降级提示 */
	const startPick = () => {
		const doc = iframeRef.current?.contentDocument;
		if (!doc) {
			alert(
				"跨域页面无法点选元素（浏览器安全限制）。可手动描述元素，或发送当前 URL。"
			);
			return;
		}
		setPicking(true);
		const onClick = (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			const el = e.target as HTMLElement;
			const sel = cssSelector(el);
			cleanup();
			void sendMessage(
				slot,
				`预览页面 ${loaded} 中的元素 \`${sel}\`：请查看并修改相关代码。`
			);
		};
		const cleanup = () => {
			setPicking(false);
			doc.removeEventListener("click", onClick, true);
			doc.body?.classList.remove("shuyi-picking");
		};
		doc.addEventListener("click", onClick, true);
		doc.body?.classList.add("shuyi-picking");
	};

	return (
		<div className="flex h-full min-h-0 flex-col bg-background">
			<div className="flex flex-none items-center gap-1.5 border-b bg-panel p-2">
				<Input
					className="h-8 flex-1 rounded-sm px-2.5 font-mono text-[12px]"
					onChange={(e) => setUrl(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && url.trim()) setLoaded(url.trim());
					}}
					placeholder="http://localhost:3000 …"
					value={url}
				/>
				<Button
					aria-label="加载"
					onClick={() => url.trim() && setLoaded(url.trim())}
					size="icon-sm"
					title="加载"
					variant="outline"
				>
					<RotateCwIcon />
				</Button>
				<Button
					aria-label="把当前 URL 发给 Agent"
					disabled={!loaded}
					onClick={() => void sendMessage(slot, `请查看预览页面：${loaded}`)}
					size="icon-sm"
					title="把当前 URL 发给 Agent"
					variant="outline"
				>
					<SendIcon />
				</Button>
				<Button
					disabled={!loaded || picking}
					onClick={startPick}
					size="sm"
					title={
						picking ? "点击页面元素…" : "点选元素发给 Agent（同源页面可用）"
					}
					variant={picking ? "default" : "outline"}
				>
					{picking ? (
						"点选中…"
					) : (
						<>
							<CrosshairIcon />
							点选
						</>
					)}
				</Button>
			</div>
			{loaded ? (
				<iframe
					className="h-full w-full flex-1"
					ref={iframeRef}
					src={loaded}
					title="预览"
				/>
			) : (
				<Empty className="m-3 rounded-md">
					<EmptyHeader>
						<EmptyMedia>
							<span className="grid size-[38px] rotate-[-4deg] place-items-center rounded-[5px] bg-seal font-serif text-[19px] font-bold text-seal-foreground">
								览
							</span>
						</EmptyMedia>
						<EmptyTitle>未加载页面</EmptyTitle>
						<EmptyDescription>输入本地开发服务地址后回车加载</EmptyDescription>
					</EmptyHeader>
				</Empty>
			)}
		</div>
	);
}

/** 生成紧凑 CSS 选择器（id > 类名路径，最多 4 层） */
function cssSelector(el: HTMLElement): string {
	if (el.id) return `#${el.id}`;
	const parts: string[] = [];
	let cur: HTMLElement | null = el;
	while (cur && parts.length < 4 && cur.tagName !== "BODY") {
		let part = cur.tagName.toLowerCase();
		if (cur.id) {
			parts.unshift(`#${cur.id}`);
			break;
		}
		const cls = [...cur.classList]
			.filter((c) => !c.startsWith("shuyi-"))
			.slice(0, 2)
			.join(".");
		if (cls) part += `.${cls}`;
		const parent = cur.parentElement;
		if (parent) {
			const same = [...parent.children].filter(
				(c) => c.tagName === cur!.tagName
			);
			if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
		}
		parts.unshift(part);
		cur = cur.parentElement;
	}
	return parts.join(" > ");
}
