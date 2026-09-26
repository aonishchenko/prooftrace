import { defineConfig } from "vitest/config";

// Unit tests run in plain Node; they must not load the Cloudflare Vite plugin.
export default defineConfig({
  test: { include: ["src/**/__tests__/**/*.test.ts"], environment: "node" },
});
