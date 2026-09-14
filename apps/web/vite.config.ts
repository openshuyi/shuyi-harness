import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        // 使用 127.0.0.1 而非 localhost：部分机器上 localhost 解析为 ::1（IPv6），
        // 会导致代理连接失败或命中异常中间层
        target: "http://127.0.0.1:3210",
        changeOrigin: true,
      },
    },
  },
});
