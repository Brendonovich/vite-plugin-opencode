import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: "index",
    },
    rollupOptions: {
      external: [
        /^node:/,
        "@babel/core",
        "@opencode-ai/client",
        "@opencode-ai/client/service",
        "vite",
      ],
    },
  },
});
