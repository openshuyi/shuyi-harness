import { cn } from "cn";
import type * as React from "react";

/* 墨仪 §19 多行控件 —— 与 Input 同构：bg-2 底 + line-2 描边 + 焦点双层 */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
	return (
		<textarea
			className={cn(
				"field-sizing-content flex min-h-[72px] w-full rounded-sm border border-input bg-card px-3 py-2.5 text-[13.5px] leading-relaxed outline-none transition-colors placeholder:text-faint hover:border-line-strong focus-visible:border-line-strong focus-visible:ring-[3px] focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45 aria-invalid:border-destructive aria-invalid:ring-[3px] aria-invalid:ring-destructive-soft",
				className
			)}
			data-slot="textarea"
			{...props}
		/>
	);
}

export { Textarea };
