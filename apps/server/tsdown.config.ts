import { defineConfig } from "tsdown";

export default defineConfig({
	clean: true,
	deps: {
		alwaysBundle: [/@shuyi-harness\/.*/],
	},
	entry: "./src/index.ts",
	format: "esm",
	outDir: "./dist",
});
