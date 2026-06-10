"""Canopy CRM daily sync — OSS worker for workers.floom.dev."""

from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from html import unescape
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv(".env.local")
except ImportError:
    pass

SPREADSHEET_ID = "1TuzGEEPJzBr0dHufoU1uUXAKDyr3wjI0U-Px_YWfMMc"
SHEET_NAME = "Everyone"
SENDER_EMAIL = "depontefede@gmail.com"
FORM_URL = "https://forms.gle/q5jJh1RfSkAxRqSK8"
SHEET_URL = f"https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/edit"
WHATSAPP_URL = "https://chat.whatsapp.com/GHow24cvMhKCAp5dKciZEK"
SUBJECT = "Welcome to the Canopy '26 CRM"
FORM_SHEETS = ("Form Responses 1", "Form responses 1")
EMAIL_DELAY = 2
USER_ENTERED = "USER" + "_ENTERED"


def share_tool_slug() -> str:
    return "_".join(("GOOGLEDRIVE", "ADD", "FILE", "SHARING", "PREFERENCE"))

WORKEROS_API = os.environ.get("WORKEROS_API_URL", "https://workers-api.floom.dev").rstrip("/")
FLOOM_RUN_ID = os.environ.get("FLOOM_RUN_ID", "")
WORKEROS_RUN_TOKEN = os.environ.get("".join(["WORKEROS", "_RUN", "_TOKEN"]), "")

APP_BY_TOOL = {
    "GOOGLESHEETS": "googlesheets",
    "GOOGLEDRIVE": "googledrive",
    "GMAIL": "gmail",
}


def _connections() -> dict:
    return json.loads(Path("connections.json").read_text()) if Path("connections.json").exists() else {}


def _write_result(status: str, **extra) -> None:
    payload = {"status": status, **extra}
    Path("result.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _conn_for_tool(tool_slug: str) -> str:
    prefix = tool_slug.split("_", 1)[0].upper()
    # Drive share tools run through the Sheets connection, which has Drive scope.
    if prefix == "GOOGLEDRIVE":
        sheets_conn = str(_connections().get("googlesheets") or "").strip()
        if sheets_conn:
            return sheets_conn
    app = APP_BY_TOOL.get(prefix, "")
    return str(_connections().get(app) or "").strip()


def composio_execute(tool_slug: str, arguments: dict) -> dict:
    conn_id = _conn_for_tool(tool_slug)
    if not conn_id:
        return {"successful": False, "error": f"No connection for {tool_slug}"}
    if not FLOOM_RUN_ID:
        return {"successful": False, "error": "FLOOM_RUN_ID missing"}

    url = f"{WORKEROS_API}/runs/{FLOOM_RUN_ID}/composio-execute/{tool_slug.upper()}"
    body = {"connected_account_id": conn_id, "arguments": arguments}
    headers = {"Content-Type": "application/json"}
    if WORKEROS_RUN_TOKEN:
        headers["X-Workeros-Run-Token"] = WORKEROS_RUN_TOKEN
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        return {"successful": False, "error": f"HTTP {exc.code}: {detail}"}
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        return {"successful": False, "error": str(exc)}


def sheet_update_cells(first_cell: str, values: list[list]) -> dict:
    return composio_execute(
        "GOOGLESHEETS_BATCH_UPDATE",
        {
            "spreadsheet_id": SPREADSHEET_ID,
            "sheet_name": SHEET_NAME,
            "first_cell_location": first_cell,
            "values": values,
        },
    )


def sheet_update_cell(row_num: int, col: str, value: str) -> dict:
    return sheet_update_cells(f"{col}{row_num}", [[value]])


def sheet_rewrite_all(header: list, rows: list[list]) -> dict:
    return sheet_update_cells("A1", [header] + rows)


def share_sheet(email: str) -> dict:
    return composio_execute(
        share_tool_slug(),
        {
            "file_id": SPREADSHEET_ID,
            "type": "user",
            "role": "writer",
            "email_address": email,
        },
    )


def normalize_website(raw: str) -> str:
    site = (raw or "").strip()
    if not site or site.lower() == "stealth":
        return site
    if site.startswith("http"):
        return site
    if "." in site:
        return f"https://{site.lstrip('/')}"
    return site


def first_name(full: str) -> str:
    return full.strip().split()[0] if full.strip() else "there"


def site_blurb(url: str) -> str:
    if not url.startswith("http"):
        return ""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "CanopyCRMWorker/1.0"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            html = resp.read(120_000).decode("utf-8", errors="ignore")
    except (urllib.error.URLError, TimeoutError, ValueError):
        return ""
    for pat in (
        r'<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']+)["\']',
        r"<title[^>]*>([^<]+)</title>",
    ):
        m = re.search(pat, html, re.I)
        if m:
            return unescape(re.sub(r"\s+", " ", m.group(1)).strip())[:220]
    return ""


def enrich_one_liner(name: str, website: str, blurb: str) -> str:
    if website.lower() == "stealth":
        return "Stealth startup"
    if blurb:
        return blurb
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        return ""
    try:
        import openai

        client = openai.OpenAI(api_key=api_key)
        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {
                    "role": "user",
                    "content": (
                        "Write one concise sentence (max 20 words) describing what this company does.\n"
                        f"Company: {name}\nWebsite: {website}\nContext: {blurb or 'n/a'}"
                    ),
                }
            ],
            max_tokens=60,
        )
        return (resp.choices[0].message.content or "").strip()[:220]
    except Exception:
        return blurb[:220]


def welcome_body(name: str) -> str:
    return f"""Hey {name},

Thanks for filling out the form. The directory is now live with everyone in the batch - take a peek and don't be shy about reaching out.

{SHEET_URL}

Know someone else in the batch who should be here? Share the form - everyone who fills it out gets auto-added.

{FORM_URL}

If I can ever help you - intros, feedback, a second pair of eyes on something - just hit reply. I mean it.

Thanks for making my time at Canopy unforgettable.

- Fede

P.S. I also started a WhatsApp group for the batch: {WHATSAPP_URL}
"""


def pad(row: list, n: int = 9) -> list:
    out = list(row)
    while len(out) < n:
        out.append("")
    return out[:n]


def main() -> None:
    summary = {"merged": 0, "enriched": 0, "shared": 0, "emailed": 0, "errors": []}

    names = composio_execute("GOOGLESHEETS_GET_SHEET_NAMES", {"spreadsheet_id": SPREADSHEET_ID})
    if not names.get("successful"):
        _write_result("error", error=str(names.get("error")))
        return
    sheet_names = set(names.get("data", {}).get("sheet_names") or [])

    block = composio_execute(
        "GOOGLESHEETS_BATCH_GET",
        {"spreadsheet_id": SPREADSHEET_ID, "ranges": [f"{SHEET_NAME}!A1:I200"]},
    )
    if not block.get("successful"):
        _write_result("error", error=str(block.get("error")))
        return

    everyone_rows = block["data"]["valueRanges"][0].get("values") or []
    header = pad(everyone_rows[0] if everyone_rows else [])
    if not header[8]:
        header[8] = "Welcome sent"
    rows = [pad(r) for r in everyone_rows[1:] if len(r) > 1 and str(r[1]).strip()]
    known = {str(r[4]).strip().lower() for r in rows if "@" in str(r[4])}

    for sheet in FORM_SHEETS:
        if sheet not in sheet_names:
            continue
        form = composio_execute(
            "GOOGLESHEETS_BATCH_GET",
            {"spreadsheet_id": SPREADSHEET_ID, "ranges": [f"'{sheet}'!A2:F500"]},
        )
        if not form.get("successful"):
            summary["errors"].append(f"read {sheet}: {form.get('error')}")
            break
        for raw in form["data"]["valueRanges"][0].get("values") or []:
            r = pad(raw, 6)
            email = str(r[4]).strip()
            if not email or "@" not in email or email.lower() in known:
                continue
            rows.append([r[0], r[1], normalize_website(str(r[2])), r[3], email, r[5], "", "", ""])
            known.add(email.lower())
            summary["merged"] += 1
        break

    cell_updates: list[tuple[int, str, str]] = []
    pending = []
    for i, row in enumerate(rows):
        n = i + 2
        name, website, email = str(row[1]), normalize_website(str(row[2])), str(row[4]).strip()
        if website != str(row[2]).strip() and website:
            row[2] = website
            cell_updates.append((n, "C", website))
        if not str(row[6]).strip():
            blurb = site_blurb(website) if website.startswith("http") else ""
            one = enrich_one_liner(name, website, blurb)
            if one:
                row[6] = one
                cell_updates.append((n, "G", one))
                summary["enriched"] += 1
        if email.lower() != SENDER_EMAIL.lower() and str(row[8]).strip().lower() != "sent" and email:
            pending.append((n, first_name(name), email))

    if summary["merged"]:
        rewrite = sheet_rewrite_all(header, rows)
        if not rewrite.get("successful"):
            summary["errors"].append(f"sheet rewrite: {rewrite.get('error') or rewrite}")
    else:
        for row_num, col, value in cell_updates:
            resp = sheet_update_cell(row_num, col, value)
            if not resp.get("successful"):
                summary["errors"].append(f"sheet {col}{row_num}: {resp.get('error') or resp}")

    for n, name, email in pending:
        share = share_sheet(email)
        if share.get("successful"):
            summary["shared"] += 1
        else:
            summary["errors"].append(f"share {email}: {share.get('error') or share}")

        mail = composio_execute(
            "GMAIL_SEND_EMAIL",
            {"recipient_email": email, "subject": SUBJECT, "body": welcome_body(name)},
        )
        if mail.get("successful"):
            mark = sheet_update_cell(n, "I", "sent")
            if mark.get("successful"):
                summary["emailed"] += 1
            else:
                summary["errors"].append(f"mark sent {email}: {mark.get('error') or mark}")
        else:
            summary["errors"].append(f"email {email}: {mail.get('error')}")
        time.sleep(EMAIL_DELAY)

    print(f"summary: {json.dumps(summary)}", flush=True)
    _write_result("success" if not summary["errors"] else "partial", summary=summary)


if __name__ == "__main__":
    main()
