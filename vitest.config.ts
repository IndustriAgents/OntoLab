import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "server/**/*.test.ts", "tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["src/lib/**", "server/**"],
      exclude: ["**/*.test.ts"],
    },
  },
});
