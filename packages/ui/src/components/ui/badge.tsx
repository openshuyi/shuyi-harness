import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

/* 墨仪 §04 徽章与状态 —— 色彩即信号：
   mono 11px uppercase + r-xs；语义变体 = 颜料 soft 底 + 35% 描边 */
const badgeVariants = cva(
	"group/badge inline-flex h-fit w-fit shrink-0 items-center justify-center gap-1.5 overflow-hidden whitespace-nowrap rounded-xs border px-2 py-[3px] font-mono text-[11px] font-medium tracking-[0.05em] uppercase transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&>svg]:pointer-events-none [&>svg]:size-3!",
	{
		defaultVariants: {
			variant: "default",
		},
		variants: {
			variant: {
				accent: "border-primary/35 bg-accent text-primary [a]:hover:bg-accent",
				default:
					"bg-primary text-primary-foreground [a]:hover:bg-primary-hover",
				destructive:
					"border-destructive/35 bg-destructive-soft text-destructive [a]:hover:bg-destructive-soft",
				ghost: "hover:bg-accent hover:text-foreground",
				idle: "border-border bg-card text-muted-foreground [a]:hover:bg-accent",
				info: "border-info/35 bg-info-soft text-info [a]:hover:bg-info-soft",
				link: "text-primary underline-offset-4 hover:underline",
				outline:
					"border-border bg-card text-muted-foreground [a]:hover:bg-accent [a]:hover:text-foreground",
				secondary: "border-border bg-card text-foreground [a]:hover:bg-popover",
				success:
					"border-success/35 bg-success-soft text-success [a]:hover:bg-success-soft",
				warning:
					"border-warning/35 bg-warning-soft text-warning [a]:hover:bg-warning-soft",
			},
		},
	}
);

function Badge({
	className,
	variant = "default",
	render,
	...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
	return useRender({
		defaultTagName: "span",
		props: mergeProps<"span">(
			{
				className: cn(badgeVariants({ variant }), className),
			},
			props
		),
		render,
		state: {
			slot: "badge",
			variant,
		},
	});
}

export { Badge, badgeVariants };
