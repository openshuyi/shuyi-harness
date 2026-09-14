import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** 区域名称，用于错误提示文案 */
  name: string;
}

interface State {
  error: Error | null;
}

/** 局部错误边界：单个面板渲染出错时只降级该面板，不再整页空白 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (error) {
      return (
        <div style={{ padding: 24, fontSize: 13, color: "#f87171" }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>{this.props.name} 渲染出错</div>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, color: "var(--text-dim, #888)" }}>
            {error.message}
          </pre>
          <button
            className="primary"
            style={{ marginTop: 12 }}
            onClick={() => this.setState({ error: null })}
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
