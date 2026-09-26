import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import agents from "agents/vite";

// agents() transforms TC39 decorators (@callable) — Vite's Oxc transform does not support them yet.
export default defineConfig({
  plugins: [agents(), react(), cloudflare()],
});
