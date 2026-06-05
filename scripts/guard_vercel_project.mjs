#!/usr/bin/env node

const DASHBOARD_PROJECT_ID = "prj_xMRlSPT2zTk2wdX5p0jPbwEbqHqa";

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
