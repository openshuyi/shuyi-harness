import { ThemeProvider as NextThemesProvider } from "next-themes";
import type * as React from "react";

export function ThemeProvider({
	children,
	...props
}: React.ComponentProps<typeof NextThemesProvider>) {
	return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}

// biome-ignore lint/performance/noBarrelFile: 模板自带的 useTheme 出口（__root 需要）
export { useTheme } from "next-themes";
