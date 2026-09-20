/**
 * F6（v0.4）：命令面板（Ctrl+K）——会话级与全局动作统一入口。
 * 动作集合由 App 注入（需要切换主题/新建会话等上下文）。
 */
import { useEffect, useMemo, useRef, useState } from "react";

export interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

export function CommandPalette({
  open,
  onClose,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  actions: PaletteAction[];
}) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return actions;
    return actions.filter((a) => `${a.label} ${a.hint ?? ""}`.toLowerCase().includes(kw));
  }, [actions, q]);

  useEffect(() => {
    if (open) {
      setQ("");
      setIdx(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  if (!open) return null;

  const run = (a: PaletteAction) => {
    onClose();
    a.run();
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="command-palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          placeholder="输入命令…（↑↓ 选择，Enter 执行）"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setIdx(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIdx((i) => (i + 1) % Math.max(1, filtered.length));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIdx((i) => (i - 1 + filtered.length) % Math.max(1, filtered.length));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const a = filtered[Math.min(idx, filtered.length - 1)];
              if (a) run(a);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <div className="palette-list">
          {filtered.length === 0 && <div className="palette-empty">无匹配命令</div>}
          {filtered.map((a, i) => (
            <button
              key={a.id}
              className={`palette-item ${i === idx ? "active" : ""}`}
              onMouseEnter={() => setIdx(i)}
              onClick={() => run(a)}
            >
              <span>{a.label}</span>
              {a.hint && <span className="palette-hint">{a.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
