# pd2-09 — Integrations (Composio) narrative vs UI stub

**Lens:** ROADMAP “Backend shipped, UI stub” for Composio · PRODUCT trust / non-dev ICP · cross `pd-07`, `pd-08`, `pd-04`.

## Executive truth table

| # | Stakeholder expectation | Current product story | Verdict |
|---|---------------------------|----------------------|---------|
| 1 | ICP sees “Connect tools” in marketing | Studio stub or hidden path | **Partial** / **Missing** in UX |
| 2 | OAuth scary → need reassurance | Legal + security copy | **Partial** (`pd-13`) |
| 3 | “150+ tools” | True at backend; overwhelming if dumped as list | **Partial** |
| 4 | Failure mid-OAuth | Clear cancel + retry | **Partial** |
| 5 | Workspace scope for connections | Must match mental model of “my apps” | **Partial** (`pd-07`) |

## ICP failure tree

1. **ICP clicks Connect, hits stub**  
   - *Breaks:* trust (“feature fake”).  
   - *Recovery:* labeled “API only today” + doc link — better than empty.

2. **Connection succeeds but app does not show tool**  
   - *Breaks:* manifest vs Composio wiring unclear.  
   - *Recovery:* creator checklist in `/build` or studio.

3. **Revoked token**  
   - *Breaks:* run fails mid-flight.  
   - *Recovery:* run error names “reconnect Acme” not `401 upstream`.

## Risk register

| ID | Sev | Risk |
|----|-----|------|
| O1 | P1 | **Marketing–UX gap** on integrations reads as vaporware |
| O2 | P2 | **Support load** if connections exist without self-serve debug UI |
| O3 | P2 | **Security anxiety** if OAuth scopes not summarized in plain English |

## PM questions

1. Until UI ships, is Composio **mentioned on landing** at all? (If yes, stub must be honest.)  
2. Do you want a **minimal** “active connections” read-only panel before full builder?  
3. Should runs **automatically** link to “fix connection” when Composio errors?
