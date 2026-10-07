import { createFileRoute } from "@tanstack/react-router";

import App from "@/App";
import "@/styles.css";

export const Route = createFileRoute("/")({
	component: App,
});
