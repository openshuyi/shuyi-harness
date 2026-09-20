/**
 * F10（v0.4）：内嵌预览面板——iframe 加载用户自填地址（按会话记忆），
 * 「发送给 Agent」把当前 URL（同源时含点选元素的 CSS 选择器）注入消息。
 * 本地优先：不预置任何远端地址。
 */
import { useEffect, useRef, useState } from "react";
import type { SessionRecord } from "@shuyi/types";
import { useSessionStore, type PaneSlot } from "../core/store.js";

export function PreviewPanel({
  slot = "primary",
  session,
  onClose,
}: {
  slot?: PaneSlot;
  session: SessionRecord;
  onClose: () => void;
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
      alert("跨域页面无法点选元素（浏览器安全限制）。可手动描述元素，或发送当前 URL。");
      return;
    }
    setPicking(true);
    const onClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const el = e.target as HTMLElement;
      const sel = cssSelector(el);
      cleanup();
      void sendMessage(slot, `预览页面 ${loaded} 中的元素 \`${sel}\`：请查看并修改相关代码。`);
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
    <div className="side-panel preview-panel">
      <div className="side-panel-head">
        <span>预览</span>
        <button className="side-panel-close" onClick={onClose} title="关闭">×</button>
      </div>
      <div className="preview-bar">
        <input
          placeholder="http://localhost:3000 …"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && url.trim()) setLoaded(url.trim());
          }}
        />
        <button onClick={() => url.trim() && setLoaded(url.trim())} title="加载">↻</button>
        <button
          disabled={!loaded}
          onClick={() => void sendMessage(slot, `请查看预览页面：${loaded}`)}
          title="把当前 URL 发给 Agent"
        >
          ➤
        </button>
        <button
          disabled={!loaded || picking}
          onClick={startPick}
          title={picking ? "点击页面元素…" : "点选元素发给 Agent（同源页面可用）"}
        >
          {picking ? "点选中…" : "⌖"}
        </button>
      </div>
      {loaded ? (
        <iframe ref={iframeRef} className="preview-frame" src={loaded} title="预览" />
      ) : (
        <div className="changes-empty">输入本地开发服务地址后回车加载</div>
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
    const cls = [...cur.classList].filter((c) => !c.startsWith("shuyi-")).slice(0, 2).join(".");
    if (cls) part += `.${cls}`;
    const parent = cur.parentElement;
    if (parent) {
      const same = [...parent.children].filter((c) => c.tagName === cur!.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
    }
    parts.unshift(part);
    cur = cur.parentElement;
  }
  return parts.join(" > ");
}
