import "varlock/auto-load";

// biome-ignore lint/performance/noBarrelFile: varlock 装配模块——auto-load 副作用 + ENV/desktopOrigins 的统一出口
export { ENV } from "./env";

/** Packaged desktop builds serve the frontend from their own origin, not CORS_ORIGIN. */
export const desktopOrigins = ["tauri://localhost", "http://tauri.localhost"];
