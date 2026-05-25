"""Gmail Intake Brief worker.

Fetches recent emails via Composio Gmail integration and returns a markdown summary.

Context requirements:
  context.connections.gmail  → Composio connection ID for the user's Gmail
  context.secrets["OPENAI_API_KEY"]   → for summarization (optional)
  context.secrets["COMPOSIO_API_KEY"] → injected by runner from env
"""

from __future__ import annotations

import os


def run(inputs: dict, context) -> dict:
    query = str(inputs.get("query") or "is:unread").strip()
    max_results = int(inputs.get("max_results") or 5)

    composio_api_key = os.environ.get("COMPOSIO_API_KEY") or context.secrets.get("COMPOSIO_API_KEY", "")
    openai_api_key = context.secrets.get("OPENAI_API_KEY", "")

    if not composio_api_key:
        return {"status": "error", "error": "COMPOSIO_API_KEY not set"}

    # Get the Gmail connection ID from context
    gmail_conn_id = context.connections.gmail
    context.log(f"Using Gmail connection: {gmail_conn_id[:8]}...", level="info")

    # Fetch emails via Composio
    emails = _fetch_emails(gmail_conn_id, composio_api_key, query, max_results, context)

    if not emails:
        summary = f"No emails found for query `{query}`."
    elif openai_api_key:
        summary = _summarize_with_openai(emails, openai_api_key, query, context)
    else:
        summary = _plain_summary(emails, query)

    context.log(f"Summarized {len(emails)} email(s)", level="info")
    return {"status": "success", "outputs": {"summary": summary}}


def _fetch_emails(conn_id: str, api_key: str, query: str, max_results: int, context) -> list:
    """Fetch emails via Composio GMAIL_FETCH_EMAILS action."""
    try:
        from composio import ComposioToolSet, Action  # type: ignore

        toolset = ComposioToolSet(api_key=api_key, entity_id=conn_id)
        result = toolset.execute_action(
            action=Action.GMAIL_FETCH_EMAILS,
            params={
                "max_results": min(max_results, 50),
                "query": query,
                "include_attachments": False,
            },
        )
        if not result.get("successful"):
            context.log(f"Composio fetch error: {result.get('error')}", level="error")
            return []
        return result.get("data", {}).get("messages", []) or []
    except ImportError:
        context.log("composio package not installed — returning mock email", level="warning")
        return [
            {
                "subject": "Test email",
                "from": "test@example.com",
                "snippet": "This is a test email because composio SDK is not installed.",
            }
        ]
    except Exception as exc:
        context.log(f"Failed to fetch emails: {exc}", level="error")
        return []


def _summarize_with_openai(emails: list, api_key: str, query: str, context) -> str:
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
    except Exception as exc:
        context.log(f"OpenAI summarization failed: {exc} — falling back to plain summary", level="warning")
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
