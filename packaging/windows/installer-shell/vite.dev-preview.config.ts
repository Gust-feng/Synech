import path from "node:path";
import { mergeConfig } from "vite";
import baseConfig from "./vite.config";

// 仅用于本地预览安装器 UI：把依赖优化缓存放到独立目录，
// 避免 dev server 尝试清理 node_modules/.vite 里的既有缓存。
export default mergeConfig(baseConfig, {
  cacheDir: path.resolve(import.meta.dirname, ".vite-preview-cache"),
  server: {
    host: "127.0.0.1",
    port: 5199,
    strictPort: true,
    open: "/mock.html",
  },
});
