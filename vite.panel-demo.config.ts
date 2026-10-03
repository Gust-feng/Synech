import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "src/app/panel-ui",
  envDir: import.meta.dirname,
  base: "./",
  plugins: [panelDemoEntryPlugin(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@ui": path.resolve("src/app/panel-ui/src"),
      "@panel-api": path.resolve("src/app/panel-api"),
    },
  },
  build: {
    outDir: "../../../dist/app/panel-demo",
    emptyOutDir: true,
    sourcemap: true,
  },
});

function panelDemoEntryPlugin(): Plugin {
  const demoEntry = path.resolve("src/app/panel-demo/demo-main.ts");
  return {
    name: "synech:panel-demo-entry",
    enforce: "pre",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return html.replace(
          '<script type="module" src="/src/main.tsx"></script>',
          '<script type="module" src="/@panel-demo-entry"></script>',
        );
      },
    },
    resolveId(source) {
      return source === "/@panel-demo-entry" ? demoEntry : undefined;
    },
  };
}
