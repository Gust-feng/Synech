import { request } from "node:http";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "src/app/panel-ui",
  envDir: import.meta.dirname,
  plugins: [react(), tailwindcss(), panelApiProxyPlugin()],
  build: {
    outDir: "../../../dist/app/panel-ui",
    emptyOutDir: true,
    sourcemap: true,
    rolldownOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replaceAll("\\", "/");
          if (!normalized.includes("/node_modules/")) return undefined;
          if (normalized.includes("/prosemirror-")) return "editor-prosemirror";
          if (normalized.includes("/@tiptap+") || normalized.includes("/tiptap-markdown")) return "editor-tiptap";
          if (
            normalized.includes("/markdown-it/")
            || normalized.includes("/linkify-it/")
            || normalized.includes("/linkifyjs/")
            || normalized.includes("/entities/")
            || normalized.includes("/punycode.js/")
            || normalized.includes("/uc.micro/")
          ) return "editor-markdown";
          return undefined;
        },
      },
    },
  },
});

const PANEL_PROXY_PREFIXES = ["/api", "/health", "/favicon.svg"] as const;

function panelApiProxyPlugin(): Plugin {
  const host = process.env.SYNECH_PANEL_API_HOST ?? "127.0.0.1";
  const port = process.env.SYNECH_PANEL_API_PORT ?? "4306";
  // 不用 vite 内置 server.proxy：vite 会无条件把代理目标未就绪的
  // ECONNREFUSED 打印成 error 刷屏（dev 启动时面板服务晚于 vite 就绪，
  // 已打开的页面会自动刷新触发一批请求）。这里转发失败时静默返回 503，
  // 服务就绪后请求自然成功；其余错误照常打印，不掩盖真实故障。
  return {
    name: "synech:panel-api-proxy",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "/";
        if (!PANEL_PROXY_PREFIXES.some((prefix) => url.startsWith(prefix))) {
          return next();
        }
        const headers: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(req.headers)) {
          if (value !== undefined) headers[name] = value;
        }
        headers.host = `${host}:${port}`;
        const upstream = request({ host, port, path: url, method: req.method, headers }, (upstreamResponse) => {
          res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(res);
        });
        upstream.on("error", (error) => {
          if (res.headersSent || res.writableEnded) {
            res.destroy();
            return;
          }
          if (error instanceof Error && error.message.includes("ECONNREFUSED")) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "panel_not_ready" }));
            return;
          }
          console.error(`[panel-proxy] 转发 ${url} 到 ${host}:${port} 失败：${error instanceof Error ? error.message : String(error)}`);
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "panel_proxy_error" }));
        });
        req.pipe(upstream);
      });
    },
  };
}
