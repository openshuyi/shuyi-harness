import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "cn";
import type * as React from "react";

/* 墨仪 §19 表单控件 —— 高 36（紧凑 30）；焦点 = line-3 边 + 3px accent-ring；
   错误 = danger 边 + mono 错误文案；inset 占位符为 text-3 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
	return (
		<InputPrimitive
			className={cn(
				"h-9 w-full min-w-0 rounded-sm border border-input bg-card px-3 py-1 text-[13.5px] transition-colors outline-none placeholder:text-faint hover:border-line-strong focus-visible:border-line-strong focus-visible:ring-[3px] focus-visible:ring-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45 aria-invalid:border-destructive aria-invalid:ring-[3px] aria-invalid:ring-destructive-soft file:inline-flex file:h-7 file:border-0 file:bg-transparent file:font-medium file:text-foreground file:text-xs",
				className
			)}
			data-slot="input"
			type={type}
			{...props}
		/>
	);
}

export { Input };
