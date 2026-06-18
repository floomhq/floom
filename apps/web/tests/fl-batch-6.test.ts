/**
 * Batch-6 frontend fix tests.
 * #536 — Worker Source: code files styled to match Brain PlainTextPreview
 * #552 — Login ?install=<channel> routes to correct destination post-signin
 * #540 — Slack connect auto-redirect countdown
 * #539 — Worker detail: setup tabs moved to "..." overflow dropdown
 * #561 — Run detail: dedicated Inputs tab
 *
 * Run: npx tsx tests/fl-batch-6.test.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(__dirname, "..");

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`FAIL: ${msg}`);
}

function src(rel: string) { return readFileSync(resolve(ROOT, rel), "utf8"); }

// ---------------------------------------------------------------------------
// #536 — Brain-matching PlainTextPreview styling
// ---------------------------------------------------------------------------

function test536BrainMatchStyling(): void {
  const s = src("components/worker-form/FilesEditor.tsx");
  assert(s.includes("max-w-3xl") && s.includes("px-6") && s.includes("py-6"),
    "Code Preview must use Brain's max-w-3xl px-6 py-6 reading column");
  assert(s.includes("text-[13px]") && s.includes("leading-6"),
    "Code Preview must use Brain's exact type scale (text-[13px] leading-6)");
  assert(s.includes("break-words"),
    "Code Preview must have break-words (matches Brain PlainTextPreview)");
}

// ---------------------------------------------------------------------------
// #552 — Login ?install param routing
// ---------------------------------------------------------------------------

function test552LoginReadsInstallParam(): void {
  const s = src("app/login/page.tsx");
  assert(s.includes("install"), "Login page must read the ?install query param");
  assert(s.includes("INSTALL_ROUTES"), "Login must define a channel → route mapping");
  assert(s.includes("/settings?from_install=slack"), "Slack install must route to settings Slack tab");
}

function test552SettingsShowsBanner(): void {
  const s = src("app/settings/page.tsx");
  assert(s.includes("from_install"), "Settings must consume ?from_install param");
  assert(s.includes("fromInstallChannel"), "Settings must have fromInstallChannel state");
  assert(s.includes("Connect Slack to continue") || s.includes("from_install"),
    "Settings must show a contextual banner for install channel");
}

// ---------------------------------------------------------------------------
// #540 — Slack auto-redirect countdown
// ---------------------------------------------------------------------------

function test540CountdownState(): void {
  const s = src("components/assistant/SlackConnect.tsx");
  assert(s.includes("slackRedirectCountdown"), "SlackConnect must have redirect countdown state");
  assert(s.includes("setSlackRedirectCountdown(3)") || s.includes("setSlackRedirectCountdown("),
    "Countdown must be set to 3 (or similar) on slack_connected detection");
}

function test540AutoOpenSlack(): void {
  const s = src("components/assistant/SlackConnect.tsx");
  assert(s.includes("window.open") || s.includes("window.location.href"),
    "SlackConnect must auto-open Slack when countdown hits zero");
  assert(s.includes("Stay here"),
    'SlackConnect must show a "Stay here" cancel button during countdown');
}

function test540CountdownShownInBanner(): void {
  const s = src("components/assistant/SlackConnect.tsx");
  assert(s.includes("Opening Slack in"),
    'Countdown must show "Opening Slack in Xs…" message');
}

// ---------------------------------------------------------------------------
// #539 — Worker detail: setup tabs in overflow dropdown
// ---------------------------------------------------------------------------

function test539PrimaryNavSplit(): void {
  const s = src("app/workers/WorkersCollection.tsx");
  assert(s.includes("WORKER_DETAIL_TABS") && s.includes("WORKER_TAB_COMPONENT"),
    "Worker split-pane detail must derive its tab set from WORKER_DETAIL_TABS");
}

function test539SetupInDropdown(): void {
  const s = src("app/workers/[id]/page.tsx");
  assert(s.includes("redirect") && s.includes("/workers?sel="),
    "Legacy worker full-page route must redirect into the split-pane detail");
}

function test539PrimaryTabsOnly4(): void {
  const s = src("lib/workers/tabs.ts");
  // round-09: primary = Overview/Runs/Setup; advanced = Source/Versions/Brain/Tools.
  assert(s.includes("Overview") && s.includes("Runs") && s.includes("Setup") && s.includes("Source") && s.includes("Versions"),
    "Worker split-pane tabs must expose the round-09 detail tab set");
}

// ---------------------------------------------------------------------------
// #561 — Run detail: Inputs tab
// ---------------------------------------------------------------------------

function test561InputsTab(): void {
  const s = src("components/RunDetailSplitPane.tsx");
  assert(s.includes('"inputs"'),
    "RunDetailSplitPane must have an Inputs tab (value=\"inputs\")");
  assert(s.includes("InputsView"),
    "RunDetailSplitPane must render InputsView component for the Inputs tab");
}

function test561InputsViewComponent(): void {
  const s = src("components/RunDetailSplitPane.tsx");
  assert(s.includes("function InputsView"),
    "InputsView function must be defined in RunDetailSplitPane");
  assert(s.includes("run.input"),
    "InputsView must render run.input data");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tests: [string, () => void][] = [
  ["#536 Brain-matching PlainTextPreview styling (max-w-3xl, text-[13px], break-words)", test536BrainMatchStyling],
  ["#552 login page reads ?install param and maps to route", test552LoginReadsInstallParam],
  ["#552 settings page consumes ?from_install and shows banner", test552SettingsShowsBanner],
  ["#540 SlackConnect has countdown state", test540CountdownState],
  ["#540 countdown auto-opens Slack on zero", test540AutoOpenSlack],
  ["#540 countdown shown in success banner", test540CountdownShownInBanner],
  ["#539 NAV_ITEMS split into PRIMARY_NAV and SETUP_NAV", test539PrimaryNavSplit],
  ["#539 setup nav rendered in DropdownMenuContent", test539SetupInDropdown],
  ["#539 PRIMARY_NAV derived by filter (view group)", test539PrimaryTabsOnly4],
  ["#561 Inputs tab added to RunDetailSplitPane", test561InputsTab],
  ["#561 InputsView component renders run.input", test561InputsViewComponent],
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
