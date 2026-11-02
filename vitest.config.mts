import { defineConfig } from "vitest/config";

// Convex mutation tests (convex-test). The plain unit tests in tests/ run
// with tsx --test; `npm test` runs both.
export default defineConfig({
  test: {
    environment: "edge-runtime",
    include: ["convex-tests/**/*.test.ts"],
    server: { deps: { inline: ["convex-test"] } },
  },
});
