import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { toggleVariants } from "@shuyi-harness/ui/components/ui/toggle";
import type { VariantProps } from "class-variance-authority";
import { cn } from "cn";
import * as React from "react";

const ToggleGroupContext = React.createContext<
	VariantProps<typeof toggleVariants> & {
		spacing?: number;
		orientation?: "horizontal" | "vertical";
	}
>({
	orientation: "horizontal",
	size: "default",
	spacing: 2,
	variant: "default",
});

function ToggleGroup({
	className,
	variant,
	size,
	spacing = 2,
	orientation = "horizontal",
	children,
	...props
}: ToggleGroupPrimitive.Props &
	VariantProps<typeof toggleVariants> & {
		spacing?: number;
		orientation?: "horizontal" | "vertical";
	}) {
	return (
		<ToggleGroupPrimitive
			className={cn(
				"group/toggle-group inline-flex w-fit flex-row items-center gap-0.5 rounded-sm border border-border bg-inset p-0.5 data-vertical:flex-col data-vertical:items-stretch",
				className
			)}
			data-orientation={orientation}
			data-size={size}
			data-slot="toggle-group"
			data-spacing={spacing}
			data-variant={variant}
			style={{ "--gap": spacing } as React.CSSProperties}
			{...props}
		>
			<ToggleGroupContext.Provider
				value={{ orientation, size, spacing, variant }}
			>
				{children}
			</ToggleGroupContext.Provider>
		</ToggleGroupPrimitive>
	);
}

function ToggleGroupItem({
	className,
	children,
	variant = "default",
	size = "default",
	...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
	const context = React.useContext(ToggleGroupContext);

	return (
		<TogglePrimitive
			className={cn(
				"shrink-0 rounded-xs focus:z-10 focus-visible:z-10",
				toggleVariants({
					size: context.size || size,
					variant: context.variant || variant,
				}),
				className
			)}
			data-size={context.size || size}
			data-slot="toggle-group-item"
			data-spacing={context.spacing}
			data-variant={context.variant || variant}
			{...props}
		>
			{children}
		</TogglePrimitive>
	);
}

export { ToggleGroup, ToggleGroupItem };
