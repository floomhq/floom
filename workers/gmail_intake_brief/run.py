"""Gmail Intake Brief — E2B-native worker.

Fetches recent emails via the Floom Composio proxy and returns a markdown summary.
Reads inputs.json and secrets from .env.local (python-dotenv), connections.json.
Writes result.json.

connections.json contains: {"gmail": "<composio_connection_id>"}
Calls POST https://localhost:8000/runs/{FLOOM_RUN_ID}/composio-execute/GMAIL_FETCH_EMAILS
so COMPOSIO_API_KEY never needs to be in the sandbox.
"""

from __future__ import annotations

import json
import os

try:
    from dotenv import load_dotenv
    load_dotenv(".env.local")
except ImportError:
    pass  # dotenv optional


_WORKEROS_API = os.environ.get("WORKEROS_API_URL", "https://localhost:8000")
_RUN_ID = os.environ.get("FLOOM_RUN_ID", "")
_RUN_TOKEN = os.environ.get("WORKEROS_RUN_TOKEN", "")


def _write_error(error: str) -> None:
    with open("result.json", "w") as f:
        json.dump({"status": "error", "error": error}, f)


def main():
    with open("inputs.json") as f:
        inputs = json.load(f)

    try:
        with open("connections.json") as f:
            connections = json.load(f)
    except FileNotFoundError:
        connections = {}

    query = str(inputs.get("query") or "is:unread").strip()
    max_results = int(inputs.get("max_results") or 5)

    openai_api_key = os.environ.get("OPENAI_API_KEY", "").strip()

    # Get the Gmail connection ID from connections.json
    gmail_conn_id = connections.get("gmail", "")
    if not gmail_conn_id:
        _write_error("Gmail connection not found — ensure 'gmail' is connected at /connections")
        return

    if not _RUN_ID:
        _write_error("FLOOM_RUN_ID not set — cannot call Composio proxy")
        return

    emails = _fetch_emails_via_proxy(gmail_conn_id, query, max_results)

    if not emails:
        summary = f"## Gmail Brief — `{query}`\n\nNo emails matched the query. Your inbox is clear or no messages match the filter.\n\n---\n*Run completed at {__import__('datetime').datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}*"
    elif openai_api_key:
        summary = _summarize_with_openai(emails, openai_api_key, query)
    else:
        summary = _plain_summary(emails, query)

    import os as _os
    _os.makedirs("out", exist_ok=True)
    with open("out/summary.md", "w") as f:
        f.write(summary)

    result = {
        "status": "success",
        "outputs": {"summary": "out/summary.md"},
        "artifacts": [{"name": "out/summary.md", "relative_path": "out/summary.md", "type": "text/markdown"}],
    }
    with open("result.json", "w") as f:
        json.dump(result, f)


def _fetch_emails_via_proxy(conn_id: str, query: str, max_results: int) -> list:
    """Fetch emails via the Floom Composio proxy endpoint.

    The proxy lives at POST /runs/{run_id}/composio-execute/GMAIL_FETCH_EMAILS
    and uses the server-side COMPOSIO_API_KEY. The sandbox doesn't need it.
    """
    import requests

    url = f"{_WORKEROS_API}/runs/{_RUN_ID}/composio-execute/GMAIL_FETCH_EMAILS"
    body = {
        "connected_account_id": conn_id,
        "arguments": {
            "max_results": min(max_results, 50),
            "query": query,
            "include_attachments": False,
        },
    }
    try:
        run_headers = {"X-Floom-Run-Token": _RUN_TOKEN} if _RUN_TOKEN else {}
        r = requests.post(url, json=body, headers=run_headers, timeout=30)
        r.raise_for_status()
        payload = r.json()
        messages = (payload.get("data") or {}).get("messages") or []
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
