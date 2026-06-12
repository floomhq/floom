// Landing (apex app) unit tests. The dashboard's suite lives in web/ with its
// own runner; this config covers app/ + components/ (marketing/landing only).
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

const alias = { "@": path.resolve(__dirname, ".") };

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: "landing-node",
          environment: "node",
          include: ["tests/landing/**/*.test.ts"],
        },
      },
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: "landing-dom",
          environment: "jsdom",
          globals: true,
          include: ["tests/landing/**/*.dom.test.tsx"],
        },
      },
    ],
  },
});
