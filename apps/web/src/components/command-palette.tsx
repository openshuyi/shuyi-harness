/**
 * 命令面板（墨仪 §12）：⌘K 一个入口覆盖全部动作。
 * cmdk 内核——输入即过滤、↑↓ 导航、⏎ 执行、Esc 关闭。
 * 动作集合由 App 注入（需要切换主题/新建会话等上下文）。
 */
import {
	Command,
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@shuyi-harness/ui/components/ui/command";

export interface PaletteAction {
	hint?: string;
	id: string;
	label: string;
	run: () => void;
}

export function CommandPalette({
	open,
	onClose,
	actions,
}: {
	open: boolean;
	onClose: () => void;
	actions: PaletteAction[];
}) {
	return (
		<CommandDialog
			description="输入命令或会话名…"
			onOpenChange={(o) => {
				if (!o) onClose();
			}}
			open={open}
			title="命令面板"
		>
			<Command>
				<CommandInput placeholder="输入命令…（↑↓ 选择，Enter 执行）" />
				<CommandList>
					<CommandEmpty>无匹配命令</CommandEmpty>
					<CommandGroup heading="action">
						{actions.map((a) => (
							<CommandItem
								key={a.id}
								onSelect={() => {
									onClose();
									a.run();
								}}
								value={`${a.label} ${a.hint ?? ""}`}
							>
								<span>{a.label}</span>
								{a.hint && (
									<span className="ml-auto font-mono text-[11px] text-faint">
										{a.hint}
									</span>
								)}
							</CommandItem>
						))}
					</CommandGroup>
				</CommandList>
			</Command>
		</CommandDialog>
	);
}
