#!/usr/bin/env node
/** Generate static audit inventory HTML — no JS required to render issues. */
import { writeFileSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PERMANENT_URL = "https://workeros.floom.dev/audit";
const OUT_DIRS = [
  join(ROOT, "public/audit"),
  join(ROOT, "test-results/workeros-issue-inventory-2026-06-24"),
];

const SHOTS = {
  "C-01": "01-localhost-login-welcome-back.png",
  "C-02": "05-prod-mcp-install-panel.png",
  "C-05": "03-prod-workers-collection.png",
  "C-06": "04-prod-settings-collection.png",
  "C-07": "06-prod-connections-collection.png",
};

const STATUS = {
  live: { label: "✓ LIVE", cls: "live" },
  disk: { label: "~ DISK", cls: "disk" },
  open: { label: "! OPEN", cls: "open" },
  manual: { label: "? MANUAL", cls: "manual" },
  track: { label: "— TRACK", cls: "track" },
};

const ISSUES = [
  { id:"A-01", sev:"P1", area:"Landing", issue:"/start/slack + /start/whatsapp return 404", detail:"CHANNELS dict lost slack/whatsapp; code restored, prod not deployed", status:"open", owner:"cloud", shot:"",
    ascii:`  /start/slack  ──▶  workeros.floom.dev
                           │
                           ▼
                    ┌──────────────┐
                    │  404 Nothing │  ◀── CHANNELS = { mcp only }
                    │     here     │
                    └──────────────┘
  FIX: restore slack+whatsapp in app/start/[channel]/page.tsx` },
  { id:"A-02", sev:"P1", area:"Login", issue:"Dashboard /app/login — old UI not landing #665", detail:"Overlay sync restored old split-panel after every npm run sync", status:"live", owner:"cloud", shot:"C-01",
    ascii:`  OLD (overlay)              NEW (landing #665)
  ┌─────────────────┐        ┌─────────────────┐
  │ Floom Cloud     │        │ Hire AI workers.│
  │ Recent runs LR  │        │ Today + squircles│
  │ Welcome back L  │        │ Welcome back C  │
  └─────────────────┘        └─────────────────┘` },
  { id:"A-03", sev:"P2", area:"CI", issue:"smoke-routes.sh false-pass on macOS", detail:"sha256sum missing → empty hash always matched", status:"live", owner:"cloud", shot:"",
    ascii:`  macOS: sha256sum ──X──▶ (missing)
              │
              ▼
         hash=""  ==  hash=""  ──▶ FALSE PASS ✓
  FIX: sha256_of() → shasum -a 256 fallback` },
  { id:"A-04", sev:"P2", area:"Tests", issue:"Web vitest 25 failures (#436)", detail:"Many Next 16 cookies() outside request scope in harness", status:"track", owner:"cloud+engine", shot:"",
    ascii:`  vitest ──▶ 760 pass / 25 fail
              │
              ├─ proxy-location (7)   cookies() harness
              ├─ login-magic-link (4) async RSC jsdom
              └─ overlay parity (2)   env drift` },
  { id:"A-05", sev:"P2", area:"Tests", issue:"Landing start-channel-819 failures", detail:"Fixed with A-01 — now 16/16", status:"live", owner:"cloud", shot:"",
    ascii:`  start-channel-819.dom.test.tsx
  slack ✓  whatsapp ✓  mcp ✓  (was 8 fail → 0)` },
  { id:"A-06", sev:"P2", area:"CLI", issue:"workers push stale bundle (#637)", status:"track", owner:"engine", shot:"",
    ascii:`  local edit ──▶ push ──▶ cloud API
                              │
                              ▼
                         OLD bundle cached` },
  { id:"A-07", sev:"P2", area:"CLI", issue:"Device-approval dead-end (#588)", status:"track", owner:"cloud", shot:"",
    ascii:`  cli-auth page ──▶ no session ──▶ dead end
  (should redirect to login with next=)` },
  { id:"A-08", sev:"P3", area:"E2E", issue:"Playwright blocked — no E2E token", status:"track", owner:"cloud", shot:"",
    ascii:`  playwright ──X── WORKEROS_E2E_ADMIN_TOKEN unset` },
  { id:"A-09", sev:"P3", area:"Tests", issue:"Pytest blocked on audit machine", status:"track", owner:"infra", shot:"",
    ascii:`  pytest ──X── disk full + py3.14 litellm conflict
  (repo wants py3.12)` },
  { id:"A-10", sev:"P3", area:"Workers", issue:"ASCII diagram worker node accent blue", status:"disk", owner:"engine", shot:"",
    ascii:`  [trigger]──▶[WORKER]──▶[output]
                  │
              was BLUE (--accent)
              fix: --ink (neutral)` },
  { id:"A-11", sev:"P2", area:"Connections", issue:"Composio spinner + rogue nav + provider name", status:"disk", owner:"engine", shot:"",
    ascii:`  connect ──▶ poll ──▶ user navigates away
                    │
                    └──▶ stale tick ──▶ router.replace(back!)  ✗
  FIX: cancelledRef + timeout phase + displayName map` },
  { id:"A-12", sev:"P1", area:"Library", issue:"Library tab ~30s load", status:"disk", owner:"engine", shot:"",
    ascii:`  GET /contexts ──▶ for EACH pack:
                         download ALL files from Storage
                         just for file_count  ──▶ ~30s
  FIX: hydrate=False when cached summary exists` },
  { id:"A-13", sev:"P1", area:"Workers", issue:"Memory scope toggle silent no-op", status:"disk", owner:"engine", shot:"",
    ascii:`  UI: Read ◀──toggle──▶ Read&write
           │
           ▼ PUT /workers/files
  engine validator force-pins writeable:True
           │
           ▼ toast "Brain updated" (lie)` },
  { id:"A-14", sev:"P2", area:"Workers", issue:"Tab Brain vs nav Library", status:"disk", owner:"engine", shot:"",
    ascii:`  left nav: Library    worker tab: Brain  ✗
  FIX: WORKER_DETAIL_TAB_LABEL Brain→Library` },
  { id:"A-15", sev:"P1", area:"Connections", issue:"Authorize proxy route blank page", status:"disk", owner:"cloud", shot:"",
    ascii:`  /app/api/proxy/connections/authorize/JWT
           │
           ▼ should 302 ──▶ connect.composio.dev
           │
           ▼ was: blank white page` },

  { id:"C-01", sev:"P1", area:"Login", issue:"Landing-aligned login on /app/login", status:"live", owner:"cloud", shot:"C-01",
    ascii:`  localhost:3000/app/login
  ┌──────────────┬──────────────┐
  │ Hire AI      │ Welcome back │
  │ workers.     │ OAuth + magic│
  │ Today card   │ link panel   │
  └──────────────┴──────────────┘` },
  { id:"C-02", sev:"P2", area:"Settings", issue:"MCP install panel — 6 client icons", status:"manual", owner:"engine", shot:"C-02",
    ascii:`  Settings → Connect → MCP
  [Claude][Cursor][Cline][Codex][Windsurf][Gemini]
       6 icons in a row` },
  { id:"C-03", sev:"P2", area:"Settings", issue:"MCP config API host", status:"manual", owner:"engine", shot:"C-02",
    ascii:`  MCP JSON config:
  "url": "https://workeros-api.floom.dev/..."
  (not localhost:8000 on prod)` },
  { id:"C-04", sev:"P2", area:"Emily", issue:"Home empty — real PromptInput", status:"disk", owner:"engine", shot:"",
    ascii:`  /app/assistant empty state
  ┌─────────────────────────────┐
  │  real composer (not stub)   │
  │  [Uses: tool chips]  [send] │
  └─────────────────────────────┘` },
  { id:"C-05", sev:"P2", area:"Workers", issue:"Collection control strip", status:"manual", owner:"engine", shot:"C-05",
    ascii:`  Workers
  [🔍 search] [≡ list|⊞ grid] [+ Add] [New worker]
  ─────────────────────────────────────────────` },
  { id:"C-06", sev:"P2", area:"Settings", issue:"List view default NOT gallery", status:"disk", owner:"engine", shot:"C-06",
    ascii:`  WRONG (was):          RIGHT (fix):
  [⊞ grid pressed]      [≡ list pressed]
  ┌───┐ ┌───┐           │ General      │
  │   │ │   │           │ Slack & WA   │
  └───┘ └───┘           │ People       │` },
  { id:"C-07", sev:"P2", area:"Connections", issue:"Collection + humanized names", status:"disk", owner:"engine", shot:"C-07",
    ascii:`  Connections list
  [GitHub]  octocat     active
  [Google Calendar]  ✓  (not Googlecalendar)` },
  { id:"C-08", sev:"P2", area:"Connections", issue:"Redirect — no stale router.replace", status:"live", owner:"engine", shot:"",
    ascii:`  poll tick ──▶ unmount ──▶ cancelledRef=true
                         └──▶ bail (no navigate back)` },
  { id:"C-09", sev:"P2", area:"Connections", issue:"Redirect — Still waiting terminal", status:"manual", owner:"engine", shot:"",
    ascii:`  spinner ──▶ 2min ──▶ [Still waiting for Google Calendar]
              [Check again] [Go to connections]` },
  { id:"C-10", sev:"P2", area:"UI", issue:"Avatar squircle not circle", status:"disk", owner:"engine", shot:"",
    ascii:`  was (○) circle     want (▢) squircle
       federico@          federico@` },
  { id:"C-11", sev:"P2", area:"Emily", issue:"Send button squircle", status:"disk", owner:"engine", shot:"",
    ascii:`  composer [············ (○) ]  →  [············ (▢) ]` },
  { id:"C-12", sev:"P2", area:"Auth", issue:"Localhost Gmail OAuth callback", status:"live", owner:"cloud", shot:"",
    ascii:`  dev:local ──▶ callback:
  localhost:3000/app/api/proxy/auth/callback
  COOKIE_DOMAIN=none` },
  { id:"C-13", sev:"P1", area:"Landing", issue:"/start/slack + whatsapp on prod", status:"open", owner:"cloud", shot:"",
    ascii:`  same as A-01 — code on main, landing deploy pending` },

  { id:"L-01", sev:"P2", area:"Emily", issue:"Grey bg on empty state", status:"disk", owner:"engine", shot:"",
    ascii:`  --bg-app (warm)  vs  grey #eee leak on Emily home` },
  { id:"L-02", sev:"P3", area:"Emily", issue:"Greeting typography", status:"manual", owner:"engine", shot:"",
    ascii:`  "Good morning" — size/weight off spec` },
  { id:"L-03", sev:"P2", area:"MCP", issue:"Client logos IconSprite", status:"disk", owner:"engine", shot:"C-02",
    ascii:`  icon-claude  icon-codex  icon-cline … in IconSprite.tsx` },
  { id:"L-04", sev:"P2", area:"MCP", issue:"Create key flow", status:"manual", owner:"engine", shot:"",
    ascii:`  [Create access key] ──▶ PAT panel ──▶ copy/reveal` },
  { id:"L-05", sev:"P2", area:"MCP", issue:"localhost:8000 in prod copy", status:"manual", owner:"engine", shot:"",
    ascii:`  MCP install snippet must show workeros-api.floom.dev` },
  { id:"L-06", sev:"P1", area:"Library", issue:"Empty / slow load", status:"disk", owner:"engine", shot:"",
    ascii:`  same as A-12 — Storage hydration on list` },
  { id:"L-07", sev:"P2", area:"Auth", issue:"Session switch Google picker", status:"disk", owner:"cloud", shot:"",
    ascii:`  /app/login?switch=1 ──▶ Google account chooser` },
  { id:"L-08", sev:"P3", area:"Collections", issue:"List toggle left of grid", status:"live", owner:"engine", shot:"",
    ascii:`  view bar:  [ ≡ list ] [ ⊞ grid ]
              ^left       ^right` },
  { id:"L-09", sev:"P2", area:"Approvals", issue:"Proposed output layout", status:"disk", owner:"engine", shot:"",
    ascii:`  approval detail ──▶ proposed output container queries` },
  { id:"L-10", sev:"P2", area:"Emily", issue:"Tool-call in-progress UX", status:"disk", owner:"engine", shot:"",
    ascii:`  Emily: "Searching connections…" status line during tool` },
  { id:"L-11", sev:"P1", area:"Connections", issue:"Blank authorize page", status:"disk", owner:"cloud", shot:"",
    ascii:`  same as A-15` },
  { id:"L-12", sev:"P2", area:"Settings", issue:"Gallery default", status:"disk", owner:"engine", shot:"C-06",
    ascii:`  same as C-06 — emptyState("grid") bug` },
  { id:"L-13", sev:"P2", area:"Settings", issue:"Backups / version history", status:"manual", owner:"engine", shot:"",
    ascii:`  Settings → Backups → restore points list` },
  { id:"L-14", sev:"P2", area:"Runs", issue:"?shape=run lightweight load", status:"disk", owner:"engine", shot:"",
    ascii:`  /app/run/id?shape=run ──▶ skip heavy payload` },
  { id:"L-15", sev:"P2", area:"Emily", issue:"Inline tool tokens Uses:", status:"disk", owner:"engine", shot:"",
    ascii:`  prompt: "Uses: [Gmail] [Calendar] [GitHub]" inline chips` },

  { id:"D-01", sev:"P2", area:"Dev", issue:"Localhost OAuth + prod .env.local", status:"live", owner:"cloud", shot:"",
    ascii:`  web/.env.local ──▶ prod API ──▶ Domain=.floom.dev cookies ✗
  USE: npm run dev:local + ops/dev-local-api.sh` },
  { id:"D-02", sev:"P2", area:"Process", issue:"Fake audit screenshots", status:"live", owner:"cloud", shot:"",
    ascii:`  audit-preview PNGs recycled as "verified" ──▶ rejected` },
  { id:"D-03", sev:"P2", area:"Process", issue:"Corrupt login screenshot", status:"live", owner:"cloud", shot:"C-01",
    ascii:`  01.png was black "Pretty print" screen ──▶ replaced` },
  { id:"D-04", sev:"P1", area:"Deploy", issue:"Vercel CI failures", status:"open", owner:"cloud", shot:"",
    ascii:`  dashboard: build fail (listWorkspaceChangelog)
  landing: apex /v3/integrations 404 after alias` },
  { id:"D-05", sev:"P1", area:"Deploy", issue:"listWorkspaceChangelog missing", status:"live", owner:"cloud", shot:"",
    ascii:`  overlay/lib/api.ts ──▶ add listWorkspaceChangelog()` },
  { id:"D-06", sev:"P1", area:"Deploy", issue:"Login overlay sync bug", status:"live", owner:"cloud", shot:"C-01",
    ascii:`  #665 ──▶ web/app/login ✓
  sync ──▶ overlay/login overwrites ✗` },
  { id:"D-07", sev:"P2", area:"Process", issue:"Engine local edits diverge", status:"track", owner:"process", shot:"",
    ascii:`  hand-edit engine/ ──▶ next bump wipes ──▶ PR floom first` },
  { id:"D-08", sev:"P2", area:"Deploy", issue:"Railway smoke gate", status:"manual", owner:"cloud", shot:"",
    ascii:`  push main ──▶ railway up ──▶ ops/smoke-routes.sh` },
];

function esc(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function shotHtml(row) {
  const key = row.shot;
  if (!key) {
    return `<div class="shot-empty">Drop <code>screenshots/${esc(row.id)}.png</code></div>`;
  }
  const file = SHOTS[key] || `${row.id}.png`;
  return `<figure class="shot"><a href="screenshots/${esc(file)}"><img src="screenshots/${esc(file)}" alt="${esc(row.id)}" loading="lazy"/></a><figcaption>${esc(file)}</figcaption></figure>`;
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

const counts = { live:0, disk:0, open:0, manual:0, track:0 };
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
  <p class="meta">47 items · cloud main · engine a990795d · 2026-06-24 · for Vivek</p>
  <div class="perm"><strong>Permanent URL:</strong> <a href="${PERMANENT_URL}">${PERMANENT_URL}</a></div>
  <div class="stats">
    <span>✓ LIVE ${counts.live}</span><span>~ DISK ${counts.disk}</span><span>! OPEN ${counts.open}</span>
    <span>? MANUAL ${counts.manual}</span><span>— TRACK ${counts.track}</span>
  </div>
</header>
<div class="toolbar">
  <label>Search <input type="search" id="q" placeholder="id, area, issue…"/></label>
  <label>Status <select id="sf"><option value="">All</option><option value="live">LIVE</option><option value="disk">DISK</option><option value="open">OPEN</option><option value="manual">MANUAL</option><option value="track">TRACK</option></select></label>
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

const srcShots = join(ROOT, "test-results/workeros-issue-inventory-2026-06-24/screenshots");
const primaryOut = join(ROOT, "public/audit");
mkdirSync(join(primaryOut, "screenshots"), { recursive: true });
writeFileSync(join(primaryOut, "index.html"), html);
if (existsSync(srcShots)) {
  for (const f of Object.values(SHOTS)) {
    cpSync(join(srcShots, f), join(primaryOut, "screenshots", f), { force: true });
  }
}
console.log("wrote", join(primaryOut, "index.html"));

for (const dir of OUT_DIRS.filter(d => d !== primaryOut)) {
  mkdirSync(join(dir, "screenshots"), { recursive: true });
  writeFileSync(join(dir, "index.html"), html);
  for (const f of Object.values(SHOTS)) {
    cpSync(join(primaryOut, "screenshots", f), join(dir, "screenshots", f), { force: true });
  }
  console.log("wrote", join(dir, "index.html"));
}
console.log("Permanent URL when landing deploys:", PERMANENT_URL);
