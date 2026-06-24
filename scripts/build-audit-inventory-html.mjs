#!/usr/bin/env node
/** Generate static audit inventory HTML — no JS required to render issues. */
import { writeFileSync, mkdirSync, cpSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PERMANENT_URL = "https://workeros.floom.dev/audit";
const OUT_DIRS = [
  join(ROOT, "public/audit"),
  join(ROOT, "test-results/workeros-issue-inventory-2026-06-24"),
];

/** @typedef {{ id:string, sev:string, area:string, issue:string, detail?:string, status:string, owner:string, shot?:string, extraShots?:string[], ascii:string }} Issue */

const STATUS = {
  live: { label: "✓ LIVE", cls: "live" },
  partial: { label: "◐ PARTIAL", cls: "disk" },
  disk: { label: "~ DISK", cls: "disk" },
  open: { label: "! OPEN", cls: "open" },
  manual: { label: "? MANUAL", cls: "manual" },
  track: { label: "— TRACK", cls: "track" },
};

/** Deduped inventory — merged overlapping A/C/L/D rows (2026-06-24). */
const ISSUES = [
  {
    id: "A-01",
    sev: "P1",
    area: "Landing",
    issue: "Slack + WhatsApp kill-switch — hidden until flag on",
    detail:
      "NEXT_PUBLIC_LANDING_CHANNEL_SLACK/WHATSAPP default off. Landing hides Add to Slack / WhatsApp QR; /start/slack|whatsapp → 404 unless flag set at build time.",
    status: "live",
    owner: "cloud",
    shot: "07-localhost-landing-hero.png",
    extraShots: ["10-localhost-start-slack-disabled.png", "09-localhost-start-mcp.png"],
    ascii: `  INTENDED (now):              ACTUAL (landing):
  showSlack=false              [Add to Slack]  ← still visible
  showWhatsApp=false           [WhatsApp QR]   ← still visible
  /start/slack ──▶ 404 OK?     user clicks ──▶ 404 (confusing)

  FIX: NEXT_PUBLIC_CHANNELS slack/wa flag + hide ChannelActions`,
  },
  {
    id: "LOGIN-01",
    sev: "P1",
    area: "Login",
    issue: "/app/login ≠ landing /login — Hire pill + full #665 parity",
    detail:
      "Supersedes A-02, C-01, D-06. Overlay sync was restoring old split-panel; layout closer now but Hire was blue TEXT only (landing uses .v3-hl blue background pill). Fix on disk in web/overlay/app/login/page.tsx — NOT verified LIVE.",
    status: "partial",
    owner: "cloud",
    shot: "01-localhost-login-welcome-back.png",
    extraShots: ["01-prod-app-login-current.png", "08-localhost-landing-login-hire-pill.png"],
    ascii: `  landing /login                 /app/login (was)
  ┌──────────────────┐          ┌──────────────────┐
  │ [Hire] AI workers│          │ Hire AI workers  │
  │  ^blue pill      │          │  ^blue text only │
  │ V3Shell + Today  │          │ no V3Shell theme │
  └──────────────────┘          └──────────────────┘`,
  },
  {
    id: "MCP-01",
    sev: "P2",
    area: "MCP",
    issue: "6 real brand logos — icon-only row (sidebar popup + Settings)",
    detail:
      "Supersedes C-02, C-03, L-03, L-04, L-05. ONE component: McpInstallPanel (McpInstallModal wraps it). Want Claude Code, Cursor, Codex, VS Code, Windsurf, Cline as real logos — NOT grey boxes with letters “C”, “CX”. Same panel in left sidebar popup and Settings → Connect & automate → MCP.",
    status: "manual",
    owner: "engine",
    shot: "05-prod-mcp-install-panel.png",
    extraShots: ["16-mcp-sidebar-popup.png"],
    ascii: `  WANT (icon row):          NOT this (prod screenshot):
  [🟠claude][◻cursor][◻codex]   [C][CX][C][VS][W][CL]
  [◻vscode][◻surf][◻cline]       grey squares + initials

  Surfaces: sidebar MCP popup ═══ Settings MCP tab
            (same McpInstallPanel.tsx)`,
  },
  {
    id: "SETTINGS-01",
    sev: "P2",
    area: "Settings",
    issue: "List view default — not gallery grid",
    detail: "Supersedes C-06, L-12. emptyState('grid') + view default grid in settings/page.tsx.",
    status: "disk",
    owner: "engine",
    shot: "04-prod-settings-collection.png",
    ascii: `  WRONG (was):          RIGHT (fix):
  [⊞ grid pressed]      [≡ list pressed]
  ┌───┐ ┌───┐           │ General      │
  │   │ │   │           │ Slack & WA   │
  └───┘ └───┘           │ People       │`,
  },
  {
    id: "CONN-01",
    sev: "P1",
    area: "Connections",
    issue: "OAuth redirect loop + blank authorize + humanized names",
    detail: "Supersedes A-11, A-15, C-07, C-08, C-09, L-11. cancelledRef on unmount; Still waiting terminal; authorize proxy 302; Googlecalendar → Google Calendar.",
    status: "disk",
    owner: "engine+cloud",
    shot: "06-prod-connections-collection.png",
    ascii: `  connect ──▶ poll ──▶ navigate away
                    │
                    └──▶ stale tick ──▶ router.replace ✗

  /api/proxy/connections/authorize ──▶ was blank (need 302)

  [Googlecalendar] ──▶ [Google Calendar]`,
  },
  {
    id: "LIB-01",
    sev: "P1",
    area: "Library",
    issue: "Library tab empty / ~30s load",
    detail: "Supersedes A-12, L-06. hydrate=False when cached summary exists.",
    status: "disk",
    owner: "engine",
    shot: "11-prod-library-contexts.png",
    ascii: `  GET /contexts ──▶ for EACH pack:
                         download ALL files from Storage
                         just for file_count  ──▶ ~30s`,
  },
  {
    id: "A-03",
    sev: "P2",
    area: "CI",
    issue: "smoke-routes.sh false-pass on macOS",
    detail: "sha256sum missing → empty hash always matched",
    status: "live",
    owner: "cloud",
    shot: "",
    ascii: `  macOS: sha256sum ──X──▶ (missing)
         hash="" == hash="" ──▶ FALSE PASS ✓
  FIX: shasum -a 256 fallback`,
  },
  {
    id: "A-04",
    sev: "P2",
    area: "Tests",
    issue: "Web vitest harness failures (#436)",
    status: "track",
    owner: "cloud+engine",
    shot: "",
    ascii: `  vitest ──▶ 760 pass / 25 fail
  proxy-location (7) · login-magic-link (4) · overlay (2)`,
  },
  {
    id: "A-06",
    sev: "P2",
    area: "CLI",
    issue: "workers push stale bundle (#637)",
    status: "track",
    owner: "engine",
    shot: "",
    ascii: `  local edit ──▶ push ──▶ cloud API ──▶ OLD bundle cached`,
  },
  {
    id: "A-07",
    sev: "P2",
    area: "CLI",
    issue: "Device-approval dead-end (#588)",
    status: "track",
    owner: "cloud",
    shot: "21-prod-cli-auth.png",
    ascii: `  cli-auth ──▶ no session ──▶ dead end (need login?next=)`,
  },
  {
    id: "A-10",
    sev: "P3",
    area: "Workers",
    issue: "ASCII diagram worker node accent blue",
    status: "disk",
    owner: "engine",
    shot: "15-prod-worker-overview.png",
    ascii: `  [trigger]──▶[WORKER]──▶[output]  was BLUE → fix --ink`,
  },
  {
    id: "A-13",
    sev: "P1",
    area: "Workers",
    issue: "Memory scope toggle silent no-op",
    status: "disk",
    owner: "engine",
    shot: "17-prod-worker-library-tab-brain-label.png",
    ascii: `  Read ◀──toggle──▶ Read&write
  PUT /workers/files ──▶ validator force writeable:True
  toast "Brain updated" (lie)`,
  },
  {
    id: "A-14",
    sev: "P2",
    area: "Workers",
    issue: "Tab Brain vs nav Library label mismatch",
    status: "disk",
    owner: "engine",
    shot: "17-prod-worker-library-tab-brain-label.png",
    ascii: `  left nav: Library    worker tab: Brain  ✗`,
  },
  {
    id: "EMILY-01",
    sev: "P2",
    area: "Emily",
    issue: "Home empty state — composer, grey bg, tool UX, inline chips",
    detail: "Supersedes C-04, L-01, L-02, L-10, L-15.",
    status: "disk",
    owner: "engine",
    shot: "03-prod-workers-collection.png",
    extraShots: ["12-prod-assistant-emily.png"],
    ascii: `  /app/assistant
  ┌─────────────────────────────┐
  │ real PromptInput + chips    │
  │ Uses: [Gmail][Calendar]     │
  │ warm --bg-app (not grey)    │
  │ "Searching connections…"    │
  └─────────────────────────────┘`,
  },
  {
    id: "UI-01",
    sev: "P2",
    area: "UI",
    issue: "Squircle avatars + send button + collection control strip",
    detail: "Supersedes C-05, C-10, C-11.",
    status: "manual",
    owner: "engine",
    shot: "03-prod-workers-collection.png",
    ascii: `  Workers: [🔍][≡|⊞][+ Add][New worker]
  avatar (○) → (▢)   composer send (○) → (▢)`,
  },
  {
    id: "AUTH-01",
    sev: "P2",
    area: "Auth",
    issue: "Localhost OAuth recipe + session switch",
    detail: "Supersedes C-12, L-07, D-01.",
    status: "live",
    owner: "cloud",
    shot: "20-prod-login-switch-signin.png",
    ascii: `  npm run dev:local + ops/dev-local-api.sh
  callback: localhost:3000/app/api/proxy/auth/callback
  /app/login?switch=1 ──▶ Google account chooser`,
  },
  {
    id: "L-09",
    sev: "P2",
    area: "Approvals",
    issue: "Proposed output layout",
    status: "disk",
    owner: "engine",
    shot: "13-prod-approvals.png",
    ascii: `  approval detail ──▶ proposed output container queries`,
  },
  {
    id: "L-13",
    sev: "P2",
    area: "Settings",
    issue: "Backups / version history",
    status: "manual",
    owner: "engine",
    shot: "14-prod-settings-backups.png",
    ascii: `  Settings → Backups → restore points list`,
  },
  {
    id: "L-14",
    sev: "P2",
    area: "Runs",
    issue: "?shape=run lightweight load",
    status: "disk",
    owner: "engine",
    shot: "23-prod-worker-runs-tab.png",
    extraShots: ["18-prod-runs-list.png"],
    ascii: `  /app/run/id?shape=run ──▶ skip heavy payload`,
  },
  {
    id: "D-04",
    sev: "P1",
    area: "Deploy",
    issue: "Vercel CI + /audit permanent URL",
    detail: "Dashboard build fixes landed; landing apex /v3/integrations 404 blocks alias; workeros.floom.dev/audit still pending.",
    status: "open",
    owner: "cloud",
    shot: "22-prod-audit-page.png",
    ascii: `  vercel deploy ──▶ landing job
  /v3/integrations 404 ──▶ alias blocked
  /audit ──▶ 404 until landing ships public/audit`,
  },
  {
    id: "D-07",
    sev: "P2",
    area: "Deploy",
    issue: "Railway smoke gate after push main",
    status: "manual",
    owner: "cloud",
    shot: "",
    ascii: `  push main ──▶ railway up ──▶ ops/smoke-routes.sh`,
  },
  {
    id: "INFRA-01",
    sev: "P3",
    area: "Tests",
    issue: "E2E + pytest blocked on audit machine",
    detail: "Supersedes A-08, A-09.",
    status: "track",
    owner: "infra",
    shot: "",
    ascii: `  playwright: WORKEROS_E2E_ADMIN_TOKEN unset
  pytest: disk full + py3.14 litellm (repo wants py3.12)`,
  },
];

function esc(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function shotHtml(row) {
  const files = [row.shot, ...(row.extraShots ?? [])].filter(Boolean);
  if (!files.length) {
    return `<div class="shot-empty">No screenshot yet — <code>${esc(row.id)}</code></div>`;
  }
  return files
    .map((file) => {
      const src = `/audit/screenshots/${file}`;
      return `<figure class="shot"><a href="${esc(src)}"><img src="${esc(src)}" alt="${esc(row.id)}" loading="lazy"/></a><figcaption>${esc(file)}</figcaption></figure>`;
    })
    .join("\n");
}

function issueCard(row) {
  const st = STATUS[row.status];
  return `<article class="issue" id="${esc(row.id)}" data-status="${esc(row.status)}" data-sev="${esc(row.sev)}">
  <header class="issue-head">
    <span class="id">${esc(row.id)}</span>
    <span class="badge ${esc(row.sev.toLowerCase())}">${esc(row.sev)}</span>
    <span class="badge ${esc(st.cls)}">${esc(st.label)}</span>
    <span class="area">${esc(row.area)}</span>
    <span class="owner">${esc(row.owner)}</span>
  </header>
  <h2>${esc(row.issue)}</h2>
  ${row.detail ? `<p class="detail">${esc(row.detail)}</p>` : ""}
  <pre class="ascii">${esc(row.ascii)}</pre>
  ${shotHtml(row)}
</article>`;
}

const counts = { live:0, partial:0, disk:0, open:0, manual:0, track:0 };
ISSUES.forEach(i => counts[i.status]++);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>WorkerOS Cloud Audit — Issue Inventory</title>
<style>
:root{--bg:#f4f2ef;--paper:#fff;--ink:#141518;--muted:#6b6560;--line:#ddd9d2;--accent:#3e6fe0;
--ok:#1a7f4b;--ok-bg:#e8f5ee;--warn:#b45309;--warn-bg:#fff4e5;--bad:#b42318;--bad-bg:#fdecea;
--open:#7c3aed;--open-bg:#f3eeff;--code:#eceae6;--mono:ui-monospace,Menlo,Consolas,monospace;--sans:system-ui,sans-serif}
*{box-sizing:border-box}body{margin:0;font-family:var(--sans);background:var(--bg);color:var(--ink);font-size:15px;line-height:1.5}
a{color:var(--accent)}code{background:var(--code);padding:.1em .35em;border-radius:4px;font-size:.88em;font-family:var(--mono)}
header.top{background:var(--paper);border-bottom:1px solid var(--line);padding:1.5rem}
header.top h1{margin:0 0 .35rem;font-size:1.4rem}
.meta{color:var(--muted);font-size:.9rem}
.perm{margin-top:.75rem;padding:.75rem 1rem;background:#eef6ff;border:1px solid #93c5fd;border-radius:8px;font-size:.9rem}
.stats{display:flex;flex-wrap:wrap;gap:.5rem;margin:1rem 0}
.stats span{font-size:.78rem;padding:.25rem .55rem;border-radius:6px;background:var(--code)}
nav.toc{position:sticky;top:0;z-index:5;background:rgba(244,242,239,.95);backdrop-filter:blur(6px);border-bottom:1px solid var(--line);padding:.5rem 1rem;display:flex;flex-wrap:wrap;gap:.35rem;font-size:.75rem;max-height:120px;overflow-y:auto}
nav.toc a{color:var(--muted);text-decoration:none;padding:.15rem .4rem;border-radius:4px}
nav.toc a:hover{background:var(--code);color:var(--ink)}
main{max-width:920px;margin:0 auto;padding:1rem 1rem 3rem}
.issue{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:1rem 1.15rem;margin-bottom:1rem}
.issue.hidden{display:none}
.issue-head{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem;margin-bottom:.35rem}
.issue h2{margin:.25rem 0;font-size:1.05rem;font-weight:600}
.id{font-family:var(--mono);font-weight:700;font-size:.9rem}
.area,.owner{font-size:.75rem;color:var(--muted)}
.badge{font-size:.65rem;font-weight:700;text-transform:uppercase;padding:.12rem .4rem;border-radius:4px}
.badge.p1{background:var(--bad-bg);color:var(--bad)}.badge.p2{background:var(--warn-bg);color:var(--warn)}.badge.p3{background:var(--code);color:var(--muted)}
.badge.live{background:var(--ok-bg);color:var(--ok)}.badge.disk{background:#e8f0fe;color:var(--accent)}
.badge.open{background:var(--open-bg);color:var(--open)}.badge.manual{background:var(--warn-bg);color:var(--warn)}.badge.track{background:var(--code);color:var(--muted)}
.detail{color:var(--muted);font-size:.88rem;margin:.25rem 0 .5rem}
pre.ascii{font-family:var(--mono);font-size:11px;line-height:1.35;background:#1a1a1e;color:#e8e6e1;padding:.85rem 1rem;border-radius:8px;overflow-x:auto;white-space:pre;margin:.65rem 0}
.shot{margin:.5rem 0 0}.shot img{max-width:100%;width:480px;border-radius:8px;border:1px solid var(--line);cursor:zoom-in}
.shot figcaption{font-size:.72rem;color:var(--muted);margin-top:.25rem}
.shot-empty{border:2px dashed var(--line);border-radius:8px;padding:1.5rem;text-align:center;color:var(--muted);font-size:.82rem}
.toolbar{display:flex;flex-wrap:wrap;gap:.5rem;padding:.5rem 1rem;background:var(--paper);border-bottom:1px solid var(--line)}
.toolbar input,.toolbar select{font:inherit;padding:.35rem .5rem;border:1px solid var(--line);border-radius:6px}
.lightbox{display:none;position:fixed;inset:0;z-index:99;background:rgba(0,0,0,.88);align-items:center;justify-content:center;cursor:zoom-out}
.lightbox.open{display:flex}.lightbox img{max-width:96vw;max-height:96vh;border-radius:8px}
footer{text-align:center;color:var(--muted);font-size:.8rem;padding:2rem}
</style>
</head>
<body>
<header class="top">
  <h1>WorkerOS Cloud — Issue inventory</h1>
  <p class="meta">${ISSUES.length} items (deduped from 47) · cloud main · 2026-06-24 · for Vivek</p>
  <p class="meta" style="margin-top:.35rem">Merged duplicates: LOGIN-01 ← A-02/C-01/D-06 · MCP-01 ← C-02/C-03/L-03 · CONN-01 ← A-11/A-15/C-07–09 · SETTINGS-01 ← C-06/L-12 · LIB-01 ← A-12/L-06 · EMILY-01 ← C-04/L-01/L-10/L-15</p>
  <div class="perm"><strong>Permanent URL:</strong> <a href="${PERMANENT_URL}">${PERMANENT_URL}</a></div>
  <div class="stats">
    <span>✓ LIVE ${counts.live}</span><span>◐ PARTIAL ${counts.partial}</span><span>~ DISK ${counts.disk}</span><span>! OPEN ${counts.open}</span>
    <span>? MANUAL ${counts.manual}</span><span>— TRACK ${counts.track}</span>
  </div>
</header>
<div class="toolbar">
  <label>Search <input type="search" id="q" placeholder="id, area, issue…"/></label>
  <label>Status <select id="sf"><option value="">All</option><option value="live">LIVE</option><option value="partial">PARTIAL</option><option value="disk">DISK</option><option value="open">OPEN</option><option value="manual">MANUAL</option><option value="track">TRACK</option></select></label>
  <label>Sev <select id="vf"><option value="">All</option><option>P1</option><option>P2</option><option>P3</option></select></label>
  <span id="cnt" style="margin-left:auto;font-size:.8rem;color:var(--muted)"></span>
</div>
<nav class="toc">${ISSUES.map(i => `<a href="#${i.id}">${i.id}</a>`).join("")}</nav>
<main id="main">
${ISSUES.map(issueCard).join("\n")}
</main>
<div class="lightbox" id="lb"><img alt=""/></div>
<footer>Rebuild: <code>node scripts/build-audit-inventory-html.mjs</code> · Screenshots in <code>public/audit/screenshots/</code></footer>
<script>
(function(){
  const issues=document.querySelectorAll(".issue"),q=document.getElementById("q"),sf=document.getElementById("sf"),vf=document.getElementById("vf"),cnt=document.getElementById("cnt");
  function filt(){
    const t=(q.value||"").toLowerCase(),s=sf.value,v=vf.value;let n=0;
    issues.forEach(el=>{const ok=(!t||el.textContent.toLowerCase().includes(t))&&(!s||el.dataset.status===s)&&(!v||el.dataset.sev===v);
      el.classList.toggle("hidden",!ok);if(ok)n++;});
    cnt.textContent=n+" / ${ISSUES.length} shown";
  }
  q.oninput=sf.onchange=vf.onchange=filt;filt();
  const lb=document.getElementById("lb"),img=lb.querySelector("img");
  document.body.addEventListener("click",e=>{if(e.target.matches(".shot img")){img.src=e.target.src;lb.classList.add("open");}
    if(e.target===lb)lb.classList.remove("open");});
})();
</script>
</body>
</html>`;

const primaryOut = join(ROOT, "public/audit");
const shotDir = join(primaryOut, "screenshots");
mkdirSync(shotDir, { recursive: true });
writeFileSync(join(primaryOut, "index.html"), html);
const pngFiles = readdirSync(shotDir).filter((f) => f.endsWith(".png"));
console.log("wrote", join(primaryOut, "index.html"), `(${pngFiles.length} screenshots)`);

for (const dir of OUT_DIRS.filter((d) => d !== primaryOut)) {
  mkdirSync(join(dir, "screenshots"), { recursive: true });
  writeFileSync(join(dir, "index.html"), html);
  for (const f of pngFiles) {
    cpSync(join(shotDir, f), join(dir, "screenshots", f), { force: true });
  }
  console.log("wrote", join(dir, "index.html"));
}
console.log("Permanent URL when landing deploys:", PERMANENT_URL);
