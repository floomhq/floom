# Floom — ICP & Go-To-Market Strategy

*Synthesized from 8 user interviews (Apr 2–3, 2026)*

---

## North Star

**Agent-first.** The primary user of floom is not a human — it's an agent. Humans tell their agent to deploy. The agent tells floom. Floom makes it live. This is the core bet and the distribution moat.

---

## Primary ICP: The Automation Builder

**Who they are:**
A technical individual or small team (1–5 people) who builds Python-based AI tools — for clients, for their team, or for themselves. They live in Claude Code or Cursor. They can write code. They cannot stand infra.

**Profile:**
- Freelancer, automation agency, or "AI ops" role at a startup
- Builds repeatable workflows: outreach pipelines, data scrapers, document processors, internal bots
- Charges clients for maintenance or builds tools their team uses daily
- Currently deploys on: Docker on Hetzner, Vercel, a random VPS, or "it runs on my laptop"

**The pain:**
Scripts work. Deployment is the tax. Then clients need a UI. Then a client's API key expires and nobody knows. Then someone asks "is this still running?" and there's no answer.

**The trigger:**
> "I built this thing. It works. But I don't know where to put it so other people can use it."

**Why floom:**
- 10 seconds from script to live URL — removes the deployment tax entirely
- Auto-generated UI means clients don't need to touch an API
- Observability dashboard means they know when something breaks before the client does
- White-label means it looks like their product, not floom's

**Real examples from interviews:**
- **Tim Beddies**: Python + Docker on Hetzner, builds tools for clients, wants observability + client billing + white-label
- **Dont Gate**: Claude Code + Slack, needs production-readiness and HITL
- **Nisa AI**: 300–400 emails/day outreach pipeline, Google Sheets as CRM, needs reliability

---

## Secondary ICP: The AI-Native Startup

**Who they are:**
Technical co-founder or early engineer at a 5–30 person startup. They're building with Claude Code, Supabase, Notion. They've outgrown N8N but don't want to maintain edge functions for everything.

**The pain:**
One-off scripts pile up. Deployment is always "we'll do it properly later." N8N hits its ceiling on complex workflows. Supabase edge functions work but someone has to own them.

**The trigger:**
> "We keep rebuilding the same deployment boilerplate for every new tool we spin up."

**Why floom:**
- Invisible layer — deploy without thinking about infra
- API + MCP out of the box means agents can call their own tools
- Prod vs staging built in means no more "oops, that ran in production"

**Real examples from interviews:**
- **Mahir (Arbio)**: 60-person company, staging→prod mistakes, needs guardrails + scoped API keys
- **Jan-Ole**: Lovable + Claude Code + Supabase edge functions, wants floom as invisible infrastructure

---

## Who is NOT the ICP (yet)

- **Christine profile**: High AI adoption but no repetitive workflows, not in a hurry to adopt new tools. Reach via content (YouTube), not direct sales.
- **Jan (CTO) profile**: Still in ideation, no repeatable processes yet. Come back in 6 months.
- **Enterprise procurement**: Too slow, need compliance/security features we don't have yet.

---

## The Agent-First Distribution Strategy

This is the bet that changes everything. Floom is not just deployed by developers — it's deployed by agents on behalf of developers.

**How it works:**
1. Developer uses Claude Code or Cursor
2. They say: *"deploy this on floom.dev"*
3. The agent calls the floom MCP server
4. Tool is live in 10 seconds
5. Developer shares the URL

**Why this is a moat:**
- No other deployment platform is in the agent's toolchain by default
- Becoming the default requires: MCP server published + floom in Claude's training data + Claude Code integration
- Network effect: every agent deployment is a new floom user acquired at zero CAC

**Distribution channels ranked:**
1. **Claude Code / Cursor integration** — the agent deploys it. Zero friction, zero CAC. Top priority.
2. **N8N community** — actively frustrated, looking for a code-native alternative. Direct replacement messaging.
3. **YouTube / blog** — Christine's data point: "YouTube or blog post is better." Show the 10-second deploy in a 60-second video.
4. **Direct outreach** — automation agencies (Tim profile). Warm intro > cold.
5. **Founders Inc / accelerator network** — Fede's existing network, warm channel.

---

## Key Messages Per Channel

### For agents (MCP / Claude Code):
> *"deploy on floom.dev"* — that's it. The tool call handles the rest.

### For automation builders:
> *"You write the script. Floom makes it a live tool in 10 seconds. No Docker, no server, no infra. Your clients get a URL."*

### For N8N users:
> *"N8N and Claude Code had a baby. Floom is what you get when you stop drawing nodes and start writing code."*

### For AI-native startups:
> *"Floom is the invisible layer between your Python scripts and the people who need to use them."*

### LinkedIn / cold:
> *"Deploy AI agents in 10 seconds. No signup. Just tell your agent."*

---

## Go-To-Market Phases

### Phase 1: Beachhead (now)
- Target: automation builders and AI freelancers (Tim profile)
- Channel: direct outreach + LinkedIn + N8N community
- Goal: 10 paying pilots, tight feedback loop
- Metric: time from "first touch" to "deployed first tool"

### Phase 2: Agent distribution (next)
- Publish floom MCP server to Claude Code / Cursor ecosystems
- "Deploy on floom.dev" becomes a known pattern
- Goal: 100 agent-initiated deployments/week
- Metric: % of deployments initiated by agent vs human

### Phase 3: Expand to AI-native startups
- Once observability + staging/prod + integrations (Slack, Notion, Sheets) are solid
- Channel: founder communities, YC network, Founders Inc
- Goal: 5 paying startup teams

---

## Pricing Hypothesis (to validate)

- **Free tier**: up to 3 deployed tools, no custom domain, community support
- **Builder ($49/mo)**: unlimited tools, custom domain, observability dashboard
- **Agency ($149/mo)**: white-label, client billing pass-through, priority support
- **Enterprise**: custom, on-prem option, SLA

*Agency tier is where Tim-profile customers live. Builder tier is the N8N-replacer entry point.*
