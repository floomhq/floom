import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: [
      "tests/fl-batch-2.test.ts",
      "tests/fl-batch-3.test.ts",
      "tests/fl-batch-5.test.ts",
      "tests/fl-batch-6.test.ts",
      "tests/fl-batch-7.test.ts",
      "tests/fl-batch-8.test.ts",
      "tests/fl-batch-9.test.ts",
      "tests/fl-batch-10.test.ts",
      "tests/fl-batch-11.test.ts",
      "tests/fl-batch-12.test.ts",
      "tests/fl-batch-13.test.ts",
      "tests/fl-scroll-lock.test.ts",
      "tests/fl-session-fixes.test.ts",
      "tests/strip-citations.test.ts",
      "tests/worker-form-shared-components.test.ts",
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
