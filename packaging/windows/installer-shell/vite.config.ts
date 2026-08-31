import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const shellRoot = path.resolve(import.meta.dirname, "web");

export default defineConfig({
  root: shellRoot,
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@synech/scene": path.resolve(import.meta.dirname, "../../../src/app/panel-ui/src/shell/entry-scene/home-scene.ts"),
    },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, "generated/web"),
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    rolldownOptions: {
      output: {
        entryFileNames: "assets/shell.js",
        assetFileNames: (assetInfo) => assetInfo.names.some((name) => name.endsWith(".css"))
          ? "assets/shell.css"
          : "assets/[name][extname]",
      },
    },
  },
});
