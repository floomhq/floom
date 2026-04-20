# pd2-10 — Support and escalation (when trust breaks)

**Lens:** PRODUCT ICP not infra-savvy · ROADMAP feedback / observability · cross `pd-14`, `pd-13`, `ax-10`.

## Executive truth table

| # | Channel | ICP discoverability | Verdict |
|---|---------|---------------------|---------|
| 1 | In-app **feedback** | Obvious after error or from `/me` | **Partial** |
| 2 | **Status page** / uptime | External trust signal | **Partial** / often missing pre-1.0 |
| 3 | **Docs / protocol** | `/protocol` shell vs depth (ROADMAP P1 real docs) | **Partial** (`pd-20`) |
| 4 | **Community / email** | Clear for self-host vs cloud | **Partial** |
| 5 | **Run id** as support token | Users can copy id from UI | **Partial** |

## ICP failure tree

1. **Repeated 500s**  
   - *Breaks:* no incident communication.  
   - *Recovery:* status page or banner; else Twitter/support only — **ICP lost**.

2. **“Contact your admin” style message**  
   - *Breaks:* ICP *is* admin on self-host; on cloud there is no admin.  
   - *Recovery:* never show enterprise-only copy on solo ICP tier.

3. **Feedback sent, no acknowledgment**  
   - *Breaks:* feels like void.  
   - *Recovery:* auto-reply id + “we read these” expectation setting.

## Risk register

| ID | Sev | Risk |
|----|-----|------|
| S1 | P2 | **No visible support path** after catastrophic error → churn + bad word-of-mouth |
| S2 | P2 | **Run id not copyable** → longer MTTR for async issues |
| S3 | P3 | **Over-promising** response time in footer |

## PM questions

1. What is the **minimum** support promise for preview (none vs best-effort vs SLA later)?  
2. Should fatal UI errors always include **Feedback** + **copy diagnostics** (privacy-safe)?  
3. Is there a **dedicated** “I cannot publish” escalation separate from generic feedback?
