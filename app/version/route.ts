import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function firstEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return "unknown";
}

function buildIdentity() {
  return {
    status: "ok",
    service: "cloud-landing",
    deploy: "cloud",
    environment: firstEnv("WORKEROS_ENVIRONMENT", "VERCEL_ENV"),
    build_sha: firstEnv(
      "NEXT_PUBLIC_BUILD_SHA",
      "WORKEROS_BUILD_SHA",
      "BUILD_SHA",
      "VERCEL_GIT_COMMIT_SHA",
      "GITHUB_SHA",
    ),
    build_ref: firstEnv(
      "NEXT_PUBLIC_BUILD_REF",
      "WORKEROS_BUILD_REF",
      "VERCEL_GIT_COMMIT_REF",
      "GITHUB_REF_NAME",
    ),
    build_time: firstEnv("NEXT_PUBLIC_BUILD_TIME", "WORKEROS_BUILD_TIME", "BUILD_TIME"),
    build_source: firstEnv("NEXT_PUBLIC_BUILD_SOURCE", "WORKEROS_BUILD_SOURCE"),
  };
}

export function GET() {
  return NextResponse.json(buildIdentity());
}
