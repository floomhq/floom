"""Gmail Inbox Manager - clean, classify, summarize."""

import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Dict, Any
from urllib import request as urlrequest
from urllib.error import HTTPError, URLError

WORKER_DIR = Path(__file__).parent.resolve()
STATE_FILE = WORKER_DIR / "state.json"
RULES_FILE = Path.home() / ".agents/skills/gmail-inbox-manager/data/rules.yaml"
WORKEROS_API_URL_STR = os.environ.get("WORKEROS_API_URL", "https://workers-api.floom.dev").rstrip("/")
FLOOM_RUN_ID = os.environ.get("FLOOM_RUN_ID", "")
WORKEROS_RUN_TOKEN = os.environ.get("WORKEROS_RUN_TOKEN", "")


def _read_json_file(path: str, default):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def _read_connection_id() -> str:
    connections = _read_json_file("connections.json", {})
    return str(connections.get("gmail") or "").strip()


def _write_result(status: str, *, outputs=None, artifacts=None, error: str | None = None):
    payload = {"status": status}
    if outputs is not None:
        payload["outputs"] = outputs
    if artifacts is not None:
        payload["artifacts"] = artifacts
    if error:
        payload["error"] = error
    with open("result.json", "w") as f:
        json.dump(payload, f)


def load_rules():
    try:
        import yaml
        with open(RULES_FILE) as f:
            return yaml.safe_load(f) or {}
    except (ImportError, FileNotFoundError):
        return {"rules": [], "important_keywords": {"subjects": [], "domains": [], "senders": []}, "action_tags": []}


def load_state():
    if STATE_FILE.exists():
        with open(STATE_FILE) as f:
            return json.load(f)
    return {"processed_ids": [], "last_run": None}


def save_state(state):
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def composio_execute(slug, payload):
    if not FLOOM_RUN_ID:
        return {"successful": False, "error": "FLOOM_RUN_ID is not set"}
    connection_id = _read_connection_id()
    if not connection_id:
        return {"successful": False, "error": "Gmail connection is not active"}
    url = f"{WORKEROS_API_URL_STR}/runs/{FLOOM_RUN_ID}/composio-execute/{slug}"
    body = {
        "connected_account_id": connection_id,
        "arguments": payload,
    }
    headers = {"Content-Type": "application/json"}
    if WORKEROS_RUN_TOKEN:
        headers["X-Workeros-Run-Token"] = WORKEROS_RUN_TOKEN
    req = urlrequest.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urlrequest.urlopen(req, timeout=120) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        return {"successful": False, "error": f"Workeros proxy HTTP {exc.code}: {detail}"}
    except (URLError, TimeoutError, json.JSONDecodeError) as exc:
        return {"successful": False, "error": str(exc)}


def fetch_emails(query, max_results=50):
    resp = composio_execute("GMAIL_FETCH_EMAILS", {"query": query, "max_results": max_results})
    if not resp.get("successful"):
        return []
    if resp.get("storedInFile"):
        fp = resp.get("outputFilePath")
        if fp and Path(fp).exists():
            with open(fp) as f:
                fd = json.load(f)
            return fd.get("data", {}).get("messages", [])
    return resp.get("data", {}).get("messages", [])


def get_label_id(label_name):
    resp = composio_execute("GMAIL_LIST_LABELS", {})
    if not resp.get("successful"):
        return None
    labels = resp.get("data", {}).get("labels", [])
    for label in labels:
        if label["name"] == label_name:
            return label["id"]
    return None


def batch_modify_labels(msg_ids, add=None, remove=None):
    if not msg_ids:
        return 0
    batch_size = 100
    success = 0
    for i in range(0, len(msg_ids), batch_size):
        batch = msg_ids[i:i+batch_size]
        payload = {"messageIds": batch}
        if add:
            payload["addLabelIds"] = add
        if remove:
            payload["removeLabelIds"] = remove
        resp = composio_execute("GMAIL_BATCH_MODIFY_MESSAGES", payload)
        if resp.get("successful"):
            success += len(batch)
    return success


def parse_email(email):
    headers = {h["name"].lower(): h["value"] for h in email.get("payload", {}).get("headers", [])}
    from_addr = email.get("sender") or headers.get("from", "Unknown")
    subject = email.get("subject") or headers.get("subject", "(no subject)")
    date = headers.get("date", "")
    from_clean = re.sub(r"<.*?>", "", from_addr).strip()
    domain_match = re.search(r"@([^>\s]+)", from_addr)
    domain = domain_match.group(1) if domain_match else "unknown"
    return {
        "id": email.get("messageId", email.get("id")),
        "thread_id": email.get("threadId", email.get("messageId", email.get("id"))),
        "from": from_clean,
        "from_full": from_addr,
        "domain": domain.lower(),
        "subject": subject,
        "date": date,
        "body": email.get("messageText", ""),
        "labels": email.get("labelIds", []),
        "snippet": email.get("snippet", ""),
    }


def match_rule(email, rule):
    match = rule.get("match", {})
    if "from_contains" in match:
        patterns = match["from_contains"]
        if isinstance(patterns, str):
            patterns = [patterns]
        if not any(p.lower() in email["from_full"].lower() for p in patterns):
            return False
    if "subject_contains" in match:
        patterns = match["subject_contains"]
        if isinstance(patterns, str):
            patterns = [patterns]
        if not any(p.lower() in email["subject"].lower() for p in patterns):
            return False
    if "body_contains" in match:
        patterns = match["body_contains"]
        if isinstance(patterns, str):
            patterns = [patterns]
        body_lower = email["body"].lower()
        if not any(p.lower() in body_lower for p in patterns):
            return False
    if "older_than_days" in match:
        try:
            email_date = parse_email_date(email["date"])
            age_days = (datetime.now(timezone.utc) - email_date).days
            if age_days < match["older_than_days"]:
                return False
        except Exception:
            return False
    return True


def parse_email_date(date_str):
    formats = [
        "%a, %d %b %Y %H:%M:%S %z",
        "%d %b %Y %H:%M:%S %z",
        "%a, %d %b %Y %H:%M:%S %Z",
    ]
    for fmt in formats:
        try:
            return datetime.strptime(date_str, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    match = re.search(r"(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})", date_str)
    if match:
        return datetime.strptime(f"{match.group(1)} {match.group(2)} {match.group(3)}", "%d %b %Y").replace(tzinfo=timezone.utc)
    raise ValueError(f"Cannot parse date: {date_str}")


def classify_importance(email, rules):
    keywords = rules.get("important_keywords", {})
    subject_lower = email["subject"].lower()
    for kw in keywords.get("subjects", []):
        if kw.lower() in subject_lower:
            return "important"
    for domain in keywords.get("domains", []):
        if domain.lower() in email["domain"]:
            return "important"
    for sender in keywords.get("senders", []):
        if sender.lower() in email["from_full"].lower():
            return "important"
    if "CATEGORY_PERSONAL" in email["labels"]:
        return "important"
    return "fyi"


def get_action_tag(subject, action_tags):
    subject_lower = subject.lower()
    for tag_rule in action_tags:
        if tag_rule["keyword"].lower() in subject_lower:
            return tag_rule["tag"]
    return None


def generate_summary(today_str, cleaned, important, fyi, rules):
    action_tags = rules.get("action_tags", [])
    lines = [
        f"# Inbox Digest - {today_str}",
        "",
        "## Auto-cleaned today",
        "",
        "| Count | Type |",
        "|-------|------|",
        f"| {len(cleaned)} | Emails processed by rules |",
        "",
        "**What was cleaned:**",
    ]
    cleaned_by_action = defaultdict(list)
    for item in cleaned:
        cleaned_by_action[item["action_desc"]].append(item)
    for action_desc, items in sorted(cleaned_by_action.items()):
        count = len(items)
        if count == 1:
            e = items[0]["email"]
            lines.append(f"- {e['from'][:35]:35s} - {e['subject'][:50]} -> {action_desc}")
        else:
            e = items[0]["email"]
            lines.append(f"- {count}x {e['from'][:35]:35s} -> {action_desc}")
    lines.extend([
        "",
        "---",
        "",
        f"## Important - needs attention ({len(important)})",
        "",
    ])
    for item in important:
        e = item["email"]
        tag = get_action_tag(e["subject"], action_tags)
        lines.append(f"### {e['from']}")
        lines.append(f"**Subject:** {e['subject']}")
        if tag:
            lines.append(f"{tag}")
        if e["snippet"]:
            snippet = e["snippet"].replace("\r", " ").replace("\n", " ")[:120]
            lines.append(f"> {snippet}...")
        lines.append("")
    lines.extend([
        "---",
        "",
        f"## FYI - no action needed ({len(fyi)})",
        "",
        "| From | Subject |",
        "|------|---------|",
    ])
    for item in fyi:
        e = item["email"]
        lines.append(f"| {e['from'][:30]} | {e['subject'][:50]} |")
    lines.extend([
        "",
        "---",
        "",
        "## Today's Stats",
        "",
        "| Metric | Count |",
        "|--------|-------|",
        f"| Total emails processed | {len(cleaned) + len(important) + len(fyi)} |",
        f"| Auto-cleaned | {len(cleaned)} |",
        f"| Important | {len(important)} |",
        f"| FYI | {len(fyi)} |",
        "",
        "---",
        "*Generated by gmail-inbox-manager worker*",
        "",
    ])
    return "\n".join(lines)


def run(inputs: Dict[str, Any] | None = None, context: Dict[str, Any] | None = None) -> Dict[str, Any]:
    inputs = inputs or {}
    context = context or {}
    log = context.get("log") or (lambda message: print(message, file=sys.stderr))
    log("Starting Gmail inbox manager")

    rules = load_rules()
    state = load_state()
    processed_ids = set(state.get("processed_ids", []))

    today = datetime.now(timezone.utc)
    today_str = today.strftime("%A, %B %d, %Y")

    log("Fetching unread emails...")
    unread = fetch_emails("is:unread", max_results=100)
    log(f"Found {len(unread)} unread")

    yesterday = (today - timedelta(days=1)).strftime("%Y/%m/%d")
    log(f"Fetching emails since {yesterday}...")
    recent = fetch_emails(f"after:{yesterday}", max_results=100)
    log(f"Found {len(recent)} recent")

    all_messages = {m.get("messageId"): m for m in (unread + recent) if m.get("messageId")}

    cleaned = []
    important = []
    fyi = []
    rule_list = rules.get("rules", [])

    archive_ids = []
    read_ids = []
    label_requests = []

    for msg_id, msg in all_messages.items():
        if not msg_id:
            continue
        email = parse_email(msg)
        if msg_id in processed_ids and "UNREAD" not in email["labels"]:
            continue

        rule_matched = False
        for rule in rule_list:
            if match_rule(email, rule):
                action = rule.get("action")
                if action == "archive":
                    archive_ids.append(msg_id)
                    cleaned.append({"email": email, "rule": rule["name"], "action_desc": "archived"})
                elif action == "mark_read":
                    read_ids.append(msg_id)
                    cleaned.append({"email": email, "rule": rule["name"], "action_desc": "marked read"})
                elif action == "apply_label":
                    label_name = rule.get("label", "Processed")
                    label_id = get_label_id(label_name)
                    if label_id:
                        label_requests.append((msg_id, label_id))
                    cleaned.append({"email": email, "rule": rule["name"], "action_desc": f"labeled '{label_name}'"})
                processed_ids.add(msg_id)
                rule_matched = True
                break

        if rule_matched:
            continue

        classification = classify_importance(email, rules)
        if classification == "important":
            important.append({"email": email})
        else:
            fyi.append({"email": email})
        processed_ids.add(msg_id)

    # Batch apply actions
    if archive_ids:
        n = batch_modify_labels(archive_ids, remove=["INBOX"])
        log(f"Archived {n}/{len(archive_ids)} messages")
    if read_ids:
        n = batch_modify_labels(read_ids, remove=["UNREAD"])
        log(f"Marked {n}/{len(read_ids)} messages as read")
    if label_requests:
        by_label = defaultdict(list)
        for msg_id, label_id in label_requests:
            by_label[label_id].append(msg_id)
        for label_id, msg_ids in by_label.items():
            n = batch_modify_labels(msg_ids, add=[label_id])
            log(f"Labeled {n} messages")

    summary = generate_summary(today_str, cleaned, important, fyi, rules)

    artifact_dir = Path(context.get("artifact_dir") or "out")
    artifact_dir.mkdir(parents=True, exist_ok=True)
    summary_file = artifact_dir / "summary.md"
    summary_file.write_text(summary)
    log(f"Summary saved to {summary_file}")

    state["processed_ids"] = sorted(list(processed_ids))[-5000:]
    state["last_run"] = today.isoformat()
    save_state(state)

    return {
        "status": "success",
        "outputs": {"summary": str(summary_file)},
        "artifacts": [{"name": str(summary_file.name), "relative_path": str(summary_file), "type": "text/markdown"}],
    }


def main():
    inputs = _read_json_file("inputs.json", {})
    result = run(inputs, {"artifact_dir": "out"})
    _write_result(
        result.get("status", "success"),
        outputs=result.get("outputs"),
        artifacts=result.get("artifacts"),
        error=result.get("error"),
    )


if __name__ == "__main__":
    main()
