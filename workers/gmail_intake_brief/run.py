"""Gmail Intake Brief — E2B-native worker.

Fetches recent emails via Composio Gmail integration and returns a markdown summary.
Reads inputs.json and secrets from .env.local (python-dotenv), connections.json. Writes result.json.
Falls back to secrets.json for backward-compat during transition period.

connections.json contains: {"gmail": "<composio_connection_id>"}
.env.local contains: OPENAI_API_KEY=... COMPOSIO_API_KEY=...
"""

from __future__ import annotations

import json
import os

try:
    from dotenv import load_dotenv
    load_dotenv(".env.local")
except ImportError:
    pass  # dotenv optional; secrets.json fallback covers transition


def _write_error(error: str) -> None:
    with open("result.json", "w") as f:
        json.dump({"status": "error", "error": error}, f)


def _secrets_fallback() -> dict:
    """Load secrets.json for backward-compat when dotenv import failed."""
    try:
        with open("secrets.json") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def main():
    with open("inputs.json") as f:
        inputs = json.load(f)

    _secrets_fb = _secrets_fallback()

    try:
        with open("connections.json") as f:
            connections = json.load(f)
    except FileNotFoundError:
        connections = {}

    query = str(inputs.get("query") or "is:unread").strip()
    max_results = int(inputs.get("max_results") or 5)

    composio_api_key = os.environ.get("COMPOSIO_API_KEY") or _secrets_fb.get("COMPOSIO_API_KEY", "")
    openai_api_key = os.environ.get("OPENAI_API_KEY") or _secrets_fb.get("OPENAI_API_KEY", "")

    if not composio_api_key:
        _write_error("COMPOSIO_API_KEY not set")
        return

    # Get the Gmail connection ID from connections.json
    gmail_conn_id = connections.get("gmail", "")
    if not gmail_conn_id:
        _write_error("Gmail connection not found — ensure 'gmail' is in connections.json")
        return

    emails = _fetch_emails(gmail_conn_id, composio_api_key, query, max_results)

    if not emails:
        summary = f"No emails found for query `{query}`."
    elif openai_api_key:
        summary = _summarize_with_openai(emails, openai_api_key, query)
    else:
        summary = _plain_summary(emails, query)

    result = {
        "status": "success",
        "outputs": {"summary": summary},
        "artifacts": [],
    }
    with open("result.json", "w") as f:
        json.dump(result, f)


def _fetch_emails(conn_id: str, api_key: str, query: str, max_results: int) -> list:
    """Fetch emails via Composio v3 tool execute endpoint (no SDK dependency)."""
    import requests

    url = "https://backend.composio.dev/api/v3/tools/execute/GMAIL_FETCH_EMAILS"
    headers = {"x-api-key": api_key, "Content-Type": "application/json"}
    body = {
        "user_id": "federico",
        "arguments": {
            "max_results": min(max_results, 50),
            "query": query,
            "include_attachments": False,
        },
    }
    try:
        r = requests.post(url, headers=headers, json=body, timeout=30)
        r.raise_for_status()
        messages = (r.json().get("data") or {}).get("messages") or []
        normalized = []
        for m in messages:
            hdrs = (m.get("payload") or {}).get("headers") or []
            subject = next((h["value"] for h in hdrs if h.get("name") == "Subject"), "(no subject)")
            sender = next((h["value"] for h in hdrs if h.get("name") == "From"), "unknown")
            snippet = (m.get("messageText") or "")[:400]
            normalized.append({
                "subject": subject,
                "from": sender,
                "snippet": snippet,
                "message_id": m.get("messageId"),
            })
        return normalized
    except Exception:
        return []


def _summarize_with_openai(emails: list, api_key: str, query: str) -> str:
    """Summarize emails using OpenAI."""
    try:
        import openai

        items = []
        for i, msg in enumerate(emails[:50], 1):
            subject = msg.get("subject") or "(no subject)"
            sender = msg.get("from") or "unknown"
            snippet = msg.get("snippet") or msg.get("body_plain", "")[:300]
            items.append(f"{i}. **From:** {sender}  \n   **Subject:** {subject}  \n   **Preview:** {snippet}")

        email_text = "\n\n".join(items)
        prompt = (
            f"Summarize these {len(emails)} email(s) matching the Gmail query `{query}` "
            "into a concise markdown digest. Group related threads, highlight action items, "
            "and flag anything urgent.\n\n"
            f"EMAILS:\n{email_text}"
        )

        client = openai.OpenAI(api_key=api_key)
        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=1024,
        )
        return resp.choices[0].message.content or _plain_summary(emails, query)
    except Exception:
        return _plain_summary(emails, query)


def _plain_summary(emails: list, query: str) -> str:
    """Fallback: plain markdown list without LLM."""
    lines = [f"## Gmail Brief — `{query}`\n", f"**{len(emails)} email(s) found:**\n"]
    for msg in emails:
        subject = msg.get("subject") or "(no subject)"
        sender = msg.get("from") or "unknown"
        snippet = (msg.get("snippet") or msg.get("body_plain", ""))[:150]
        lines.append(f"- **{subject}**  \n  From: {sender}  \n  {snippet}")
    return "\n\n".join(lines)


if __name__ == "__main__":
    main()
