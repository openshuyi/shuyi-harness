import { Button } from "@shuyi-harness/ui/components/ui/button";
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
				<div className="p-6 text-[13px] text-destructive">
					<div className="mb-2 font-semibold">{this.props.name} 渲染出错</div>
					<pre className="font-mono text-xs whitespace-pre-wrap text-muted-foreground">
						{error.message}
					</pre>
					<Button
						className="mt-3"
						onClick={() => this.setState({ error: null })}
						size="sm"
						variant="outline"
					>
						重试
					</Button>
				</div>
			);
		}
		return this.props.children;
	}
}
