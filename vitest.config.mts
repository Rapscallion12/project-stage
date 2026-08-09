import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    // Loads .env.local (same file the app itself uses) into process.env
    // for tests that need real Supabase credentials — e.g. verifying RLS
    // actually blocks a write, not just that the migration says it does.
    // Empty prefix loads every var, not just VITE_/PUBLIC_-prefixed ones.
    env: loadEnv(mode, process.cwd(), ""),
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
}));
