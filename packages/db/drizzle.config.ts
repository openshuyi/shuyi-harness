import { defineConfig } from "drizzle-kit";
import "varlock/auto-load";

export default defineConfig({
	dbCredentials: {
		url: process.env.DATABASE_URL || "",
	},
	dialect: "turso",
	out: "./src/migrations",
	schema: "./src/schema/index.ts",
});
