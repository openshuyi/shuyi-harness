import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App.js";
import "./styles.css";

// 主题初始化：localStorage 记忆 > 系统偏好 > 深色
const saved = localStorage.getItem("shuyi-theme");
const theme =
  saved === "light" || saved === "dark"
    ? saved
    : window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
document.documentElement.dataset.theme = theme;

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
