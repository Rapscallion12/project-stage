import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    // Every integration test in this project hits the same real, shared
    // linked Supabase project (this project's testing philosophy — no
    // mocks). That was safe under Vitest's default parallel file
    // execution as long as each file's fixtures used unique, randomly
    // generated ids/emails that could never collide across files. It
    // stopped being safe once two independent files
    // (scripts/dev-harness.test.ts and
    // src/lib/repositories/dev-demo.test.ts) both started sharing the
    // `[dev-harness] ` tag on purpose (so the CLI and the /dev page can
    // clean up after each other) and each runs its own "delete
    // everything tagged" reset — running concurrently, one file's reset
    // could delete the other file's still-in-use fixtures mid-run,
    // producing a real (not flaky-network) test failure. Disabling file
    // parallelism removes this whole class of cross-file interference,
    // present and future, for the cost of a few extra seconds of total
    // suite runtime — worth it for a prototype's test suite.
    fileParallelism: false,
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
