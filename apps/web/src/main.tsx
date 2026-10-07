import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import ReactDOM from "react-dom/client";

import Loader from "./components/loader";
import { routeTree } from "./routeTree.gen";
import { orpc, queryClient } from "./utils/orpc";

const router = createRouter({
	context: { orpc, queryClient },
	defaultPendingComponent: () => <Loader />,
	defaultPreload: "intent",
	routeTree,
	scrollRestoration: true,
	Wrap({ children }: { children: React.ReactNode }) {
		return (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
	},
});

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

// 主题初始化：localStorage 记忆 > 系统偏好 > 深色
const saved = localStorage.getItem("shuyi-theme");
let theme = "dark";
if (saved === "light" || saved === "dark") {
	theme = saved;
} else if (window.matchMedia("(prefers-color-scheme: light)").matches) {
	theme = "light";
}
document.documentElement.dataset.theme = theme;

const rootElement = document.getElementById("app");

if (!rootElement) {
	throw new Error("Root element not found");
}

if (!rootElement.innerHTML) {
	const root = ReactDOM.createRoot(rootElement);
	root.render(<RouterProvider router={router} />);
}
