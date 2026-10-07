import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import type * as React from "react";

/* 墨仪 §04 状态点 —— 8px 状态点是整个系统的「指示灯」：
   进行中（accent，pulse）/ 等待审批（warning，pulse）/ 完成（石绿）/
   失败（茜红）/ 空闲（黛）。色彩即信号，盖印即仪式。 */
const statusDotVariants = cva("inline-block size-2 shrink-0 rounded-full", {
	defaultVariants: {
		tone: "idle",
	},
	variants: {
		tone: {
			accent: "bg-primary",
			danger: "bg-destructive",
			idle: "bg-faint",
			success: "bg-success",
			warning: "bg-warning",
		},
	},
});

function StatusDot({
	className,
	tone = "idle",
	pulse = false,
	...props
}: Omit<React.ComponentProps<"span">, "color"> &
	VariantProps<typeof statusDotVariants> & {
		/** 信号脉冲：running / awaiting 态呼吸 */
		pulse?: boolean;
	}) {
	return (
		<span
			aria-hidden
			className={cn(
				statusDotVariants({ tone }),
				pulse && "animate-signal",
				className
			)}
			data-slot="status-dot"
			data-tone={tone}
			{...props}
		/>
	);
}

export { StatusDot, statusDotVariants };
