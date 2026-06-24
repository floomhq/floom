import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

const alias = { "@": path.resolve(__dirname, ".") };

// Existing node tests excluded from the runner (incomplete tsx→vitest
// migration). Component (jsdom) tests use the *.dom.test.tsx suffix and run in
// their own project so the node suite is left exactly as it was.
const nodeExclude = [
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
          maxWorkers: 1,
          setupFiles: ["tests/setup-dom.ts"],
          include: ["tests/**/*.dom.test.tsx"],
        },
      },
    ],
  },
});
