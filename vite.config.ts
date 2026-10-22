import { defineConfig } from "vite";
export default defineConfig({
  esbuild: { jsx: "automatic" },
  server: { hmr: false },
  build: { chunkSizeWarningLimit: 1400 },
});
