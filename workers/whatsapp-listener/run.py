"""WhatsApp listener — forwards messages to the workspace agent.

This is an example worker (is_example: true). Copy and customise it.

Requirements:
  - COMPOSIO_API_KEY: Composio API key with WHATSAPP connected.
  - WORKEROS_API_SECRET: Same secret used by the Workeros API.
  - WORKEROS_API_BASE: Workeros API base URL (default: http://localhost:8000).
"""

import json
import os
import sys
import time
import urllib.request

API_SECRET = os.environ["WORKEROS_API_SECRET"]
API_BASE = os.environ.get("WORKEROS_API_BASE", "http://localhost:8000").rstrip("/")
COMPOSIO_API_KEY = os.environ.get("COMPOSIO_API_KEY", "")
ENTITY_ID = os.environ.get("FLOOM_USER_ID", "federico")


def composio_execute(tool: str, arguments: dict, connected_account_id: str) -> dict:
    payload = json.dumps({
        "connected_account_id": connected_account_id,
        "entity_id": ENTITY_ID,
        "arguments": arguments,
    }).encode()
    req = urllib.request.Request(
        f"https://backend.composio.dev/api/v3/tools/execute/{tool}",
        data=payload,
        headers={
            "x-api-key": COMPOSIO_API_KEY,
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def get_whatsapp_connection_id() -> str | None:
    """Get the active WhatsApp connection ID from Workeros."""
    req = urllib.request.Request(
        f"{API_BASE}/connections",
        headers={"x-floom-secret": API_SECRET},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        connections = json.loads(resp.read())
    for conn in connections:
        if conn.get("app_name", "").lower() == "whatsapp" and conn.get("status") == "active":
            return conn.get("id")
    return None


def workspace_chat(message: str, conversation_id: str | None = None) -> dict:
    """Call POST /chat and collect the reply."""
    body = {"message": message}
    if conversation_id:
        body["conversation_id"] = conversation_id
    payload = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{API_BASE}/chat",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "x-floom-secret": API_SECRET,
        },
    )
    text_parts = []
    new_conv_id = conversation_id
    with urllib.request.urlopen(req, timeout=90) as resp:
        for raw in resp:
            line = raw.decode("utf-8", errors="replace")
            if line.startswith("data:"):
                try:
                    part = json.loads(line[5:].strip())
                except json.JSONDecodeError:
                    continue
                if part.get("type") == "text":
                    text_parts.append(part.get("text") or "")
                elif part.get("type") == "finish":
                    new_conv_id = part.get("conversation_id") or new_conv_id
                    break
    return {"reply": "".join(text_parts), "conversation_id": new_conv_id}


def main() -> None:
    inputs_path = os.path.join(os.environ.get("FLOOM_INPUT_DIR", "."), "inputs.json")
    with open(inputs_path) as f:
        inputs = json.load(f)

    lookback_minutes = int(inputs.get("lookback_minutes") or 10)
    connection_id = get_whatsapp_connection_id()
    if not connection_id:
        print("ERROR: No active WhatsApp connection found", file=sys.stderr)
        sys.exit(1)

    # List recent messages via Composio
    cutoff_ts = int(time.time() - lookback_minutes * 60)
    try:
        result = composio_execute(
            "WHATSAPP_GET_MESSAGES",
            {"limit": 20},
            connection_id,
        )
        messages = result.get("data", {}).get("messages") or []
    except Exception as exc:
        print(f"[error] Failed to fetch WhatsApp messages: {exc}", file=sys.stderr)
        messages = []

    processed = []
    for msg in messages:
        # Skip outgoing messages
        if msg.get("fromMe"):
            continue
        msg_ts = int(msg.get("timestamp") or 0)
        if msg_ts < cutoff_ts:
            continue
        body = msg.get("body") or ""
        sender = msg.get("from") or ""
        if not body.strip():
            continue

        print(f"Processing WhatsApp from {sender}: {body[:80]}")
        try:
            result = workspace_chat(body, conversation_id=None)
            reply = result["reply"] or "(No reply)"
            # Send reply back
            composio_execute(
                "WHATSAPP_SEND_MESSAGE",
                {"number": sender, "message": reply},
                connection_id,
            )
            processed.append({"from": sender, "question": body[:60], "replied": True})
        except Exception as exc:
            print(f"[error] Failed to process message: {exc}", file=sys.stderr)
            processed.append({"from": sender, "question": body[:60], "replied": False, "error": str(exc)})

    output_dir = os.environ.get("FLOOM_OUTPUT_DIR", ".")
    summary_md = f"# WhatsApp Listener Run\n\n- Messages processed: {len(processed)}\n"
    for item in processed:
        status = "replied" if item.get("replied") else f"FAILED: {item.get('error')}"
        summary_md += f"  - `{item['from']}`: {item['question']} → {status}\n"

    os.makedirs(output_dir, exist_ok=True)
    with open(os.path.join(output_dir, "summary.md"), "w") as f:
        f.write(summary_md)
    print(json.dumps({"summary": f"Processed {len(processed)} WhatsApp message(s).", "processed": processed}))


if __name__ == "__main__":
    main()
