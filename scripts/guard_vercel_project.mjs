#!/usr/bin/env node

// The floomhq-team workeros-cloud-dashboard project. The repo root must never be
// built INSIDE this project (root deploy would upload the landing vercel.json and
// make /app rewrite to itself); the dashboard is built from ./web only. The old
// value here (prj_xMRlSPT2zTk2wdX5p0jPbwEbqHqa) was a personal-team project of the
// same name that does not resolve under the floomhq team, so this guard never
// fired for the real floomhq dashboard build.
const DASHBOARD_PROJECT_ID = "prj_K4EXgIgtwjD54fpU2MjjFJ5SLWKT";

const projectId = process.env.VERCEL_PROJECT_ID || "";
const isVercelBuild = process.env.VERCEL === "1";

if (isVercelBuild && projectId === DASHBOARD_PROJECT_ID) {
  console.error(
    [
      "Refusing to build the repo root in the workeros-cloud-dashboard Vercel project.",
      "Deploy the dashboard from ./web after running: cd web && npm run sync && vercel deploy --prod --yes",
      "A root deploy uploads the landing vercel.json into the dashboard project and makes /app rewrite to itself.",
    ].join("\n")
  );
  process.exit(1);
}
