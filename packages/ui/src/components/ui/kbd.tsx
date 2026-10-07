import { cn } from "cn";

/* 墨仪 §03 快捷键胶囊 —— inset 底 + 发丝描边 + 底边加重（按键厚度感） */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
	return (
		<kbd
			className={cn(
				"pointer-events-none inline-flex h-fit w-fit min-w-5 shrink-0 items-center justify-center gap-1 rounded-xs border border-border border-b-2 bg-inset px-1.5 py-0.5 font-mono text-[11px] font-medium text-muted-foreground in-data-[slot=tooltip-content]:bg-popover/60 in-data-[slot=tooltip-content]:text-foreground/80 [&_svg:not([class*='size-'])]:size-3",
				className
			)}
			data-slot="kbd"
			{...props}
		/>
	);
}

function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<kbd
			className={cn("inline-flex items-center gap-1", className)}
			data-slot="kbd-group"
			{...props}
		/>
	);
}

export { Kbd, KbdGroup };
