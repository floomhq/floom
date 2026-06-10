"""OpenPaper PostHog Daily Summary - E2B-native python worker (stdlib only).

Every morning this worker:
  1. Queries the OpenPaper PostHog project (US or EU cloud, auto-detected) for
     the last 24h of product analytics, plus the prior 24h for comparison.
  2. Builds a structured HTML + markdown summary framed around OpenPaper's
     funnel (sign up -> generate -> download -> upgrade -> checkout).
  3. Optionally adds a short analyst note via Gemini (graceful fallback).
  4. Emails the summary to the configured recipient via the Workeros
     Composio Gmail proxy (GMAIL_SEND_EMAIL).

Inputs (inputs.json):  recipient_email, posthog_host, project_id, lookback_hours
Secrets (env/.env.local): OPENPAPER_POSTHOG_API_KEY (required, personal API key),
                          GEMINI_API_KEY (optional, for the analyst note)
Connections (connections.json): {"gmail": "<composio_connection_id>"}

No secrets are hardcoded. Every credential is read from the environment.
"""

from __future__ import annotations

import json
import os
import urllib.request
import urllib.error
from datetime import datetime, timezone

try:
    from dotenv import load_dotenv
    load_dotenv(".env.local")
except Exception:
    pass  # dotenv optional; os.environ + secrets.json cover the rest

_WORKEROS_API = os.environ.get("WORKEROS_API_URL", "https://workers-api.floom.dev")
_RUN_ID = os.environ.get("FLOOM_RUN_ID", "")
_RUN_TOKEN = os.environ.get("WORKEROS_RUN_TOKEN", "")

DEFAULT_POSTHOG_HOST = "https://us.posthog.com"
# A PostHog personal API key only works on its home cloud, so try both.
CANDIDATE_HOSTS = ["https://us.posthog.com", "https://eu.posthog.com"]
DEFAULT_RECIPIENT = "depontefede@gmail.com"

# OpenPaper product context - baked in so the email is self-explanatory.
OPENPAPER_CONTEXT = (
    "OpenPaper is an AI academic-paper generator: it produces thesis-level drafts in "
    "under 10 minutes with real, verifiable citations from CrossRef, Semantic Scholar, "
    "arXiv and PubMed (500M+ papers, zero hallucinated references). Users sign up, "
    "generate a paper, watch it stream live, then download as PDF/DOCX. Monetisation is "
    "credit-based: when credits run out users hit an upgrade prompt and a Stripe checkout."
)

# Funnel-ordered KPIs: (event_name, human_label).
FUNNEL = [
    ("$pageview", "Pageviews"),
    ("sign_up", "Sign-ups"),
    ("generate_start", "Generations started"),
    ("generate_complete", "Generations completed"),
    ("generate_error", "Generation errors"),
    ("download_pdf", "PDF downloads"),
    ("download_docx", "DOCX downloads"),
    ("credits_exhausted", "Credits exhausted"),
    ("upgrade_click", "Upgrade clicks"),
    ("checkout_start", "Checkout started"),
    ("checkout_complete", "Checkout completed"),
    ("checkout_cancel", "Checkout cancelled"),
]


def _load_secrets_fallback() -> dict:
    try:
        with open("secrets.json") as fh:
            data = json.load(fh)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _secret(name: str, fallback: dict) -> str:
    return (os.environ.get(name) or fallback.get(name) or "").strip()


def _write_result(status: str, outputs: dict, artifacts: list, error=None) -> None:
    with open("result.json", "w", encoding="utf-8") as fh:
        json.dump({"status": status, "outputs": outputs, "artifacts": artifacts, "error": error}, fh)


def _http_error_detail(exc: urllib.error.HTTPError) -> str:
    try:
        return exc.read().decode("utf-8")[:400]
    except Exception:
        return str(exc)


def _ph_get(host: str, path: str, api_key: str) -> dict:
    req = urllib.request.Request(
        f"{host}{path}",
        headers={"Authorization": f"Bearer {api_key}", "User-Agent": "workeros-openpaper-digest/1.0"},
    )
    with urllib.request.urlopen(req, timeout=45) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _ph_query(host: str, project_id, api_key: str, hogql: str) -> dict:
    body = json.dumps({"query": {"kind": "HogQLQuery", "query": hogql}}).encode("utf-8")
    req = urllib.request.Request(
        f"{host}/api/projects/{project_id}/query/",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "workeros-openpaper-digest/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _pick_project(results: list) -> tuple:
    """Prefer a project whose name looks like OpenPaper, else the first one."""
    for proj in results:
        name = (proj.get("name") or "").lower()
        if "openpaper" in name or "open paper" in name or "paper" in name:
            return proj.get("id"), proj.get("name")
    return results[0].get("id"), results[0].get("name")


def _resolve_project(host_input: str, api_key: str) -> tuple:
    """Return (host, project_id, project_name).

    If the caller pinned a host, use only that. Otherwise probe US then EU and
    use the cloud where this personal API key can actually list projects.
    """
    candidates = [host_input] if host_input not in (None, "", DEFAULT_POSTHOG_HOST) else list(CANDIDATE_HOSTS)
    last_err = None
    for host in candidates:
        host = host.rstrip("/")
        try:
            data = _ph_get(host, "/api/projects/", api_key)
        except urllib.error.HTTPError as exc:
            last_err = exc
            if exc.code in (401, 403):
                continue  # wrong cloud for this key; try the next
            raise
        results = data.get("results") or []
        if results:
            pid, pname = _pick_project(results)
            return host, pid, pname
    if last_err is not None:
        raise last_err
    raise RuntimeError("PostHog returned no projects for this API key on any cloud")


def _fetch_metrics(host: str, project_id, api_key: str, lookback_hours: int) -> dict:
    win = int(lookback_hours)
    events_q = f"""
SELECT
  event,
  countIf(timestamp >= now() - INTERVAL {win} HOUR) AS cur,
  countIf(timestamp >= now() - INTERVAL {2 * win} HOUR AND timestamp < now() - INTERVAL {win} HOUR) AS prev
FROM events
WHERE timestamp >= now() - INTERVAL {2 * win} HOUR
GROUP BY event
ORDER BY cur DESC
""".strip()

    users_q = f"""
SELECT
  uniqIf(person_id, timestamp >= now() - INTERVAL {win} HOUR) AS cur_users,
  uniqIf(person_id, timestamp >= now() - INTERVAL {2 * win} HOUR AND timestamp < now() - INTERVAL {win} HOUR) AS prev_users
FROM events
WHERE timestamp >= now() - INTERVAL {2 * win} HOUR
""".strip()

    events_res = _ph_query(host, project_id, api_key, events_q)
    users_res = _ph_query(host, project_id, api_key, users_q)

    counts = {}
    for row in events_res.get("results") or []:
        if len(row) >= 3:
            counts[str(row[0])] = {"cur": int(row[1] or 0), "prev": int(row[2] or 0)}

    urow = (users_res.get("results") or [[0, 0]])[0]
    users = {"cur": int(urow[0] or 0), "prev": int(urow[1] or 0)} if urow else {"cur": 0, "prev": 0}

    return {"counts": counts, "users": users}


def _delta_str(cur: int, prev: int) -> str:
    diff = cur - prev
    if prev == 0:
        return "new" if cur > 0 else "-"
    pct = round(diff / prev * 100)
    sign = "+" if diff >= 0 else ""
    return f"{sign}{diff} ({sign}{pct}%)"


def _arrow(cur: int, prev: int) -> str:
    if cur > prev:
        return "▲"
    if cur < prev:
        return "▼"
    return "→"


def _gemini_note(api_key: str, metrics: dict, window_label: str) -> str:
    """Optional 2-3 sentence analyst note. Returns '' on any failure."""
    if not api_key:
        return ""
    try:
        lines = []
        for event, label in FUNNEL:
            c = metrics["counts"].get(event, {"cur": 0, "prev": 0})
            lines.append(f"{label}: {c['cur']} (prev {c['prev']})")
        lines.append(f"Active users: {metrics['users']['cur']} (prev {metrics['users']['prev']})")
        prompt = (
            "You are a product analyst for OpenPaper. " + OPENPAPER_CONTEXT + "\n\n"
            f"Here are the {window_label} metrics vs the previous period:\n"
            + "\n".join(lines)
            + "\n\nWrite a tight 2-3 sentence analyst note: what moved, the most likely "
            "story, and the single most important thing to watch. No fluff, no bullet "
            "points, plain prose. Do not invent numbers."
        )
        body = json.dumps({"contents": [{"parts": [{"text": prompt}]}]}).encode("utf-8")
        url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"gemini-3-flash-preview:generateContent?key={api_key}"
        )
        req = urllib.request.Request(
            url, data=body, method="POST", headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=45) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        parts = (((payload.get("candidates") or [{}])[0].get("content") or {}).get("parts")) or []
        text = "".join(p.get("text", "") for p in parts).strip()
        return text
    except Exception:
        return ""


def _render(metrics: dict, project_name: str, window_label: str, note: str) -> tuple:
    counts = metrics["counts"]
    users = metrics["users"]
    today = datetime.now(timezone.utc).strftime("%A, %d %B %Y")

    def g(ev):
        return counts.get(ev, {"cur": 0, "prev": 0})

    dau = users
    sign = g("sign_up")
    gen_done = g("generate_complete")
    checkout = g("checkout_complete")

    md = ["# OpenPaper - Daily Analytics Summary", f"_{today} - {window_label} - project: {project_name}_", ""]
    md.append("## Headline")
    md.append(f"- Active users: **{dau['cur']}** ({_delta_str(dau['cur'], dau['prev'])})")
    md.append(f"- Sign-ups: **{sign['cur']}** ({_delta_str(sign['cur'], sign['prev'])})")
    md.append(f"- Papers generated: **{gen_done['cur']}** ({_delta_str(gen_done['cur'], gen_done['prev'])})")
    md.append(f"- Checkouts completed: **{checkout['cur']}** ({_delta_str(checkout['cur'], checkout['prev'])})")
    md.append("")
    if note:
        md.append("## Analyst note")
        md.append(note)
        md.append("")
    md.append("## Funnel")
    md.append("| Stage | This period | Prev | Delta |")
    md.append("|---|---:|---:|---|")
    for event, label in FUNNEL:
        c = g(event)
        md.append(f"| {label} | {c['cur']} | {c['prev']} | {_arrow(c['cur'], c['prev'])} {_delta_str(c['cur'], c['prev'])} |")
    extra = [(e, v) for e, v in counts.items() if e not in {f[0] for f in FUNNEL} and v["cur"] > 0]
    if extra:
        md.append("")
        md.append("## Other events")
        md.append("| Event | This period | Prev |")
        md.append("|---|---:|---:|")
        for e, v in sorted(extra, key=lambda x: -x[1]["cur"]):
            md.append(f"| {e} | {v['cur']} | {v['prev']} |")
    md.append("")
    md.append("---")
    md.append("**About OpenPaper:** " + OPENPAPER_CONTEXT)
    markdown = "\n".join(md)

    def kpi(label, c):
        return (
            f'<td style="padding:14px 18px;border:1px solid #ececec;border-radius:10px;'
            f'background:#fafaf8;text-align:center;">'
            f'<div style="font-size:26px;font-weight:700;color:#1a1a1a;">{c["cur"]}</div>'
            f'<div style="font-size:12px;color:#666;margin-top:2px;">{label}</div>'
            f'<div style="font-size:12px;color:#059669;margin-top:2px;">{_delta_str(c["cur"], c["prev"])}</div>'
            f"</td>"
        )

    rows = []
    for event, label in FUNNEL:
        c = g(event)
        color = "#059669" if c["cur"] >= c["prev"] else "#b91c1c"
        rows.append(
            f'<tr><td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;">{label}'
            f'<div style="font-size:11px;color:#999;">{event}</div></td>'
            f'<td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600;">{c["cur"]}</td>'
            f'<td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;color:#999;">{c["prev"]}</td>'
            f'<td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;color:{color};">'
            f'{_arrow(c["cur"], c["prev"])} {_delta_str(c["cur"], c["prev"])}</td></tr>'
        )

    note_html = (
        f'<div style="margin:18px 0;padding:14px 18px;background:#f4f9f6;border-radius:10px;'
        f'font-size:14px;line-height:1.55;color:#1a1a1a;"><strong style="color:#059669;">Analyst note</strong><br>{note}</div>'
        if note else ""
    )

    html = (
        '<!DOCTYPE html><html><body style="margin:0;background:#ffffff;'
        'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">'
        '<div style="max-width:640px;margin:0 auto;padding:28px 24px;">'
        f'<div style="font-size:13px;color:#666;">{today} - {window_label}</div>'
        '<h1 style="font-size:24px;margin:6px 0 2px;">OpenPaper - Daily Analytics</h1>'
        f'<div style="font-size:13px;color:#999;margin-bottom:20px;">PostHog project: {project_name}</div>'
        '<table style="width:100%;border-collapse:separate;border-spacing:8px;margin-bottom:8px;"><tr>'
        f'{kpi("Active users", dau)}{kpi("Sign-ups", sign)}{kpi("Papers generated", gen_done)}{kpi("Checkouts", checkout)}'
        '</tr></table>'
        f'{note_html}'
        '<h2 style="font-size:16px;margin:24px 0 8px;">Funnel - this period vs previous</h2>'
        '<table style="width:100%;border-collapse:collapse;font-size:14px;">'
        '<tr style="text-align:left;color:#666;font-size:12px;">'
        '<th style="padding:6px 12px;">Stage</th><th style="padding:6px 12px;text-align:right;">Now</th>'
        '<th style="padding:6px 12px;text-align:right;">Prev</th><th style="padding:6px 12px;text-align:right;">Delta</th></tr>'
        f'{"".join(rows)}'
        '</table>'
        '<div style="margin-top:24px;padding-top:16px;border-top:1px solid #eee;font-size:12px;color:#888;line-height:1.5;">'
        f'<strong>About OpenPaper:</strong> {OPENPAPER_CONTEXT}'
        '</div></div></body></html>'
    )

    return markdown, html


def _send_email(conn_id: str, to: str, subject: str, html_body: str) -> str:
    url = f"{_WORKEROS_API}/runs/{_RUN_ID}/composio-execute/GMAIL_SEND_EMAIL"
    body = json.dumps({
        "connected_account_id": conn_id,
        "arguments": {
            "recipient_email": to,
            "subject": subject,
            "body": html_body,
            "is_html": True,
        },
    }).encode("utf-8")
    headers = {"Content-Type": "application/json", "User-Agent": "workeros-openpaper-digest/1.0"}
    if _RUN_TOKEN:
        headers["X-Workeros-Run-Token"] = _RUN_TOKEN
    req = urllib.request.Request(url, data=body, method="POST", headers=headers)
    with urllib.request.urlopen(req, timeout=45) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    data = payload.get("data") or {}
    return str(data.get("id") or data.get("messageId") or data.get("response_data", {}).get("id") or "sent")


def main() -> None:
    try:
        with open("inputs.json") as fh:
            inputs = json.load(fh)
    except Exception:
        inputs = {}

    try:
        with open("connections.json") as fh:
            connections = json.load(fh)
    except Exception:
        connections = {}

    fallback = _load_secrets_fallback()
    ph_key = _secret("OPENPAPER_POSTHOG_API_KEY", fallback)
    gemini_key = _secret("GEMINI_API_KEY", fallback)

    host_input = (str(inputs.get("posthog_host") or "").strip() or DEFAULT_POSTHOG_HOST).rstrip("/")
    recipient = str(inputs.get("recipient_email") or "").strip() or DEFAULT_RECIPIENT
    project_override = str(inputs.get("project_id") or "").strip()
    try:
        lookback_hours = int(inputs.get("lookback_hours") or 24)
    except Exception:
        lookback_hours = 24
    window_label = "last 24h" if lookback_hours == 24 else f"last {lookback_hours}h"

    if not ph_key:
        _write_result("error", {}, [], error="Missing required secret: OPENPAPER_POSTHOG_API_KEY")
        return

    gmail_conn_id = connections.get("gmail", "")
    if not gmail_conn_id:
        _write_result("error", {}, [], error="Gmail connection not found - connect 'gmail' at /connections")
        return
    if not _RUN_ID:
        _write_result("error", {}, [], error="FLOOM_RUN_ID not set - cannot call Composio proxy")
        return

    try:
        if project_override:
            host = host_input.rstrip("/")
            project_id, project_name = project_override, project_override
        else:
            host, project_id, project_name = _resolve_project(host_input, ph_key)
    except urllib.error.HTTPError as exc:
        hint = " (key may be a phc_ ingestion key - a personal phx_ API key is required to read data)" if exc.code in (401, 403) else ""
        _write_result("error", {}, [], error=f"PostHog project lookup HTTP {exc.code}: {_http_error_detail(exc)}{hint}")
        return
    except Exception as exc:
        _write_result("error", {}, [], error=f"PostHog project lookup failed: {exc}")
        return

    try:
        metrics = _fetch_metrics(host, project_id, ph_key, lookback_hours)
    except urllib.error.HTTPError as exc:
        _write_result("error", {}, [], error=f"PostHog query HTTP {exc.code}: {_http_error_detail(exc)}")
        return
    except Exception as exc:
        _write_result("error", {}, [], error=f"PostHog query failed: {exc}")
        return

    note = _gemini_note(gemini_key, metrics, window_label)
    markdown, html = _render(metrics, str(project_name), window_label, note)

    os.makedirs("out", exist_ok=True)
    with open("out/summary.md", "w", encoding="utf-8") as fh:
        fh.write(markdown)
    with open("out/metrics.json", "w", encoding="utf-8") as fh:
        json.dump({
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "project": project_name,
            "window_hours": lookback_hours,
            "metrics": metrics,
        }, fh, indent=2)

    artifacts = [
        {"name": "summary", "relative_path": "out/summary.md", "type": "text/markdown"},
        {"name": "metrics", "relative_path": "out/metrics.json", "type": "application/json"},
    ]

    today = datetime.now(timezone.utc).strftime("%d %b %Y")
    subject = f"OpenPaper daily - {metrics['users']['cur']} active users, {metrics['counts'].get('generate_complete', {}).get('cur', 0)} papers ({today})"

    try:
        message_id = _send_email(gmail_conn_id, recipient, subject, html)
    except urllib.error.HTTPError as exc:
        _write_result("error", {"summary": "out/summary.md", "metrics": "out/metrics.json"}, artifacts,
                      error=f"Gmail send HTTP {exc.code}: {_http_error_detail(exc)}")
        return
    except Exception as exc:
        _write_result("error", {"summary": "out/summary.md", "metrics": "out/metrics.json"}, artifacts,
                      error=f"Gmail send failed: {exc}")
        return

    _write_result("success", {
        "summary": "out/summary.md",
        "metrics": "out/metrics.json",
        "email_message_id": message_id,
        "recipient": recipient,
    }, artifacts, error=None)


if __name__ == "__main__":
    main()
