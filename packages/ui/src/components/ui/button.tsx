import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

/* 墨仪 §03 按钮与操作 —— 告别胶囊：
   统一 8px 圆角、三档高度（30/36/42）；渐变不出现在任何按钮上。
   primary = 天青纯色 · seal = 朱砂（批准仪式） · focus ring 3px accent-ring */
const buttonVariants = cva(
	"group/button inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-sm border border-transparent bg-clip-padding font-medium text-[13px] outline-none transition-all duration-100 ease-(--ease-instrument) focus-visible:ring-[3px] focus-visible:ring-ring active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-45 aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/20 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
	{
		defaultVariants: {
			size: "default",
			variant: "default",
		},
		variants: {
			size: {
				default:
					"h-9 gap-1.5 px-3.5 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
				icon: "size-[30px]",
				"icon-lg": "size-9",
				"icon-sm": "size-7 rounded-xs",
				"icon-xs": "size-6 rounded-xs [&_svg:not([class*='size-'])]:size-3",
				lg: "h-[42px] gap-2 px-[18px] text-sm has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4",
				sm: "h-[30px] gap-1.5 rounded-sm px-3 text-[12.5px] has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5 [&_svg:not([class*='size-'])]:size-3.5",
				xs: "h-6 gap-1 rounded-xs px-2 text-xs [&_svg:not([class*='size-'])]:size-3",
			},
			variant: {
				default:
					"bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active",
				destructive: "bg-destructive text-white hover:brightness-110",
				"destructive-soft":
					"bg-destructive-soft text-destructive hover:brightness-110",
				ghost:
					"bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground",
				link: "text-primary underline-offset-4 hover:underline",
				outline:
					"border-border bg-card text-foreground hover:bg-popover hover:border-line-strong aria-expanded:bg-popover aria-expanded:text-foreground",
				seal: "bg-seal text-seal-foreground hover:bg-seal-hover",
				secondary:
					"border-border bg-card text-foreground hover:bg-popover hover:border-line-strong aria-expanded:bg-popover aria-expanded:text-foreground",
			},
		},
	}
);

function Button({
	className,
	variant = "default",
	size = "default",
	...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
	return (
		<ButtonPrimitive
			className={cn(buttonVariants({ className, size, variant }))}
			data-slot="button"
			{...props}
		/>
	);
}

export { Button, buttonVariants };
