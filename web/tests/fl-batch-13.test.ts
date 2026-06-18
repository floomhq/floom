/**
 * Batch-13 tests.
 * #562 — Onboarding: direct connect links with return_to from worker detail.
 * #538 — Slack zero-UI auth: magic link endpoints + Emily Slack integration.
 *
 * Run: npx tsx tests/fl-batch-13.test.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(__dirname, "..");
const API_ROOT = resolve(__dirname, "../../api");

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`FAIL: ${msg}`);
}

function src(rel: string) { return readFileSync(resolve(ROOT, rel), "utf8"); }
function api(rel: string) { return readFileSync(resolve(API_ROOT, rel), "utf8"); }

// ---------------------------------------------------------------------------
// #562 — Connections rows link directly to connect flow
// ---------------------------------------------------------------------------

function test562MissingConnectionsDirectLink(): void {
  const s = src("app/connections/ConnectionsCollection.tsx");
  assert(
    s.includes("/connections/connect/") && s.includes("return_to"),
    "Connection setup action must link directly to /connections/connect/{slug} with return_to",
  );
  assert(
    s.includes("encodeURIComponent(i.connection.app_name)"),
    "Connect link slugs must be URI-encoded",
  );
}

function test562MissingSecretsDirectLink(): void {
  const s = src("components/overview/AlertsBell.tsx");
  assert(
    s.includes("setup_incomplete") && s.includes("connections/secrets"),
    "Missing secrets alert must link to /connections/secrets",
  );
}

function test562TopLevelSecretLinkUpdated(): void {
  const s = src("components/overview/AlertsBell.tsx");
  assert(
    !s.includes('href="/secrets"'),
    "Top-level 'Add secret →' link must not point to bare /secrets (stale path)",
  );
  assert(
    s.includes("connections/secrets"),
    "Top-level secret link must point to /connections/secrets",
  );
}

// ---------------------------------------------------------------------------
// #538 — Backend: magic link token helpers
// ---------------------------------------------------------------------------

function test538MagicLinkIssuer(): void {
  // PR #1073 (oss-prep) moved magic-link helpers out of main.py into services/auth_ops.py.
  const s = api("services/auth_ops.py");
  assert(
    s.includes("_issue_magic_link") && s.includes("ttl_seconds"),
    "services/auth_ops.py must define _issue_magic_link helper with ttl_seconds param",
  );
  assert(
    s.includes("_validate_magic_link"),
    "services/auth_ops.py must define _validate_magic_link helper",
  );
}

function test538MagicLinkUsesHmac(): void {
  // PR #1073 (oss-prep) moved _issue_magic_link to services/auth_ops.py.
  const s = api("services/auth_ops.py");
  const issuerIdx = s.indexOf("def _issue_magic_link");
  const snippet = s.slice(issuerIdx, issuerIdx + 800);
  assert(
    snippet.includes("hmac.new") && snippet.includes("sha256"),
    "_issue_magic_link must use HMAC-SHA256 to sign the token",
  );
}

function test538MagicLinkHasOwnSecret(): void {
  // PR #1073 (oss-prep) moved _magic_link_secret to services/auth_ops.py.
  const s = api("services/auth_ops.py");
  assert(
    s.includes("_magic_link_secret"),
    "magic link must use _magic_link_secret(), not _slack_state_secret() directly",
  );
  assert(
    s.includes("WORKEROS_MAGIC_LINK_SECRET"),
    "_magic_link_secret must check WORKEROS_MAGIC_LINK_SECRET env var",
  );
  assert(
    s.includes("_MAGIC_LINK_FALLBACK_SECRET"),
    "_magic_link_secret must have a process-scoped fallback for local dev",
  );
}

function test538MagicLinkEndpointIssue(): void {
  // PR #1073 (oss-prep) moved auth endpoints out of main.py into routers/auth.py.
  const s = api("routers/auth.py");
  assert(
    s.includes('"/auth/magic-link"') || s.includes("'/auth/magic-link'"),
    "routers/auth.py must define POST /auth/magic-link endpoint",
  );
  assert(
    s.includes("expires_in"),
    "POST /auth/magic-link must return expires_in",
  );
}

function test538MagicLinkEndpointConsume(): void {
  // PR #1073 (oss-prep) moved auth endpoints out of main.py into routers/auth.py.
  const s = api("routers/auth.py");
  assert(
    s.includes('"/auth/magic/{token}"') || s.includes("'/auth/magic/{token}'"),
    "routers/auth.py must define GET /auth/magic/{token} endpoint",
  );
  assert(
    s.includes("session_repo.create") && s.includes("SESSION_COOKIE"),
    "GET /auth/magic/{token} must create a session and set the session cookie",
  );
}

// ---------------------------------------------------------------------------
// #538 — Backend: Slack DM handler injects sign-in URL into Emily's context
// ---------------------------------------------------------------------------

function test538SlackDmHandlerGeneratesMagicLink(): void {
  // _handle_slack_direct_message was extracted to channels/slack.py by the channels refactor.
  // PR #803 extended the function with claim-link binding; magic link generation now lives
  // in the bound-user path (~2000 chars into the function body), so we search the full file.
  const s = api("channels/slack.py");
  assert(
    s.includes("_issue_magic_link") && s.includes("_frontend_base_url"),
    "_handle_slack_direct_message must generate a magic link URL for the system context",
  );
}

function test538SlackDmHandlerPassesSystemSuffix(): void {
  // _handle_slack_direct_message was extracted to channels/slack.py by the channels refactor.
  // PR #803 extended the function; system_suffix is passed in the bound-user path.
  const s = api("channels/slack.py");
  assert(
    s.includes("system_suffix"),
    "_handle_slack_direct_message must pass system_suffix to _collect_workspace_agent_reply_for_slack",
  );
}

function test538StreamChatAcceptsSystemSuffix(): void {
  const s = api("chat_service.py");
  assert(
    s.includes("system_suffix"),
    "stream_chat must accept system_suffix parameter",
  );
  assert(
    s.includes("system_prompt = f\"{system_prompt}") || s.includes("system_suffix"),
    "system_suffix must be appended to the system prompt when provided",
  );
}

// ---------------------------------------------------------------------------
// #538 — Frontend: magic link page and api.ts method
// ---------------------------------------------------------------------------

function test538MagicLinkPage(): void {
  const s = src("app/auth/magic/[token]/page.tsx");
  assert(
    s.includes("window.location.assign") && s.includes("/api/proxy/auth/magic/"),
    "Magic link page must navigate to the consume endpoint through the same-origin proxy",
  );
  assert(
    !s.includes("consumeMagicLink") && !s.includes("fetchJson"),
    "Magic link page must not fetch the redirect endpoint as JSON",
  );
}

function test538ApiTsMagicLinkMethods(): void {
  const s = src("lib/api.ts");
  assert(
    s.includes("issueMagicLink") && s.includes("/auth/magic-link"),
    "api.ts must expose api.auth.issueMagicLink calling /auth/magic-link",
  );
  assert(
    s.includes("consumeMagicLink") && s.includes("/auth/magic/"),
    "api.ts must expose api.auth.consumeMagicLink calling /auth/magic/{token}",
  );
}

function test538MagicLinkMiddlewareExempt(): void {
  const s = api("main.py");
  // The consume endpoint is unauthenticated by definition — user has no session yet.
  // It must be in the auth middleware exempt list or the link is dead on arrival.
  assert(
    s.includes('path.startswith("/auth/magic/")'),
    "auth_middleware must exempt /auth/magic/* so unauthenticated users can consume the link",
  );
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tests: [string, () => void][] = [
  ["#562 connection setup action links directly to connect flow with return_to", test562MissingConnectionsDirectLink],
  ["#562 missing secrets banner includes return_to on secrets links", test562MissingSecretsDirectLink],
  ["#562 top-level Add secret link updated to /connections/secrets with return_to", test562TopLevelSecretLinkUpdated],
  ["#538 _issue_magic_link and _validate_magic_link helpers defined", test538MagicLinkIssuer],
  ["#538 _issue_magic_link uses HMAC-SHA256 signing", test538MagicLinkUsesHmac],
  ["#538 _magic_link_secret() uses dedicated key, not Slack secret", test538MagicLinkHasOwnSecret],
  ["#538 POST /auth/magic-link endpoint returns url + expires_in", test538MagicLinkEndpointIssue],
  ["#538 GET /auth/magic/{token} creates session and sets cookie", test538MagicLinkEndpointConsume],
  ["#538 Slack DM handler generates magic link for Emily's system context", test538SlackDmHandlerGeneratesMagicLink],
  ["#538 Slack DM handler passes system_suffix to workspace agent", test538SlackDmHandlerPassesSystemSuffix],
  ["#538 stream_chat accepts and applies system_suffix", test538StreamChatAcceptsSystemSuffix],
  ["#538 /auth/magic/[token] page consumes token and redirects", test538MagicLinkPage],
  ["#538 api.ts exposes issueMagicLink and consumeMagicLink", test538ApiTsMagicLinkMethods],
  ["#538 auth_middleware exempts /auth/magic/* for unauthenticated consume", test538MagicLinkMiddlewareExempt],
];

let passed = 0;
let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
    failed++;
  }
}

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
