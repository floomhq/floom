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

function testSettingsMembersAliasRoute(): void {
  assert(existsSync(resolve(ROOT, "app/settings/members/page.tsx")), "settings members alias must exist");
  const s = src("app/settings/members/page.tsx");
  assert(s.includes('redirect("/members")'), "settings members must redirect to members page");
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

// Originally a standalone script (pre-vitest); now a proper suite so the
// cloud runner (vitest.config.ts) can execute it.
describe("cloud invite/install routes", () => {
  it("invite route alias", testInviteAliasRoute);
  it("settings members alias", testSettingsMembersAliasRoute);
  it("install channel route", testInstallRoute);
  it("login install routing", testLoginInstallRoutes);
  it("middleware public invite paths", testMiddlewarePublicInvite);
});
