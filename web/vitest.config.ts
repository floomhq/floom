// CLOUD-OWNED (not synced from the engine — sync-engine-web.mjs does not list
// it in COPY_ROOT_FILES). Mirrors engine/apps/web/vitest.config.ts and adds
// `cloudExclude`: engine tests whose SUBJECT files the cloud overlay replaces.
// Those tests assert engine behavior (engine middleware, engine proxy auth,
// engine settings/login pages) that the overlay intentionally changes for
// Supabase auth + workspaces. Cloud equivalents live in overlay/tests/.
//
// If you exclude something here, either the overlay must carry its own test
// (see tests/verify-session-935.test.ts for the middleware) or the exclusion
// is feature drift to fix by porting the engine feature into the overlay —
// note it in the PR.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

const alias = { "@": path.resolve(__dirname, ".") };

// Engine tests excluded upstream (incomplete tsx→vitest migration there).
const engineNodeExclude = [
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

// Engine tests whose subjects are overlay-replaced on cloud.
const cloudExclude = [
  // overlay/middleware.ts (Supabase session) replaces the engine auth gate;
  // cloud coverage: tests/verify-session-935.test.ts
  "tests/middleware.test.ts",
  // overlay proxy authenticates via Supabase Bearer, not FLOOM_API_SECRET
  "tests/proxy-route.test.ts",
  // overlay app/settings/page.tsx is a cloud fork that has NOT yet ported the
  // engine's Git tab / behaviour toggles / model defaults — known drift,
  // tracked in the g2 PR notes.
  "tests/fl-batch-14.test.ts",
  "tests/workspace-info-791.dom.test.tsx",
  "tests/behaviour-settings-794.dom.test.tsx",
  "tests/model-defaults-797.dom.test.tsx",
  // overlay app/login/page.tsx is the cloud login (Supabase), not the engine
  // split-pane login
  "tests/login-split-822.dom.test.tsx",
  // overlay app/contexts/page.tsx is a cloud fork; brain tag editing differs
  "tests/brain-tags-780.dom.test.tsx",
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
          exclude: [...engineNodeExclude, ...cloudExclude],
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
          exclude: cloudExclude,
        },
      },
    ],
  },
});
