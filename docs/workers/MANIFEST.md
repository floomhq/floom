# Worker Manifest — S38

**Last updated:** 2026-05-29  
**Active workers:** 12 (non-system, non-archived)  
**Archived workers:** 2  
**System workers:** 1 (worker-author, hidden from /workers list)

---

## Active Workers

### weekly_update
- **Bundle:** workers/weekly_update/
- **Trigger:** Manual
- **Smoke input:** docs/workers/inputs/weekly_update.json
- **Expected output:** out/update.md (markdown update)
- **Connections required:** none
- **Secrets required:** none
- **Runtime:** skill (SKILL.md)
- **Status:** ACTIVE

### research_brief
- **Bundle:** workers/research_brief/
- **Trigger:** Manual
- **Smoke input:** docs/workers/inputs/research_brief.json
- **Expected output:** out/brief.md (markdown brief)
- **Connections required:** none
- **Secrets required:** none
- **Runtime:** skill (SKILL.md)
- **Status:** ACTIVE

### dach_compliance
- **Bundle:** workers/dach_compliance/
- **Trigger:** Manual
- **Smoke input:** docs/workers/inputs/dach_compliance.json
- **Expected output:** out/compliance_report.md, out/rate_benchmark.md, out/red_flags.json
- **Connections required:** none
- **Secrets required:** OPENAI_API_KEY
- **Runtime:** python311 (run.py)
- **Status:** ACTIVE

### github-digest
- **Bundle:** workers/github-digest/
- **Trigger:** Schedule (0 9 * * * UTC)
- **Smoke input:** docs/workers/inputs/github-digest.json
- **Expected output:** out/digest.md
- **Connections required:** github
- **Secrets required:** GITHUB_PAT (now set on prod)
- **Runtime:** skill (SKILL.md)
- **Status:** ACTIVE — GITHUB_PAT confirmed set on prod (2026-05-29)

### gmail_intake_brief
- **Bundle:** workers/gmail_intake_brief/
- **Trigger:** Manual
- **Smoke input:** docs/workers/inputs/gmail_intake_brief.json
- **Expected output:** out/summary.md (email summary)
- **Connections required:** gmail
- **Secrets required:** OPENAI_API_KEY
- **Runtime:** python311 (run.py)
- **Status:** ACTIVE — requires active Gmail Composio connection

### csv_enricher
- **Bundle:** workers/csv_enricher/
- **Trigger:** Manual
- **Smoke input:** docs/workers/inputs/csv_enricher.json (+ file upload)
- **Expected output:** out/enriched_csv.csv
- **Connections required:** none
- **Secrets required:** OPENAI_API_KEY
- **Runtime:** python311 (run.py)
- **Status:** ACTIVE

### cv_writeup
- **Bundle:** workers/cv_writeup/
- **Trigger:** Manual
- **Smoke input:** docs/workers/inputs/cv_writeup.json (+ file upload)
- **Expected output:** out/writeup.md, out/extracted_profile.json
- **Connections required:** none
- **Secrets required:** OPENAI_API_KEY
- **Runtime:** python311 (run.py)
- **Status:** ACTIVE

### reverse_match_crm
- **Bundle:** workers/reverse_match_crm/
- **Trigger:** Manual
- **Smoke input:** docs/workers/inputs/reverse_match_crm.json (+ file upload)
- **Expected output:** out/top_candidates.csv, out/analysis_summary.md
- **Connections required:** none
- **Secrets required:** OPENAI_API_KEY
- **Runtime:** python311 (run.py)
- **Status:** ACTIVE

### linkedin-post-engagements
- **Bundle:** workers/linkedin-post-engagements/
- **Trigger:** Schedule (0 9 * * 2,5 Europe/Berlin)
- **Smoke input:** docs/workers/inputs/linkedin-post-engagements.json
- **Expected output:** out/engagements.json, out/summary.md
- **Connections required:** none
- **Secrets required:** APIFY_API_KEY
- **Runtime:** python311 (run.py)
- **Status:** ARCHIVED — APIFY_API_KEY free credits exhausted until 2026-06-25. Worker code correct (KeyError guard added lane/reliability-2026-05-29). Restore when credits renew.

### node-smoke-test
- **Bundle:** workers/node-smoke-test/
- **Trigger:** Manual
- **Smoke input:** docs/workers/inputs/node-smoke-test.json
- **Expected output:** out/result.json
- **Connections required:** none
- **Secrets required:** none
- **Runtime:** node22 (run.js)
- **Status:** ACTIVE

### openblog
- **Bundle:** workers/openblog/
- **Trigger:** Manual
- **Smoke input:** docs/workers/inputs/openblog.json
- **Expected output:** out/markdown.md, out/raw.json, out/openblog_articles.zip
- **Connections required:** none
- **Secrets required:** GEMINI_API_KEY
- **Runtime:** python311 (run.py) — bundles federicodeponte/openblog engine
- **Status:** ACTIVE

### opendraft
- **Bundle:** workers/opendraft/
- **Trigger:** Manual
- **Smoke input:** docs/workers/inputs/opendraft.json
- **Expected output:** out/final_draft.md, out/run_metadata.json, out/opendraft_workspace.zip
- **Connections required:** none
- **Secrets required:** GOOGLE_API_KEY
- **Runtime:** python311 (run.py) — bundles federicodeponte/opendraft engine
- **Status:** ACTIVE

---

## System Workers (hidden from /workers list)

### worker-author
- **Bundle:** workers/worker-author/
- **Trigger:** Manual
- **Expected output:** out/bundle.json (generated worker bundle)
- **Connections required:** none
- **Secrets required:** none
- **Runtime:** python311 (run.py)
- **system_worker:** true — hidden from /workers list + Cmd-K by default
- **Status:** SYSTEM

---

## Archived Workers

### kugelaudio-bug-intake
- **Bundle:** workers/kugelaudio-bug-intake/ (preserved on disk)
- **Trigger:** Schedule (*/15 * * * * Europe/Berlin)
- **Connections required:** slack, linear
- **Secrets required:** SLACK_BOT_TOKEN, LINEAR_API_KEY, NOTION_API_KEY, ANTHROPIC_API_KEY
- **archived:** true
- **archive_reason:** Customer secrets unavailable (SLACK_BOT_TOKEN, LINEAR_API_KEY, NOTION_API_KEY)
- **Status:** ARCHIVED — restore when customer onboards

### kugelaudio-meeting-pipeline
- **Bundle:** workers/kugelaudio-meeting-pipeline/ (preserved on disk)
- **Trigger:** Schedule (*/15 * * * * Europe/Berlin)
- **Connections required:** notion, linear, slack
- **Secrets required:** NOTION_API_KEY, SLACK_BOT_TOKEN, LINEAR_API_KEY, ANTHROPIC_API_KEY
- **archived:** true
- **archive_reason:** Customer secrets unavailable (SLACK_BOT_TOKEN, LINEAR_API_KEY, NOTION_API_KEY)
- **Status:** ARCHIVED — restore when customer onboards
