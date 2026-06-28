"""Durable worker rules learned from approval rejection feedback."""

from __future__ import annotations

import hashlib
import json
import logging
import re
from pathlib import Path
from typing import Any, Iterable, Optional

from db import Repositories, derive_workspace_id, now_iso
from models import WorkerConfig, default_worker_memory_context_name

logger = logging.getLogger("floom.api")

RULES_SOURCE_APPROVAL_REJECTION = "approval_rejection"
APPROVAL_RULES_MD = "APPROVAL_RULES.md"
APPROVAL_RULES_AUDIT_JSONL = "approval-rules.jsonl"
_MAX_RULE_TEXT_CHARS = 6000


def rejection_feedback_scope(value: str | None) -> str:
    text = (value or "asset").strip().lower()
    if text not in {"asset", "global"}:
        raise ValueError("feedback scope must be 'asset' or 'global'")
    return text


def rejection_feedback_text(
    *,
    reason: str | None,
    annotations: dict[str, Any] | None,
) -> str:
    parts: list[str] = []
    reason_text = _clean_feedback_part(reason)
    if reason_text:
        parts.append(reason_text)
    for item in _annotation_feedback_parts(annotations):
        if item and item not in parts:
            parts.append(item)
    return "\n\n".join(parts).strip()[:_MAX_RULE_TEXT_CHARS]


def record_rejection_feedback_rule(
    *,
    repos: Repositories,
    owner_id: str,
    worker_id: str | None,
    workspace_id: str | None,
    approval_id: str | None,
    run_id: str | None,
    reason: str | None,
    annotations: dict[str, Any] | None,
    scope: str | None,
    approval_kind: str | None = None,
) -> dict[str, Any] | None:
    if rejection_feedback_scope(scope) != "global":
        return None
    worker_id = (worker_id or "").strip()
    if not worker_id:
        return None
    rule_text = rejection_feedback_text(reason=reason, annotations=annotations)
    if not rule_text:
        return None
    safe_workspace_id = (workspace_id or "").strip() or _workspace_id_for_worker(
        repos=repos,
        owner_id=owner_id,
        worker_id=worker_id,
    )
    rule_hash = _rule_hash(rule_text)
    rule_id = f"wrule_{rule_hash[:24]}"
    created_at = now_iso()

    repo = getattr(repos, "worker_rules", None)
    if repo is None or not callable(getattr(repo, "upsert", None)):
        logger.warning("worker_rules repository unavailable; cannot persist approval feedback rule")
        return None
    row = repo.upsert(
        rule_id=rule_id,
        workspace_id=safe_workspace_id,
        worker_id=worker_id,
        rule_text=rule_text,
        rule_hash=rule_hash,
        source=RULES_SOURCE_APPROVAL_REJECTION,
        source_ref=approval_id,
        run_id=run_id,
        approval_id=approval_id,
        created_by=owner_id,
        created_at=created_at,
    )
    _sync_worker_rules_brain(
        repos=repos,
        owner_id=owner_id,
        workspace_id=safe_workspace_id,
        worker_id=worker_id,
    )
    return {
        **row,
        "scope": "global",
        "approval_kind": approval_kind,
    }


def active_worker_rules_prompt_block(
    *,
    repos: Repositories,
    worker_id: str,
    user_id: str | None = None,
    workspace_id: str | None = None,
) -> str:
    rows = list_active_worker_rules(
        repos=repos,
        worker_id=worker_id,
        user_id=user_id,
        workspace_id=workspace_id,
    )
    if not rows:
        return ""
    lines = [
        "## Worker feedback rules",
        "",
        "Apply these durable worker-level rules learned from prior human rejections:",
        "",
    ]
    for idx, row in enumerate(rows, start=1):
        text = str(row.get("rule_text") or "").strip()
        if text:
            lines.append(f"{idx}. {text}")
    return "\n".join(lines).strip()


def list_active_worker_rules(
    *,
    repos: Repositories,
    worker_id: str,
    user_id: str | None = None,
    workspace_id: str | None = None,
) -> list[dict[str, Any]]:
    repo = getattr(repos, "worker_rules", None)
    if repo is None or not callable(getattr(repo, "list_active", None)):
        return []
    safe_workspace_id = (workspace_id or "").strip() or _workspace_id_for_worker(
        repos=repos,
        owner_id=user_id or "",
        worker_id=worker_id,
    )
    return repo.list_active(workspace_id=safe_workspace_id, worker_id=worker_id)


def _workspace_id_for_worker(*, repos: Repositories, owner_id: str, worker_id: str) -> str:
    worker_row: dict[str, Any] | None = None
    try:
        worker_row = repos.workers.get(user_id=owner_id, worker_id=worker_id)
    except Exception:
        worker_row = None
    if worker_row is None:
        try:
            worker_row = repos.workers.get_any(worker_id=worker_id)
        except Exception:
            worker_row = None
    if worker_row and worker_row.get("workspace_id"):
        return str(worker_row["workspace_id"])
    return derive_workspace_id(owner_id)


def _sync_worker_rules_brain(
    *,
    repos: Repositories,
    owner_id: str,
    workspace_id: str,
    worker_id: str,
) -> None:
    try:
        worker_row = repos.workers.get(user_id=owner_id, worker_id=worker_id) or repos.workers.get_any(worker_id=worker_id)
        config = _worker_config_from_row(worker_row)
        rules = list_active_worker_rules(
            repos=repos,
            worker_id=worker_id,
            user_id=owner_id,
            workspace_id=workspace_id,
        )
        _write_worker_rules_brain(config=config, worker_id=worker_id, user_id=owner_id, rules=rules)
    except Exception:
        logger.warning("failed to sync worker feedback rules into worker brain", exc_info=True)


def _worker_config_from_row(row: dict[str, Any] | None) -> WorkerConfig | None:
    if not row:
        return None
    config = row.get("config")
    if isinstance(config, WorkerConfig):
        return config
    if isinstance(config, dict):
        try:
            return WorkerConfig(**config)
        except Exception:
            return None
    manifest = row.get("manifest_json")
    if isinstance(manifest, str) and manifest.strip():
        try:
            parsed = json.loads(manifest)
            if isinstance(parsed, dict):
                return WorkerConfig(**parsed)
        except Exception:
            return None
    return None


def _write_worker_rules_brain(
    *,
    config: WorkerConfig | None,
    worker_id: str,
    user_id: str | None,
    rules: list[dict[str, Any]],
) -> None:
    import contexts
    from runner_sandbox.memory_context import memory_context_name

    memory_name = memory_context_name(config) if config is not None else default_worker_memory_context_name(worker_id)
    with contexts.use_context_scope(contexts.context_scope_for_user(user_id)):
        root = contexts.context_dir(memory_name)
        root.mkdir(parents=True, exist_ok=True)
        contexts.set_context_metadata(
            memory_name,
            writeable=True,
            owner_id=user_id,
            sensitive=True,
            category="memory",
        )
        (Path(root) / APPROVAL_RULES_MD).write_text(_rules_markdown(rules), encoding="utf-8")
        (Path(root) / APPROVAL_RULES_AUDIT_JSONL).write_text(_rules_jsonl(rules), encoding="utf-8")


def _rules_markdown(rules: Iterable[dict[str, Any]]) -> str:
    lines = [
        "# Approval feedback rules",
        "",
        "Durable worker-level rules learned from human rejection feedback.",
        "",
    ]
    count = 0
    for count, row in enumerate(rules, start=1):
        lines.extend(
            [
                f"## Rule {count}",
                "",
                str(row.get("rule_text") or "").strip(),
                "",
                f"- Source: {row.get('source') or RULES_SOURCE_APPROVAL_REJECTION}",
                f"- Approval: {row.get('approval_id') or row.get('source_ref') or ''}",
                f"- Run: {row.get('run_id') or ''}",
                f"- Added: {row.get('created_at') or ''}",
                "",
            ]
        )
    if count == 0:
        lines.append("_No global rejection feedback rules recorded yet._")
        lines.append("")
    return "\n".join(lines)


def _rules_jsonl(rules: Iterable[dict[str, Any]]) -> str:
    rows = []
    for row in rules:
        rows.append(
            json.dumps(
                {
                    "id": row.get("id"),
                    "workspace_id": row.get("workspace_id"),
                    "worker_id": row.get("worker_id"),
                    "rule_text": row.get("rule_text"),
                    "rule_hash": row.get("rule_hash"),
                    "source": row.get("source"),
                    "source_ref": row.get("source_ref"),
                    "run_id": row.get("run_id"),
                    "approval_id": row.get("approval_id"),
                    "created_by": row.get("created_by"),
                    "created_at": row.get("created_at"),
                },
                separators=(",", ":"),
            )
        )
    return "\n".join(rows) + ("\n" if rows else "")


def _rule_hash(text: str) -> str:
    normalized = re.sub(r"\s+", " ", text).strip().lower()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _clean_feedback_part(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    text = re.sub(r"\s+", " ", value).strip()
    return text[:_MAX_RULE_TEXT_CHARS]


def _annotation_feedback_parts(annotations: dict[str, Any] | None) -> list[str]:
    if not isinstance(annotations, dict):
        return []
    parts: list[str] = []
    for item in annotations.get("text") or []:
        if not isinstance(item, dict):
            continue
        quote = _clean_feedback_part(item.get("quote"))
        comment = _clean_feedback_part(item.get("comment"))
        if quote and comment:
            parts.append(f"{comment} (about: {quote})")
        elif comment:
            parts.append(comment)
        elif quote:
            parts.append(quote)
    for item in annotations.get("images") or []:
        if not isinstance(item, dict):
            continue
        caption = _clean_feedback_part(item.get("caption"))
        if caption:
            parts.append(caption)
        for pin in item.get("pins") or []:
            if isinstance(pin, dict):
                comment = _clean_feedback_part(pin.get("comment"))
                if comment:
                    parts.append(comment)
    return parts
