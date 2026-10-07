import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

/* 墨仪 §10 分段控件（seg）内单元 —— inset 底容器内：
   未选 text-3，选中 accent-soft + 天青 */
const toggleVariants = cva(
	"group/toggle inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-xs font-medium text-xs outline-none transition-all hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-pressed:bg-accent data-pressed:text-primary [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
	{
		defaultVariants: {
			size: "default",
			variant: "default",
		},
		variants: {
			size: {
				default: "h-6 min-w-8 px-3",
				lg: "h-7 min-w-9 px-3.5",
				sm: "h-5 min-w-7 px-2.5",
			},
			variant: {
				default: "bg-transparent text-muted-foreground",
				outline:
					"border border-input bg-transparent text-muted-foreground hover:bg-accent hover:text-primary",
			},
		},
	}
);

function Toggle({
	className,
	variant = "default",
	size = "default",
	...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
	return (
		<TogglePrimitive
			className={cn(toggleVariants({ className, size, variant }))}
			data-slot="toggle"
			{...props}
		/>
	);
}

export { Toggle, toggleVariants };
