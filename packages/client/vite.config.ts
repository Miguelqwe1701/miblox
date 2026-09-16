import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  build: {
    // Two entry points: the game client, and Studio.
    rollupOptions: {
      input: {
        index: resolve(here, "index.html"),
        studio: resolve(here, "studio.html"),
        avatar: resolve(here, "avatar.html"),
      },
    },
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
  },
  server: { port: 5173 },
  // The wasm binary is copied into public/ by the prebuild step and fetched at
  // runtime, so it must not be pulled into dependency optimisation.
  optimizeDeps: { exclude: ["@miblox/wasm"] },
});
