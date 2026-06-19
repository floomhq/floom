"""NovaSearch Review Pack — load pack.json, public vote persistence, consensus."""

from __future__ import annotations

import copy
import json
import re
import uuid as _uuid_mod
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Tuple

from fastapi import HTTPException

from core.urls import _frontend_base_url
from services.share_links import _load_standalone_share_row

ReviewVerdict = Literal["interested", "maybe", "pass"]

_PACK_ID_RE = re.compile(r"^rp_[a-z0-9_]+_\d{4}-\d{2}-\d{2}$")


def review_pack_share_url(token: str) -> str:
    import urllib.parse

    return f"{_frontend_base_url()}/review/{urllib.parse.quote(token, safe='')}"


def _resolve_review_pack_share(token: str) -> Dict[str, Any]:
    row = _load_standalone_share_row(token)
    if not row or str(row.get("entity_type") or "") != "review_pack":
        raise HTTPException(status_code=404, detail="Share link not found")
    return dict(row)


def _pack_file_rel(row: Dict[str, Any]) -> str:
    rel = str(row.get("file_path") or "").strip()
    if not rel:
        raise HTTPException(status_code=404, detail="Review pack not found")
    return rel


def _pack_id_from_rel(rel: str) -> str:
    # review-packs/{pack_id}/pack.json
    parts = rel.split("/")
    if len(parts) >= 2 and parts[0] == "review-packs":
        return parts[1]
    raise HTTPException(status_code=500, detail="Invalid review pack path")


def _load_pack_document(context_name: str, rel: str) -> Dict[str, Any]:
    from services.context_access import _safe_context_file_or_400

    target = _safe_context_file_or_400(context_name, rel)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Review pack not found")
    try:
        pack = json.loads(target.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail="Review pack JSON invalid") from exc
    if not isinstance(pack, dict):
        raise HTTPException(status_code=500, detail="Review pack JSON invalid")
    return pack


def _check_pack_expiry(pack: Dict[str, Any]) -> None:
    meta = pack.get("meta") or {}
    expires = str(meta.get("expires_at") or "").strip()
    if not expires:
        return
    try:
        exp = datetime.fromisoformat(expires.replace("Z", "+00:00"))
    except ValueError:
        return
    if datetime.now(timezone.utc) > exp.astimezone(timezone.utc):
        raise HTTPException(status_code=410, detail="Review pack expired")


def _verify_pack_password(pack: Dict[str, Any], password: Optional[str]) -> None:
    integrity = pack.get("integrity") or {}
    expected = str(integrity.get("password_plain") or "").strip()
    if not expected:
        return
    if (password or "").strip() != expected:
        raise HTTPException(status_code=401, detail="Invalid pack password")


def public_pack_projection(pack: Dict[str, Any]) -> Dict[str, Any]:
    out = copy.deepcopy(pack)
    out.pop("integrity", None)
    return out


def _feedback_rel(pack_id: str, reviewer_key: str, job_id: str, candidate_id: str) -> str:
    safe_key = re.sub(r"[^a-z0-9_-]", "-", reviewer_key.lower())[:48] or "reviewer"
    safe_job = re.sub(r"[^a-z0-9_-]", "-", job_id.lower())[:64]
    safe_cand = re.sub(r"[^a-z0-9_-]", "-", candidate_id.lower())[:64]
    return f"feedback/review/{pack_id}/{safe_key}__{safe_job}__{safe_cand}.json"


def _list_feedback_events(context_name: str, pack_id: str) -> List[Dict[str, Any]]:
    from contexts import safe_context_file_path

    root = safe_context_file_path(context_name, f"feedback/review/{pack_id}")
    if not root.is_dir():
        return []
    events: List[Dict[str, Any]] = []
    for path in sorted(root.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if isinstance(data, dict) and str(data.get("pack_id") or "") == pack_id:
            events.append(data)
    return events


def aggregate_consensus(events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    grouped: Dict[Tuple[str, str], List[Dict[str, Any]]] = defaultdict(list)
    for ev in events:
        job_id = str(ev.get("job_id") or "")
        candidate_id = str(ev.get("candidate_id") or "")
        if not job_id or not candidate_id:
            continue
        grouped[(job_id, candidate_id)].append(ev)

    out: List[Dict[str, Any]] = []
    for (job_id, candidate_id), votes in grouped.items():
        counts = {"interested": 0, "maybe": 0, "pass": 0}
        chips: List[Dict[str, str]] = []
        # Latest vote per reviewer_key wins
        latest: Dict[str, Dict[str, Any]] = {}
        for vote in votes:
            rk = str(vote.get("reviewer_key") or "")
            if rk:
                latest[rk] = vote
        for vote in latest.values():
            verdict = str(vote.get("verdict") or "")
            if verdict in counts:
                counts[verdict] += 1
            chips.append(
                {
                    "reviewer_name": str(vote.get("reviewer_name") or vote.get("reviewer_key") or ""),
                    "verdict": verdict,
                }
            )
        out.append(
            {
                "job_id": job_id,
                "candidate_id": candidate_id,
                "counts": counts,
                "chips": chips,
            }
        )
    out.sort(key=lambda row: (row["job_id"], row["candidate_id"]))
    return out


def load_public_review_pack(token: str, password: Optional[str]) -> Dict[str, Any]:
    row = _resolve_review_pack_share(token)
    context_name = str(row["entity_id"])
    rel = _pack_file_rel(row)
    pack = _load_pack_document(context_name, rel)
    _check_pack_expiry(pack)
    _verify_pack_password(pack, password)
    pack_id = str(pack.get("id") or _pack_id_from_rel(rel))
    events = _list_feedback_events(context_name, pack_id)
    return {
        "pack": public_pack_projection(pack),
        "consensus": aggregate_consensus(events),
    }


def load_public_feedback(
    token: str,
    reviewer_key: str,
    password: Optional[str],
) -> Dict[str, Any]:
    row = _resolve_review_pack_share(token)
    context_name = str(row["entity_id"])
    rel = _pack_file_rel(row)
    pack = _load_pack_document(context_name, rel)
    _check_pack_expiry(pack)
    _verify_pack_password(pack, password)
    pack_id = str(pack.get("id") or _pack_id_from_rel(rel))
    events = _list_feedback_events(context_name, pack_id)
    my_votes = [ev for ev in events if str(ev.get("reviewer_key") or "") == reviewer_key]
    return {
        "my_votes": my_votes,
        "consensus": aggregate_consensus(events),
    }


def record_public_feedback(
    token: str,
    *,
    password: Optional[str],
    job_id: str,
    candidate_id: str,
    reviewer_key: str,
    reviewer_name: str,
    reviewer_role: Optional[str],
    verdict: ReviewVerdict,
    note: Optional[str],
) -> Dict[str, Any]:
    row = _resolve_review_pack_share(token)
    context_name = str(row["entity_id"])
    owner_id = str(row["owner_id"])
    rel = _pack_file_rel(row)
    pack = _load_pack_document(context_name, rel)
    _check_pack_expiry(pack)
    _verify_pack_password(pack, password)

    resolved_pack_id = str(pack.get("id") or _pack_id_from_rel(rel))

    # Validate job/candidate exist in pack
    job_ids = {str(j.get("id")) for j in (pack.get("jobs") or []) if isinstance(j, dict)}
    if job_id not in job_ids:
        raise HTTPException(status_code=400, detail="Unknown job_id")
    candidate_ok = False
    for job in pack.get("jobs") or []:
        if not isinstance(job, dict) or str(job.get("id")) != job_id:
            continue
        for cand in job.get("candidates") or []:
            if isinstance(cand, dict) and str(cand.get("id")) == candidate_id:
                candidate_ok = True
                break
    if not candidate_ok:
        raise HTTPException(status_code=400, detail="Unknown candidate_id")

    if verdict not in ("interested", "maybe", "pass"):
        raise HTTPException(status_code=400, detail="Invalid verdict")
    if note and len(note) > 240:
        raise HTTPException(status_code=400, detail="note too long")

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    event_uuid = str(_uuid_mod.uuid4())
    feedback_rel = _feedback_rel(resolved_pack_id, reviewer_key, job_id, candidate_id)
    event = {
        "uuid": event_uuid,
        "pack_id": resolved_pack_id,
        "job_id": job_id,
        "candidate_id": candidate_id,
        "reviewer_key": reviewer_key,
        "reviewer_name": reviewer_name,
        "reviewer_role": reviewer_role,
        "verdict": verdict,
        "note": note,
        "ts": now,
    }

    from services.context_access import _write_context_file

    _write_context_file(
        context_name,
        feedback_rel,
        (json.dumps(event, indent=2, sort_keys=True) + "\n").encode("utf-8"),
        user_id=owner_id,
        tags=["review-pack-feedback"],
        file_metadata={"kind": "review_pack_feedback", "pack_id": resolved_pack_id},
    )

    events = _list_feedback_events(context_name, resolved_pack_id)
    consensus = aggregate_consensus(events)
    return {"vote": event, "consensus": consensus}


def mint_review_pack_share_link(
    *,
    context_name: str,
    pack_id: str,
    owner_id: str,
) -> Dict[str, str]:
    from services.share_links import _create_or_get_standalone_share_link

    if not _PACK_ID_RE.match(pack_id):
        raise HTTPException(status_code=400, detail="Invalid pack_id")
    rel = f"review-packs/{pack_id}/pack.json"
    from services.context_access import _safe_context_file_or_400

    if not _safe_context_file_or_400(context_name, rel).is_file():
        raise HTTPException(status_code=404, detail="Review pack not found")
    link = _create_or_get_standalone_share_link(
        entity_type="review_pack",
        entity_id=context_name,
        file_path=rel,
        owner_id=owner_id,
    )
    link["url"] = review_pack_share_url(link["token"])
    return link
