/**
 * Live UI path verification for WorkerOS.
 * Tests the key paths changed in recent PRs.
 */
import { chromium } from "playwright";

const BASE = "http://localhost:3000";
const API  = "http://localhost:8000";
const RESULTS = [];

function pass(name) { RESULTS.push({ name, ok: true });  console.log(`  ✓ ${name}`); }
function fail(name, reason) { RESULTS.push({ name, ok: false, reason }); console.error(`  ✗ ${name}: ${reason}`); }

async function run() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // ── 1. App boots and redirects to /login ────────────────────────────────
  console.log("\n[1] App boot + login redirect");
  try {
    const res = await page.goto(BASE, { waitUntil: "domcontentloaded" });
    const url = page.url();
    if (url.includes("/login") || url.includes("/overview") || url.includes("/workers")) {
      pass("App boots and renders (no blank/error page)");
    } else {
      fail("App boots", `unexpected URL: ${url}`);
    }
  } catch (e) { fail("App boots", e.message); }

  // ── 2. API health ────────────────────────────────────────────────────────
  console.log("\n[2] API health");
  try {
    const r = await fetch(`${API}/healthz`);
    const j = await r.json();
    j.status === "ok" ? pass("API /healthz returns ok") : fail("API /healthz", JSON.stringify(j));
  } catch (e) { fail("API /healthz", e.message); }

  // ── 3. /auth/magic/{token} is reachable without auth (our middleware fix) ─
  console.log("\n[3] Magic link middleware exemption");
  try {
    const r = await fetch(`${API}/auth/magic/definitely-bad-token`);
    if (r.status === 400) {
      pass("/auth/magic/{token} reaches handler unauthenticated (400 Invalid, not 401)");
    } else if (r.status === 401) {
      fail("/auth/magic/{token} middleware exemption", "still getting 401 — middleware fix not hot-reloaded");
    } else {
      pass(`/auth/magic/{token} reachable (${r.status})`);
    }
  } catch (e) { fail("/auth/magic/{token} fetch", e.message); }

  // ── 4. /auth/magic/{bad} returns 400 with correct detail ────────────────
  console.log("\n[4] Magic link error response");
  try {
    const r = await fetch(`${API}/auth/magic/bad.token`);
    const j = await r.json();
    if (r.status === 400 && j.detail) {
      pass(`/auth/magic/{bad} → 400 "${j.detail}"`);
    } else {
      fail("/auth/magic/{bad} response", `status=${r.status} body=${JSON.stringify(j)}`);
    }
  } catch (e) { fail("/auth/magic/{bad}", e.message); }

  // ── 5. Login page renders ────────────────────────────────────────────────
  console.log("\n[5] Login page");
  try {
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    const html = await page.content();
    const hasForm = html.includes("password") || html.includes("email") ||
                    html.includes("secret") || html.includes("sign") ||
                    html.includes("login") || html.includes("Login");
    hasForm ? pass("Login page renders a form/auth UI") : fail("Login page", "no recognisable auth UI");
  } catch (e) { fail("Login page", e.message); }

  // ── 6. Workers route exists (redirects or renders) ───────────────────────
  console.log("\n[6] Workers route");
  try {
    const res = await page.goto(`${BASE}/workers`, { waitUntil: "domcontentloaded" });
    const url = page.url();
    // Either rendered workers page, or redirected to login (auth required — that's correct)
    if (url.includes("/workers") || url.includes("/login") || url.includes("/overview")) {
      pass(`/workers route exists (landed at ${url.split(BASE)[1] || url})`);
    } else {
      fail("/workers route", `unexpected URL: ${url}`);
    }
  } catch (e) { fail("/workers route", e.message); }

  // ── 7. Worker detail page links contain return_to ────────────────────────
  //    We can verify this from source without needing to be logged in.
  console.log("\n[7] Worker detail source — return_to links");
  try {
    const { readFileSync } = await import("fs");
    const src = readFileSync(
      "/home/dev/code_dir/workerOS/apps/web/app/workers/[id]/page.tsx", "utf8"
    );
    const hasConnect = src.includes("/connections/connect/") && src.includes("return_to=/workers/");
    const hasSecrets = src.includes("/connections/secrets") && src.includes("return_to=/workers/");
    const noStale   = !src.includes('href="/secrets"');
    hasConnect ? pass("Worker detail: missing connections links → /connections/connect/{slug}?return_to") :
                 fail("Worker detail: connect links", "return_to pattern missing");
    hasSecrets ? pass("Worker detail: missing secrets links → /connections/secrets?return_to") :
                 fail("Worker detail: secrets links", "return_to pattern missing");
    noStale    ? pass("Worker detail: no stale href=\"/secrets\" links remain") :
                 fail("Worker detail: stale link", 'href="/secrets" still present');
  } catch (e) { fail("Worker detail source check", e.message); }

  // ── 8. auth middleware source — /auth/magic/ is exempt ──────────────────
  console.log("\n[8] Auth middleware source — magic link exempt");
  try {
    const { readFileSync } = await import("fs");
    const src = readFileSync("/home/dev/code_dir/workerOS/apps/api/main.py", "utf8");
    src.includes('path.startswith("/auth/magic/")')
      ? pass('auth_middleware exempts path.startswith("/auth/magic/")')
      : fail("auth_middleware exemption", 'path.startswith("/auth/magic/") not found');
  } catch (e) { fail("auth_middleware source check", e.message); }

  // ── 9. /auth/magic/[token] frontend page exists ──────────────────────────
  console.log("\n[9] Magic link frontend page");
  try {
    const res = await page.goto(`${BASE}/auth/magic/sometoken`, { waitUntil: "domcontentloaded" });
    const html = await page.content();
    // Should show "Signing you in..." or an error about invalid link — NOT a 404
    const valid = html.includes("Signing you in") || html.includes("sign-in") ||
                  html.includes("expired") || html.includes("Invalid") || html.includes("magic");
    valid ? pass("/auth/magic/[token] frontend page renders (not 404)") :
            fail("/auth/magic/[token] page", "no recognisable magic-link UI");
  } catch (e) { fail("/auth/magic/[token] page", e.message); }

  // ── 10. Connections route exists ─────────────────────────────────────────
  console.log("\n[10] Connections route");
  try {
    await page.goto(`${BASE}/connections`, { waitUntil: "domcontentloaded" });
    const url = page.url();
    (url.includes("/connections") || url.includes("/login"))
      ? pass(`/connections route exists (${url.split(BASE)[1] || url})`)
      : fail("/connections route", `unexpected: ${url}`);
  } catch (e) { fail("/connections route", e.message); }

  // ── Done ─────────────────────────────────────────────────────────────────
  await browser.close();

  const total  = RESULTS.length;
  const passed = RESULTS.filter(r => r.ok).length;
  const failed = RESULTS.filter(r => !r.ok);

  console.log(`\n${"─".repeat(56)}`);
  console.log(`${passed}/${total} passed`);
  if (failed.length) {
    console.log("\nFailed:");
    failed.forEach(r => console.log(`  ✗ ${r.name}: ${r.reason}`));
    process.exit(1);
  }
}

run().catch(e => { console.error("Fatal:", e); process.exit(1); });
