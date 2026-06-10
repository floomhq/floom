import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

const alias = { "@": path.resolve(__dirname, ".") };

// Existing node tests excluded from the runner (incomplete tsx→vitest
// migration). Component (jsdom) tests use the *.dom.test.tsx suffix and run in
// their own project so the node suite is left exactly as it was.
const nodeExclude = [
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
  "tests/**/*.dom.test.tsx",
];

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: "node",
          environment: "node",
          include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
          exclude: nodeExclude,
        },
      },
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: "dom",
          environment: "jsdom",
          globals: true,
          setupFiles: ["tests/setup-dom.ts"],
          include: ["tests/**/*.dom.test.tsx"],
        },
      },
    ],
  },
});
