# Floom Product Roadmap

Synthesized from 7 user interviews (Dont Gate, Nisa AI, Tim Beddies, Mahir Isikli, Christine/ICODOS, Daniel Mladenov, Jan-Ole).

Features are deduplicated, labeled, and prioritized. Priority is based on how many users mentioned it and how core it is to floom's value prop.

## Priority Legend
- **P0** - Must have. Multiple users, core to value prop.
- **P1** - High value. Strong signal from 2+ users.
- **P2** - Nice to have. Single user or edge case.

## Label Legend
- `core` - Core platform capability
- `deploy` - Deployment & infrastructure
- `dx` - Developer experience
- `ui` - User-facing interface
- `integrations` - Third-party connections
- `guardrails` - Safety, testing, reliability
- `gtm` - Go-to-market / content

---

## P0 - Must Have

### Instant Deployment (E2B)
- **Labels**: `core` `deploy` `dx`
- **Mentioned by**: Daniel Mladenov
- **Description**: Deployment feels instant. No build step, no waiting. Script is live the moment you push. Powered by E2B sandboxes - MicroVM spin-up in ~150ms.
- **Why**: Daniel's biggest wow moment. "Crazy." The feeling of immediacy is the hook. Not just fast deployment - *instant*.

### Cron / Scheduled Tasks
- **Labels**: `core` `deploy`
- **Mentioned by**: Daniel Mladenov
- **Description**: Repetitive and scheduled tasks just work. Define a cron schedule in `floom.yaml` or the UI, and floom handles the execution, retries, and logs. No separate infra needed.
- **Why**: One of the top N8N use cases. If floom replaces N8N, cron must be first-class. "Just works" is the bar - zero configuration overhead.

### Streaming Output
- **Labels**: `core` `dx`
- **Mentioned by**: Fede (product)
- **Description**: Tools stream their output in real time - logs, partial results, progress. No waiting for a full response before seeing anything.
- **Why**: Core to making tools feel live and interactive. Required before any demo is compelling.

### Sandbox Environment (Default)
- **Labels**: `core` `deploy` `guardrails`
- **Mentioned by**: Fede (product), Mahir
- **Description**: Every new tool runs in a sandbox by default: isolated environment, scoped permissions, controlled integrations. Not just a UI concept - the sandbox is the actual execution environment. Covers: environment isolation, permission scoping, and integration gating (no live API calls until promoted).
- **Why**: Default safe execution is the foundation for guardrails, blast radius reduction, and enterprise trust. Must be the default, not an option.

### Test vs Live Environments (Playground)
- **Labels**: `core` `deploy` `guardrails`
- **Mentioned by**: Fede (product), Tim, Mahir, Dont Gate, Nisa AI
- **Description**: Every tool has two environments: **Playground** (test) and **Live** (production). Playground uses sandbox defaults, test API keys, no real side effects. Live is explicitly promoted to. The promotion step is intentional and requires confirmation.
- **Why**: The most-requested feature across all 5 interviews (prod/staging). This is the canonical version of it - framed as Playground/Live, not staging/prod. Makes the concept accessible to non-devs.

### Prod vs Staging Environments
- **Labels**: `core` `deploy`
- **Mentioned by**: Tim, Mahir, Dont Gate, Nisa AI
- **Description**: Separate staging and production environments for deployed tools. Staging for testing, prod for live. Promote with confidence. (See also: Test vs Live / Playground above - same concept, unified into one feature.)
- **Why**: Every technical user already has this in their own setup. Floom must match it.

### Observability Dashboard
- **Labels**: `core` `ui`
- **Mentioned by**: Tim, Mahir
- **Description**: Dashboard showing all deployed tools, their status (up/down/error), activity logs, and alerts (API key expired, errors, failures).
- **Why**: Tim's #1 missing feature. Mahir wants centralized tool management. Without this, users can't trust their deployments.

### Guardrails / Validation Agent
- **Labels**: `guardrails` `core`
- **Mentioned by**: Mahir, Christine
- **Description**: Agent that validates other agents' output before it ships. Human-in-the-loop approval for critical actions. Reduce blast radius.
- **Why**: Mahir's #1 concern. Christine: "1-2 minutes more to be more proof instead of autonomous but no control." Reliability > speed.

### 5-Minute Demo Flow
- **Labels**: `dx` `gtm`
- **Mentioned by**: Mahir, Christine
- **Description**: From zero to deployed tool in 5 minutes. The adoption bar. If someone can't see value in 5 min, they won't try it.
- **Why**: Christine won't try new tools ("too much stuff"). Mahir says 5min demo is the bar.

### Versioning
- **Labels**: `core` `deploy`
- **Mentioned by**: Christine, Nisa AI
- **Description**: Version control for deployed tools. Rollback to previous versions. See what changed.
- **Why**: Two users independently flagged this. Essential for production trust.

---

## P1 - High Value

### Google Sheets Integration
- **Labels**: `integrations`
- **Mentioned by**: Tim, Dont Gate, Nisa AI
- **Description**: Read/write Google Sheets as a data source. Many non-dev teams use Sheets as their database/CRM.
- **Why**: Three users use Google Sheets as their DB. This is reality for the target audience.

### Regression Tests + Rollback
- **Labels**: `guardrails` `deploy`
- **Mentioned by**: Mahir
- **Description**: Testing framework for deployed tools. Run tests before promoting to prod. Auto-rollback on failure.
- **Why**: Ties into prod/staging and versioning. Mahir explicitly asked for it.

### White-Label / Theming
- **Labels**: `ui`
- **Mentioned by**: Tim
- **Description**: Custom branding per client/workspace: colors, theme, design system, logo. Makes deployed tools feel like the client's own product.
- **Why**: Tim says branded experience adds premium value. Justifies ongoing maintenance fees. Differentiator for agencies.

### Alerting System
- **Labels**: `core` `ui`
- **Mentioned by**: Tim, Mahir
- **Description**: Alerts for API key expiry, tool errors, downtime, unusual activity. Push notifications or email.
- **Why**: Subset of observability but critical enough to call out. Without alerts, you only find out something broke when a client complains.

### Scoped API Key Access
- **Labels**: `guardrails` `core`
- **Mentioned by**: Mahir
- **Description**: API keys with scoped permissions (read-only, write, admin). Agents shouldn't have full access by default. Proxy layer for third-party APIs.
- **Why**: Mahir's blast radius concern. Security-first for enterprise.

### Slack Agent Deployment
- **Labels**: `integrations` `deploy`
- **Mentioned by**: Dont Gate
- **Description**: Deploy floom tools as Slack bots/agents. Slack is the daily interface for many teams.
- **Why**: Dont Gate uses Slack as their primary interface. Natural distribution channel.

### HITL (Human-in-the-Loop) Collaboration
- **Labels**: `guardrails` `core`
- **Mentioned by**: Dont Gate, Christine, Mahir
- **Description**: Approval workflows where a human reviews agent output before it executes. Configurable: always, on error, on high-risk actions.
- **Why**: Three users want this. Christine: reliability over autonomy. Mahir: reduce blast radius.

---

## P2 - Nice to Have

### WhatsApp / Facebook API Integration
- **Labels**: `integrations`
- **Mentioned by**: Christine
- **Description**: Send/receive WhatsApp and Facebook messages from deployed tools.
- **Why**: Single user, but common use case for outreach/support bots.

### Outreach Sequences (Email + Instagram)
- **Labels**: `integrations`
- **Mentioned by**: Nisa AI
- **Description**: Automated outreach pipelines: email sequences, Instagram DMs, stage tracking, deliverability checking.
- **Why**: Specific to Nisa AI's use case but represents a common pattern (outreach automation).

### Browser Session Management
- **Labels**: `deploy`
- **Mentioned by**: Tim, Mahir
- **Description**: Spin up and manage multiple browser sessions for different projects/clients. Browser automation at scale.
- **Why**: Niche but both Tim and Mahir mentioned it.

### Voice Agents
- **Labels**: `integrations`
- **Mentioned by**: Mahir
- **Description**: Speech-to-text interfaces for tools (office assistant, wifi details, etc.).
- **Why**: Single user, forward-looking.

### Feedback Button (Save Dump + Parsed)
- **Labels**: `dx`
- **Mentioned by**: Tim
- **Description**: When a tool produces output, save both the raw dump and the parsed version. For debugging and audit.
- **Why**: Good practice, easy to implement.

### Hosting Fee Pass-Through
- **Labels**: `ui`
- **Mentioned by**: Tim
- **Description**: Per-client billing for hosting. Show clients what they're paying for. Charge hosting fees transparently.
- **Why**: Agency-specific but aligns with white-label positioning.

### Billing / Finance Bot Template
- **Labels**: `dx`
- **Mentioned by**: Dont Gate
- **Description**: Pre-built template for a billing/finance bot. Common enough use case to template.
- **Why**: Single user, but validates the "templates" approach.

---

---

## Deduplication Notes

| Feature | Canonical Name | Also Referenced As |
|---------|---------------|-------------------|
| Test vs Live / Playground | **Test vs Live (Playground)** | Prod vs staging, staging->prod, test and prod |
| Sandbox | **Sandbox Environment (Default)** | E2B sandbox, isolated execution, scoped permissions |
| Streaming | **Streaming Output** | Streaming, real-time logs |

---

## Cross-Cutting Themes

| Theme | Users | Implication |
|-------|-------|-------------|
| Reliability > speed | Christine, Mahir, Dont Gate | Position floom as reliable-first, not fast-first |
| Google Sheets as DB | Tim, Dont Gate, Nisa AI | First-class Sheets integration is table stakes |
| Prod vs staging | Tim, Mahir, Dont Gate, Nisa AI | Non-negotiable for production use |
| Non-dev deployment | All 6 | The entire value prop. 5min demo is the bar |
| Guardrails / HITL | Mahir, Christine, Dont Gate | Safety is a feature, not a limitation |
| YouTube/blog for GTM | Christine | Content-first distribution, not product trials |
| N8N replacement | Daniel | "N8N and Claude Code had a baby" - the positioning that lands for N8N users; irrelevant for non-N8N personas |
| Instant / immediacy | Daniel, Jan-Ole | Not just fast - the *feeling* of instant is the hook; Jan-Ole wants "invisible layer" |
| Invisible infrastructure | Jan-Ole | Floom shouldn't feel like a tool - it should disappear into the stack |
