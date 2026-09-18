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
        "@opencode/client",
        "@opencode/client/service",
        "vite",
      ],
    },
  },
});
