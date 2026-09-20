import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SessionList } from "./components/SessionList.js";
import { Trajectory } from "./components/Trajectory.js";
import { Composer } from "./components/Composer.js";
import { ApprovalDialog } from "./components/ApprovalDialog.js";
import { TodoPanel } from "./components/TodoPanel.js";
import { ChangesPanel } from "./components/ChangesPanel.js";
import { PreviewPanel } from "./components/PreviewPanel.js";
import { CommandPalette, type PaletteAction } from "./components/CommandPalette.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { useSessionStore, type PaneSlot } from "./core/store.js";

export default function App() {
  const queryClient = useQueryClient();
  const { trajectory, current, split, closeSplit, setMode } = useSessionStore();
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** 右侧工具面板：changes / preview / null（仅主栏） */
  const [sidePanel, setSidePanel] = useState<"changes" | "preview" | null>(null);

  // 轮次结束时让会话列表快照失效（刷新「最后活跃」状态）
  useEffect(() => {
    if (trajectory.status === "idle") {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    }
  }, [trajectory.status, queryClient]);

  // 自动标题（session.titled）落地后刷新会话列表，侧栏立即显示新标题
  const titledCount = trajectory.items.filter(
    (i) => i.kind === "marker" && i.text.startsWith("会话已命名为"),
  ).length;
  useEffect(() => {
    if (titledCount > 0) {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    }
  }, [titledCount, queryClient]);

  // F7：轮次完成提醒——页面不可见时系统通知 + 提示音
  useEffect(() => {
    if (trajectory.status !== "idle" || trajectory.items.length === 0) return;
    const last = trajectory.items[trajectory.items.length - 1];
    if (!document.hidden || !current) return;
    void last;
    const title = `Shuyi Agent：${current.title} 已完成`;
    if ("Notification" in window) {
      if (Notification.permission === "granted") {
        new Notification(title, { body: "点击返回查看结果", silent: true });
      } else if (Notification.permission === "default") {
        void Notification.requestPermission();
      }
    }
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
    } catch {
      /* 音频不可用时静默 */
    }
    // 仅在 running→idle 跳变时触发（items 变长但 status 不变的中间态不提醒）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trajectory.status]);

  // F6：全局快捷键——Ctrl+K 命令面板；Ctrl+N 新会话（聚焦侧栏按钮）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        document.querySelector<HTMLButtonElement>(".sidebar-header .primary")?.click();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const paletteActions: PaletteAction[] = [
    ...(current
      ? [
          {
            id: "changes",
            label: "打开变更面板",
            hint: "审查 agent 的文件改动",
            run: () => setSidePanel("changes"),
          },
          {
            id: "preview",
            label: "打开预览面板",
            hint: "内嵌浏览器",
            run: () => setSidePanel("preview"),
          },
          {
            id: "mode-toggle",
            label: current.mode === "plan" ? "切换到 Build 模式" : "切换到 Plan 模式",
            hint: "plan 模式只规划不改文件",
            run: () => void setMode("primary", current.mode === "plan" ? "build" : "plan"),
          },
          {
            id: "rewind-latest",
            label: "回滚最近一轮（会话 + 代码）",
            hint: "rewind 到最近的用户消息",
            run: () => {
              const lastUser = [...trajectory.items].reverse().find((i) => i.kind === "user");
              if (lastUser) {
                void useSessionStore.getState().rewind("primary", lastUser.seq, "both");
              }
            },
          },
        ]
      : []),
    {
      id: "theme",
      label: "切换主题",
      hint: "深色 / 浅色",
      run: () => document.querySelector<HTMLButtonElement>(".theme-toggle")?.click(),
    },
    {
      id: "new-session",
      label: "新会话",
      hint: "Ctrl+N",
      run: () => document.querySelector<HTMLButtonElement>(".sidebar-header .primary")?.click(),
    },
  ];

  return (
    <div className="app">
      <ErrorBoundary name="会话列表">
        <SessionList />
      </ErrorBoundary>
      {/* M5：分栏模式——主栏 + 可选右栏，各自独立 Trajectory/Composer/审批弹窗 */}
      <div className={`main ${split ? "split" : ""}`}>
        <Pane
          slot="primary"
          title={current?.title}
          sidePanel={current ? sidePanel : null}
          onTogglePanel={(p) => setSidePanel((cur) => (cur === p ? null : p))}
        />
        {split && <Pane slot="secondary" title={split.title} onClose={closeSplit} />}
      </div>
      {/* v0.4：右侧工具面板（变更 / 预览，仅主栏） */}
      {current && sidePanel === "changes" && (
        <ErrorBoundary name="变更面板">
          <ChangesPanel slot="primary" session={current} onClose={() => setSidePanel(null)} />
        </ErrorBoundary>
      )}
      {current && sidePanel === "preview" && (
        <ErrorBoundary name="预览面板">
          <PreviewPanel slot="primary" session={current} onClose={() => setSidePanel(null)} />
        </ErrorBoundary>
      )}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} actions={paletteActions} />
    </div>
  );
}

/** M5：单个会话栏（主/右栏复用） */
function Pane({
  slot,
  title,
  onClose,
  sidePanel,
  onTogglePanel,
}: {
  slot: PaneSlot;
  title?: string;
  onClose?: () => void;
  sidePanel?: "changes" | "preview" | null;
  onTogglePanel?: (p: "changes" | "preview") => void;
}) {
  return (
    <div className="pane">
      {onClose || onTogglePanel ? (
        <div className="pane-header">
          <span className="pane-title">{title ?? "分栏会话"}</span>
          {onTogglePanel && (
            <>
              <button
                className={`pane-tool ${sidePanel === "changes" ? "on" : ""}`}
                onClick={() => onTogglePanel("changes")}
                title="变更面板：审查 agent 的文件改动（F2）"
              >
                ± 变更
              </button>
              <button
                className={`pane-tool ${sidePanel === "preview" ? "on" : ""}`}
                onClick={() => onTogglePanel("preview")}
                title="预览面板：内嵌浏览器（F10）"
              >
                ◫ 预览
              </button>
            </>
          )}
          {onClose && (
            <button className="pane-close" onClick={onClose} title="收起分栏">
              ×
            </button>
          )}
        </div>
      ) : null}
      <ErrorBoundary name="任务面板">
        <TodoPanel slot={slot} />
      </ErrorBoundary>
      <ErrorBoundary name="对话区">
        <Trajectory slot={slot} />
      </ErrorBoundary>
      <ErrorBoundary name="输入区">
        <Composer slot={slot} />
      </ErrorBoundary>
      <ApprovalDialog slot={slot} />
    </div>
  );
}
