"""Slack listener — forwards @floom mentions to the workspace agent.

This is an example worker (is_example: true). Copy and customise it.

Requirements:
  - SLACK_BOT_TOKEN: Bot token with channels:history and chat:write scopes.
  - WORKEROS_API_SECRET: Same secret used by the Floom API.
  - WORKEROS_API_BASE: Floom API base URL (default: http://localhost:8000).
"""

import json
import os
import sys
import time
import urllib.parse
import urllib.request
import urllib.error

SLACK_TOKEN = os.environ["SLACK_BOT_TOKEN"]
API_SECRET = os.environ["WORKEROS_API_SECRET"]
API_BASE = os.environ.get("WORKEROS_API_BASE", "http://localhost:8000").rstrip("/")


def slack_get(path: str, params: dict | None = None) -> dict:
    url = f"https://slack.com/api/{path}"
    if params:
        qs = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
        url = f"{url}?{qs}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {SLACK_TOKEN}"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read())
    if not data.get("ok"):
        raise RuntimeError(f"Slack API error: {data.get('error')}")
    return data


def get_bot_user_id() -> str | None:
    try:
        data = slack_get("auth.test")
    except Exception as exc:
        print(f"[warn] Could not resolve Slack bot user id: {exc}", file=sys.stderr)
        return None
    return data.get("user_id") or data.get("bot_id")


def is_addressed_to_bot(text: str, bot_user_id: str | None) -> bool:
    lowered = text.lower()
    if "@floom" in lowered or "<!here>" in text:
        return True
    return bool(bot_user_id and f"<@{bot_user_id}>" in text)


def clean_user_question(text: str, bot_user_id: str | None) -> str:
    cleaned = text.replace("@floom", "").replace("@Floom", "").replace("<!here>", "")
    if bot_user_id:
        cleaned = cleaned.replace(f"<@{bot_user_id}>", "")
    return cleaned.strip()


def thread_has_bot_reply(channel: str, thread_ts: str, bot_user_id: str | None) -> bool:
    if not bot_user_id:
        return False
    try:
        data = slack_get(
            "conversations.replies",
            {"channel": channel, "ts": thread_ts, "limit": 20},
        )
    except Exception as exc:
        print(f"[warn] Could not inspect Slack thread {thread_ts}: {exc}", file=sys.stderr)
        return False
    for reply in data.get("messages") or []:
        if reply.get("ts") == thread_ts:
            continue
        if reply.get("user") == bot_user_id or reply.get("bot_id") == bot_user_id:
            return True
    return False


def slack_post(channel: str, thread_ts: str, text: str) -> None:
    payload = json.dumps({
        "channel": channel,
        "thread_ts": thread_ts,
        "text": text,
    }).encode()
    req = urllib.request.Request(
        "https://slack.com/api/chat.postMessage",
        data=payload,
        headers={
            "Authorization": f"Bearer {SLACK_TOKEN}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        result = json.loads(resp.read())
    if not result.get("ok"):
        print(f"[warn] Slack post failed: {result.get('error')}", file=sys.stderr)


def workspace_chat(message: str, conversation_id: str | None = None) -> dict:
    """Call POST /chat and collect SSE parts into a result dict."""
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
        buffer = ""
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


def process_messages(messages: list[dict], channel: str, bot_user_id: str | None) -> list[dict]:
    processed = []
    for msg in messages:
        text = msg.get("text") or ""
        if msg.get("user") == bot_user_id:
            continue
        if not is_addressed_to_bot(text, bot_user_id):
            continue
        thread_ts = msg.get("thread_ts") or msg.get("ts")
        if not thread_ts:
            continue
        if thread_has_bot_reply(channel, thread_ts, bot_user_id):
            processed.append({"ts": thread_ts, "question": text[:60], "replied": False, "skipped": "already_replied"})
            continue
        user_question = clean_user_question(text, bot_user_id)
        if not user_question:
            continue

        print(f"Processing Slack mention: {user_question[:80]}")
        try:
            result = workspace_chat(user_question, conversation_id=None)
            reply = result["reply"] or "(No reply)"
            slack_post(channel, thread_ts, reply)
            processed.append({"ts": thread_ts, "question": user_question[:60], "replied": True})
        except Exception as exc:
            print(f"[error] Failed to process mention: {exc}", file=sys.stderr)
            processed.append({"ts": thread_ts, "question": user_question[:60], "replied": False, "error": str(exc)})
    return processed


def main() -> None:
    inputs_path = os.path.join(os.environ.get("FLOOM_INPUT_DIR", "."), "inputs.json")
    with open(inputs_path) as f:
        inputs = json.load(f)

    channel = str(
        inputs.get("channel")
        or os.environ.get("SLACK_LISTENER_CHANNEL_ID")
        or os.environ.get("SLACK_CHANNEL_ID")
        or os.environ.get("SLACK_DEFAULT_CHANNEL")
        or ""
    ).strip()
    lookback_minutes = int(inputs.get("lookback_minutes") or 10)
    if not channel:
        output_dir = os.environ.get("FLOOM_OUTPUT_DIR", ".")
        os.makedirs(output_dir, exist_ok=True)
        summary_md = (
            "# Slack Listener Run\n\n"
            "- Status: skipped\n"
            "- Reason: no Slack channel configured\n\n"
            "Set `SLACK_LISTENER_CHANNEL_ID` or save a `channel` input value to enable scheduled polling.\n"
        )
        with open(os.path.join(output_dir, "summary.md"), "w") as f:
            f.write(summary_md)
        print(json.dumps({
            "summary": "Skipped Slack Listener run: no Slack channel configured.",
            "processed": [],
            "skipped": "no_channel_configured",
        }))
        return

    oldest = time.time() - lookback_minutes * 60
    data = slack_get("conversations.history", {"channel": channel, "oldest": str(oldest), "limit": 50})
    messages = data.get("messages") or []
    bot_user_id = get_bot_user_id()
    processed = process_messages(messages, channel, bot_user_id)

    output_dir = os.environ.get("FLOOM_OUTPUT_DIR", ".")
    out = {
        "summary": f"Processed {len(processed)} @floom mention(s) in channel {channel}.",
        "processed": processed,
    }
    summary_md = f"# Slack Listener Run\n\n- Channel: {channel}\n- Mentions processed: {len(processed)}\n"
    for item in processed:
        status = item.get("skipped") or ("replied" if item.get("replied") else f"FAILED: {item.get('error')}")
        summary_md += f"  - `{item['question']}` → {status}\n"

    os.makedirs(output_dir, exist_ok=True)
    with open(os.path.join(output_dir, "summary.md"), "w") as f:
        f.write(summary_md)
    print(json.dumps(out))


if __name__ == "__main__":
    main()
