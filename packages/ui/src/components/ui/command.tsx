import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@shuyi-harness/ui/components/ui/dialog";
import { Kbd } from "@shuyi-harness/ui/components/ui/kbd";
import { Command as CommandPrimitive } from "cmdk";
import { cn } from "cn";
import { SearchIcon } from "lucide-react";
import type * as React from "react";

/* 墨仪 §12 命令面板 —— ⌘K 一个入口覆盖全部动作：
   bg-3 浮层 + r-lg + shadow-pop；label-mono 分组 + kbd 右对齐 */
function Command({
	className,
	...props
}: React.ComponentProps<typeof CommandPrimitive>) {
	return (
		<CommandPrimitive
			className={cn(
				"flex size-full flex-col overflow-hidden rounded-lg bg-popover text-popover-foreground",
				className
			)}
			data-slot="command"
			{...props}
		/>
	);
}

function CommandDialog({
	title = "命令面板",
	description = "输入命令或会话名…",
	children,
	className,
	showCloseButton = false,
	...props
}: Omit<React.ComponentProps<typeof Dialog>, "children"> & {
	title?: string;
	description?: string;
	className?: string;
	showCloseButton?: boolean;
	children: React.ReactNode;
}) {
	return (
		<Dialog {...props}>
			<DialogHeader className="sr-only">
				<DialogTitle>{title}</DialogTitle>
				<DialogDescription>{description}</DialogDescription>
			</DialogHeader>
			<DialogContent
				className={cn(
					"top-[14vh] translate-y-0 overflow-hidden rounded-lg p-0 sm:max-w-[480px]",
					className
				)}
				showCloseButton={showCloseButton}
			>
				{children}
			</DialogContent>
		</Dialog>
	);
}

function CommandInput({
	className,
	children,
	...props
}: React.ComponentProps<typeof CommandPrimitive.Input> & {
	/** 输入框右侧内容（如 Esc 快捷键） */
	children?: React.ReactNode;
}) {
	return (
		<div
			className="flex h-[52px] items-center gap-2.5 border-b border-border px-4"
			data-slot="command-input-wrapper"
		>
			<SearchIcon className="size-4 shrink-0 text-faint" />
			<CommandPrimitive.Input
				className={cn(
					"flex-1 bg-transparent text-sm outline-hidden placeholder:text-faint disabled:cursor-not-allowed disabled:opacity-50",
					className
				)}
				data-slot="command-input"
				{...props}
			/>
			{children ?? <Kbd className="text-[10px]">esc</Kbd>}
		</div>
	);
}

function CommandList({
	className,
	...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
	return (
		<CommandPrimitive.List
			className={cn(
				"no-scrollbar max-h-80 scroll-py-1 overflow-y-auto overflow-x-hidden p-1.5 outline-none",
				className
			)}
			data-slot="command-list"
			{...props}
		/>
	);
}

function CommandEmpty({
	className,
	...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
	return (
		<CommandPrimitive.Empty
			className={cn("py-8 text-center text-xs text-faint", className)}
			data-slot="command-empty"
			{...props}
		/>
	);
}

function CommandGroup({
	className,
	...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
	return (
		<CommandPrimitive.Group
			className={cn(
				"overflow-hidden text-foreground **:[[cmdk-group-heading]]:px-2.5 **:[[cmdk-group-heading]]:pt-2 **:[[cmdk-group-heading]]:pb-1 **:[[cmdk-group-heading]]:font-mono **:[[cmdk-group-heading]]:text-[11px] **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:tracking-[0.06em] **:[[cmdk-group-heading]]:text-faint **:[[cmdk-group-heading]]:uppercase",
				className
			)}
			data-slot="command-group"
			{...props}
		/>
	);
}

function CommandSeparator({
	className,
	...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
	return (
		<CommandPrimitive.Separator
			className={cn("-mx-1 h-px bg-border", className)}
			data-slot="command-separator"
			{...props}
		/>
	);
}

function CommandItem({
	className,
	children,
	...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
	return (
		<CommandPrimitive.Item
			className={cn(
				"group/command-item relative flex h-8 cursor-default select-none items-center gap-2.5 rounded-sm px-2.5 text-[13px] text-muted-foreground outline-hidden transition-colors data-disabled:pointer-events-none data-selected:bg-accent data-selected:text-foreground data-[disabled=true]:opacity-50 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-faint data-selected:*:[svg]:text-foreground",
				className
			)}
			data-slot="command-item"
			{...props}
		>
			{children}
		</CommandPrimitive.Item>
	);
}

function CommandShortcut({
	className,
	...props
}: React.ComponentProps<"span">) {
	return (
		<span
			className={cn(
				"ml-auto font-mono text-[11px] tracking-widest text-faint group-data-selected/command-item:text-muted-foreground",
				className
			)}
			data-slot="command-shortcut"
			{...props}
		/>
	);
}

export {
	Command,
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
	CommandShortcut,
};
