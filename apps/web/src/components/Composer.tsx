import type { ModelInfo } from "@shuyi-harness/types";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { fetchJsonArray } from "../core/api.js";
import { useSessionStore } from "../core/store.js";

export function Composer() {
	const { current, trajectory, sendMessage, abort, setMode, setModel } =
		useSessionStore();
	const [text, setText] = useState("");
	const [sending, setSending] = useState(false);

	const { data: models = [] } = useQuery<ModelInfo[]>({
		queryFn: async () => {
			try {
				return await fetchJsonArray<ModelInfo>("/api/models");
			} catch {
				return [];
			}
		},
		queryKey: ["models"],
	});

	if (!current) {
		return null;
	}
	const busy =
		trajectory.status === "running" ||
		trajectory.status === "awaiting_approval";

	const submit = async () => {
		const t = text.trim();
		if (!t || busy) {
			return;
		}
		setSending(true);
		try {
			await sendMessage(t);
			setText("");
		} catch (err) {
			alert(err instanceof Error ? err.message : String(err));
		} finally {
			setSending(false);
		}
	};

	return (
		<div className="composer">
			<div className="composer-toolbar">
				<select
					onChange={(e) => void setMode(e.target.value as "plan" | "build")}
					value={current.mode}
				>
					<option value="build">Build 模式</option>
					<option value="plan">Plan 模式</option>
				</select>
				<select
					onChange={(e) => void setModel(e.target.value)}
					value={current.model}
				>
					{models.map((m) => (
						<option key={m.id} value={m.id}>
							{m.label}
						</option>
					))}
				</select>
				<span className="usage">
					tokens: {trajectory.usage.prompt} in / {trajectory.usage.completion}{" "}
					out
				</span>
			</div>
			<div className="composer-row">
				<textarea
					disabled={busy}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							void submit();
						}
					}}
					placeholder={
						busy ? "Agent 运行中…" : "输入消息，Enter 发送，Shift+Enter 换行"
					}
					rows={3}
					value={text}
				/>
				{busy ? (
					<button className="danger" onClick={() => void abort()}>
						中断
					</button>
				) : (
					<button
						className="primary"
						disabled={sending || !text.trim()}
						onClick={() => void submit()}
					>
						发送
					</button>
				)}
			</div>
		</div>
	);
}
