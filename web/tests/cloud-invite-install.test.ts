import { describe, it } from "vitest";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(__dirname, "..");

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`FAIL: ${msg}`);
}

function src(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

function testInviteAliasRoute(): void {
  assert(existsSync(resolve(ROOT, "app/invite/[token]/page.tsx")), "invite token route must exist");
  const s = src("app/invite/[token]/page.tsx");
  assert(s.includes("/join?invite="), "invite route must redirect to join accept page");
}

function testEngineMembersRoute(): void {
  // Engine #1047 moved Members into Settings: /members is now a redirect to
  // /settings?sel=members, and the workspace-members API seam (api.members.list)
  // lives in app/settings/page.tsx. The redirect must survive so old
  // bookmarks/deep-links keep working.
  assert(existsSync(resolve(ROOT, "app/members/page.tsx")), "members redirect route must exist");
  const redirect = src("app/members/page.tsx");
  assert(redirect.includes("/settings?sel=members"), "members route must redirect to settings members panel");
  assert(existsSync(resolve(ROOT, "app/settings/page.tsx")), "settings route must exist");
  const settings = src("app/settings/page.tsx");
  assert(settings.includes("api.members.list"), "settings page must use the engine workspace members API seam");
  assert(!existsSync(resolve(ROOT, "app/settings/members/page.tsx")), "settings members alias must remain de-forked");
}

function testInstallRoute(): void {
  assert(existsSync(resolve(ROOT, "app/install/[channel]/page.tsx")), "install channel route must exist");
  const s = src("app/install/[channel]/page.tsx");
  assert(s.includes("api.slack.installUrl"), "Slack install route must start Slack OAuth when configured");
  assert(s.includes("/connections/mcp?from_install=cli"), "CLI install route must hand off to MCP connection setup");
  assert(s.includes("requires platform OAuth credentials"), "provider-gated channels must show an explicit credential-gated state");
}

function testLoginInstallRoutes(): void {
  const s = src("app/login/page.tsx");
  assert(s.includes("INSTALL_ROUTES"), "login page must map install query params");
  assert(s.includes("/app/install/slack"), "Slack install must survive login");
  assert(s.includes("/app/install/whatsapp"), "WhatsApp install must survive login");
  assert(s.includes("/app/install/discord"), "Discord install must survive login");
  assert(s.includes("/app/install/cli"), "CLI install must survive login");
}

function testMiddlewarePublicInvite(): void {
  const s = src("middleware.ts");
  assert(s.includes('path.startsWith("/invite/")'), "invite aliases must be public pre-login");
  assert(s.includes('path.startsWith("/invites/")'), "invite preview API must be public pre-login");
}

function testMiddlewarePublicOnboardingInMainAndOverlay(): void {
  for (const rel of ["middleware.ts", "overlay/middleware.ts"]) {
    const s = src(rel);
    assert(s.includes('path === "/join"'), `${rel} must expose /join pre-login`);
    assert(s.includes('path === "/cli-auth"'), `${rel} must expose /cli-auth pre-login`);
    assert(s.includes('path.startsWith("/install/")'), `${rel} must expose /install/:channel pre-login`);
    assert(s.includes('path.startsWith("/auth/magic/")'), `${rel} must expose /auth/magic/:token pre-login`);
    assert(s.includes('path.startsWith("/workspace/share/")'), `${rel} must expose workspace share links pre-login`);
  }
}

// Originally a standalone script (pre-vitest); now a proper suite so the
// cloud runner (vitest.config.ts) can execute it.
describe("cloud invite/install routes", () => {
  it("invite route alias", testInviteAliasRoute);
  it("engine members route", testEngineMembersRoute);
  it("install channel route", testInstallRoute);
  it("login install routing", testLoginInstallRoutes);
  it("middleware public invite paths", testMiddlewarePublicInvite);
  it("middleware public onboarding paths in main and overlay", testMiddlewarePublicOnboardingInMainAndOverlay);
});
