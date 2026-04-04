# Floom — Positioning One-Pager

*For Vlad, Paul, and the team. Everything we've learned and decided, in one place.*

---

## The Tagline

> **Deploy AI agents in 10 seconds. No signup. Just tell your agent.**

---

## What Floom Is

Floom is the production layer for AI agents. You write a Python script. Floom turns it into a live tool — with an API, a UI, and an MCP endpoint — in 10 seconds. No Docker. No CI/CD. No infra thinking.

The killer feature: **agents deploy to floom themselves.** Tell your Claude Code agent "deploy on floom.dev" and it's live before you finish reading this sentence.

---

## The One-Line Version Per Audience

| Audience | Line |
|----------|------|
| General | Deploy AI agents in 10 seconds. |
| Developers | Python script → live API + UI + MCP. 10 seconds. |
| N8N users | N8N and Claude Code had a baby. |
| Agencies | Your clients get a URL. You keep the margin. |
| Agents | `deploy on floom.dev` |

---

## The Word We Use

**Agents** — not tools, not apps, not automations, not workflows.

- "Agents" is what the market is calling everything right now (Notion Agents, etc.)
- "Workflows" is our comparison word — we use it when explaining we replace N8N
- "Apps" implies frontend. We are backend-first.
- "Tools" is accurate but undersells it.

---

## Who It's For

**Primary**: Automation builders and AI agencies. 1–5 person teams building Python-based AI tools for clients or teams. They know how to code. They hate infra. They need their clients to actually use what they build.

**Secondary**: AI-native startups. Technical co-founders who have outgrown N8N and need a faster, code-native deployment path.

**Not yet**: Enterprises, non-technical users, companies still in ideation.

---

## Why Now

Three things collided:
1. Everyone is building with Claude Code / Cursor — but there's nowhere obvious to deploy what they build
2. N8N has hit its ceiling for complex, code-native workflows
3. Agents can now call APIs autonomously — so the deployment target itself can be agent-discoverable

Floom is what fills the gap between "it works in Claude Code" and "it's running in production."

---

## How We're Different

| | Floom | N8N | Vercel | Modal | Blaxel |
|--|-------|-----|--------|-------|--------|
| Agent-first deploy | ✅ | ❌ | ❌ | ❌ | ❌ |
| 10-second deploy | ✅ | ❌ | Partial | ❌ | ✅ |
| No signup to try | ✅ | ❌ | ❌ | ❌ | ❌ |
| Auto UI + API + MCP | ✅ | ❌ | UI only | API only | ❌ |
| Python-native | ✅ | Partial | ❌ | ✅ | ✅ |
| Non-dev end users | ✅ | ❌ | ✅ | ❌ | ❌ |

**The real moat**: No other platform lets an agent deploy to it by default. That's a distribution advantage, not just a feature.

---

## What We Replace

**Direct replacement**: N8N, Make, Zapier — for users who write code and are frustrated with visual node editors.

**Adjacent**: Vercel (they deploy frontends, we deploy backends). Lovable (they build the UI, we run the agent behind it). These are partners, not competitors.

**Watch**: Blaxel (YC X25) — moving up the stack, same space. Modal — could add a deployment layer.

---

## The Demo

10-second demo. Every time. Non-negotiable.

1. Open Claude Code
2. Say: *"deploy on floom.dev"*
3. Tool is live at a URL
4. Share the URL

The meta-point: an agent just deployed an agent.

---

## What Users Said (Verbatim)

> *"Crazy."* — Daniel, on instant deployment

> *"N8N and Claude Code had a baby."* — Daniel, on positioning

> *"Invisible layer — just make deployments work faster, behind the scenes."* — Jan-Ole

> *"Should be reliable. 1–2 minutes more to be more proof instead of autonomous but no control."* — Christine

> *"The deployment simplification value is clearly needed."* — Jan (CTO)

> *"If you give me a tool which does this very solid, very fast — I can see the value."* — Jan (CTO)

---

## What We're NOT Saying

- ❌ "Build AI apps" — sounds like frontend
- ❌ "Automation platform" — sounds like Zapier
- ❌ "No-code" — we are code-first
- ❌ "AI agent framework" — we are deployment, not the agent itself
- ❌ "Full-stack" — we are backend/API first, UI is generated, not custom

---

## The 3 P0s (What Vlad Ships Next)

From 8 interviews, these came up in almost every conversation:

1. **Test vs Live (Playground)** — every tool needs a sandbox and a production environment. Non-negotiable for anyone with real workflows.
2. **Observability dashboard** — "how do I know when something breaks?" Every single ICP user asked this.
3. **Cron / scheduled tasks** — "just works" scheduled execution is table stakes for replacing N8N.

---

*Last updated: 2026-04-03. Keep this doc alive — update it after every 5 user interviews.*
