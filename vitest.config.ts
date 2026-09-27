import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Windows runners spend longer starting child processes than Unix runners.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
