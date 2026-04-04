import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/a/(.*)",
  "/api/(.*)",
  "/install-skill.sh",
  "/marketing(.*)",
]);

const LANDING_HOSTS = ["floom.dev", "www.floom.dev"];

export default clerkMiddleware(async (auth, request) => {
  const hostname = request.headers.get("host")?.split(":")[0] ?? "";

  // floom.dev is fully public — rewrites in next.config.ts handle routing to /marketing/*
  if (LANDING_HOSTS.includes(hostname)) {
    return NextResponse.next();
  }

  // On dashboard domain, block direct access to /marketing/* to keep URLs clean
  if (request.nextUrl.pathname.startsWith("/marketing")) {
    return NextResponse.rewrite(new URL("/404", request.url));
  }

  if (!isPublicRoute(request)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
