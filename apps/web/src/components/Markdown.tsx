/**
 * F7（v0.4）：Markdown 渲染——marked + highlight.js 代码高亮；
 * mermaid 代码块动态 import（~500KB gzip 按需），渲染失败回退源码块。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import hljs from "highlight.js/lib/common";

marked.setOptions({ breaks: true, gfm: true });

/** 渲染后处理：hljs 高亮 + mermaid 占位 */
function renderHtml(src: string): string {
  const html = marked.parse(src, { async: false }) as string;
  // 高亮代码块（marked 输出 <pre><code class="language-x">）
  return html.replace(
    /<pre><code(?: class="language-([\w-]+)")?>([\s\S]*?)<\/code><\/pre>/g,
    (whole, lang: string | undefined, code: string) => {
      if (lang === "mermaid") {
        return `<div class="mermaid-block" data-mermaid="${encodeURIComponent(code)}"></div>`;
      }
      try {
        const text = decodeEntities(code);
        const highlighted =
          lang && hljs.getLanguage(lang)
            ? hljs.highlight(text, { language: lang }).value
            : hljs.highlightAuto(text).value;
        return `<pre><code class="hljs language-${lang ?? "auto"}">${highlighted}</code></pre>`;
      } catch {
        return whole;
      }
    },
  );
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

let mermaidSeq = 0;

export function Markdown({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderHtml(text), [text]);
  const [mermaidTick, setMermaidTick] = useState(0);

  // mermaid 块渲染（有占位才动态加载库）
  useEffect(() => {
    const blocks = ref.current?.querySelectorAll<HTMLElement>(".mermaid-block[data-mermaid]");
    if (!blocks || blocks.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: document.documentElement.dataset.theme === "light" ? "neutral" : "dark",
          securityLevel: "strict",
        });
        for (const el of Array.from(blocks)) {
          if (cancelled) return;
          const code = decodeURIComponent(el.dataset.mermaid ?? "");
          try {
            const { svg } = await mermaid.render(`mmd-${mermaidSeq++}`, code);
            el.innerHTML = svg;
            el.classList.add("mermaid-rendered");
          } catch {
            el.innerHTML = `<pre><code>${code.replace(/</g, "&lt;")}</code></pre>`;
          }
        }
        if (!cancelled) setMermaidTick((t) => t + 1);
      } catch {
        /* 库加载失败 → 保持占位 */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html]);

  void mermaidTick;
  return (
    <div
      ref={ref}
      className={`markdown-body ${className ?? ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
