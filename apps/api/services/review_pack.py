"""Review-pack public projection, reviewer tokens, votes, and run wiring."""

from __future__ import annotations

import copy
import hashlib
import json
import re
import secrets
import uuid as _uuid_mod
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional, Tuple

from fastapi import HTTPException

from core.urls import _frontend_base_url
from services.share_links import _load_standalone_share_row

ReviewVerdict = Literal["interested", "maybe", "pass"]

_PACK_ID_RE = re.compile(r"^rp_[a-z0-9_]+_\d{4}-\d{2}-\d{2}$")
_REVIEWER_TOKEN_RE = re.compile(r"^rpr_[A-Za-z0-9]{24,80}$")


def review_pack_share_url(token: str) -> str:
    import urllib.parse

    return f"{_frontend_base_url()}/review/{urllib.parse.quote(token, safe='')}"


def review_pack_reviewer_url(token: str, reviewer_token: str) -> str:
    import urllib.parse

    return f"{review_pack_share_url(token)}?reviewer={urllib.parse.quote(reviewer_token, safe='')}"


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


def _extract_pack_from_run_output(output: Any) -> Dict[str, Any]:
    """Extract the pack from known worker output envelopes."""
    if not isinstance(output, dict):
        raise HTTPException(status_code=500, detail="Review pack run output invalid")
    candidates: list[Any] = [
        output.get("review_pack"),
        output.get("pack"),
        output.get("reviewPack"),
        (output.get("result") or {}).get("review_pack") if isinstance(output.get("result"), dict) else None,
        (output.get("outputs") or {}).get("review_pack") if isinstance(output.get("outputs"), dict) else None,
    ]
    for candidate in candidates:
        if isinstance(candidate, dict) and isinstance(candidate.get("jobs"), list):
            return copy.deepcopy(candidate)
    if isinstance(output.get("jobs"), list):
        return copy.deepcopy(output)
    raise HTTPException(status_code=500, detail="Review pack not found in run output")


def _load_pack_from_run(run_id: str, *, owner_id: str) -> Dict[str, Any]:
    from db import get_repos

    row = get_repos().runs.get(user_id=owner_id, run_id=run_id)
    if not row:
        raise HTTPException(status_code=404, detail="Review pack source run not found")
    try:
        output = json.loads(row.get("output_json") or "{}")
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail="Review pack run output invalid") from exc
    return _extract_pack_from_run_output(output)


def _resolve_pack_document(context_name: str, rel: str, *, owner_id: str) -> Dict[str, Any]:
    pack = _load_pack_document(context_name, rel)
    source_run_id = str(
        pack.get("source_run_id")
        or (pack.get("integrity") or {}).get("source_run_id")
        or ""
    ).strip()
    if not source_run_id:
        return pack
    direct_pack = _load_pack_from_run(source_run_id, owner_id=owner_id)
    if "id" not in direct_pack and "id" in pack:
        direct_pack["id"] = pack["id"]
    if isinstance(pack.get("integrity"), dict):
        direct_integrity = direct_pack.get("integrity") if isinstance(direct_pack.get("integrity"), dict) else {}
        direct_pack["integrity"] = {**direct_integrity, **copy.deepcopy(pack["integrity"])}
    return direct_pack


def materialize_review_pack_from_run(
    *,
    context_name: str,
    pack_id: str,
    run_id: str,
    owner_id: str,
) -> Dict[str, Any]:
    if not _PACK_ID_RE.match(pack_id):
        raise HTTPException(status_code=400, detail="Invalid pack_id")
    pack = _load_pack_from_run(run_id, owner_id=owner_id)
    pack["id"] = str(pack.get("id") or pack_id)
    integrity = pack.get("integrity") if isinstance(pack.get("integrity"), dict) else {}
    pack["integrity"] = {**integrity, "source_run_id": run_id}
    rel = f"review-packs/{pack_id}/pack.json"

    from services.context_access import _write_context_file

    _write_context_file(
        context_name,
        rel,
        (json.dumps(pack, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8"),
        user_id=owner_id,
        tags=["review-pack"],
        file_metadata={"kind": "review_pack", "pack_id": pack_id, "source_run_id": run_id},
    )
    return {"pack_id": pack_id, "path": rel, "source_run_id": run_id}


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


def _hash_reviewer_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _reviewer_key_from_name(name: str) -> str:
    key = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:48]
    return key or "reviewer"


def _reviewer_records(pack: Dict[str, Any]) -> List[Dict[str, Any]]:
    integrity = pack.get("integrity") if isinstance(pack.get("integrity"), dict) else {}
    reviewers = integrity.get("reviewers")
    if isinstance(reviewers, list):
        return [r for r in reviewers if isinstance(r, dict)]
    return []


def _resolve_reviewer(pack: Dict[str, Any], reviewer_token: Optional[str]) -> Dict[str, str]:
    if not reviewer_token or not _REVIEWER_TOKEN_RE.fullmatch(reviewer_token):
        raise HTTPException(status_code=401, detail="Reviewer token required")
    token_hash = _hash_reviewer_token(reviewer_token)
    for reviewer in _reviewer_records(pack):
        if str(reviewer.get("token_hash") or "") != token_hash:
            continue
        name = str(reviewer.get("name") or "").strip()
        key = str(reviewer.get("key") or "").strip() or _reviewer_key_from_name(name)
        if not name or not key:
            break
        return {
            "key": key[:48],
            "name": name[:120],
            "role": str(reviewer.get("role") or "")[:120],
        }
    raise HTTPException(status_code=401, detail="Invalid reviewer token")


def ensure_reviewer_tokens(pack: Dict[str, Any]) -> Tuple[Dict[str, Any], List[Dict[str, str]]]:
    next_pack = copy.deepcopy(pack)
    integrity = next_pack.get("integrity") if isinstance(next_pack.get("integrity"), dict) else {}
    suggestions = next_pack.get("reviewers_suggested") or []
    reviewers: List[Dict[str, Any]] = []
    minted: List[Dict[str, str]] = []
    for idx, raw in enumerate(suggestions):
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or "").strip()
        if not name:
            continue
        key = str(raw.get("key") or "").strip() or _reviewer_key_from_name(name)
        key = key[:48] or f"reviewer-{idx + 1}"
        role = str(raw.get("role") or "")[:120]
        token = f"rpr_{secrets.token_urlsafe(32).replace('-', '').replace('_', '')[:40]}"
        reviewers.append({
            "key": key,
            "name": name[:120],
            "role": role,
            "token_hash": _hash_reviewer_token(token),
        })
        minted.append({"key": key, "name": name[:120], "role": role, "token": token})
    integrity["reviewers"] = reviewers
    next_pack["integrity"] = integrity
    return next_pack, minted


def _copy_allowed(src: Dict[str, Any], allowed: set[str]) -> Dict[str, Any]:
    return {key: copy.deepcopy(src[key]) for key in allowed if key in src}


def public_pack_projection(pack: Dict[str, Any]) -> Dict[str, Any]:
    candidate_allowed = {
        "id", "rank", "name", "title", "company", "location", "score",
        "why", "strengths", "concerns", "linkedin",
    }
    job_allowed = {
        "id", "personio_id", "title", "location", "department",
        "must_haves", "sourcing_hint", "coverage_note",
    }
    out = _copy_allowed(
        pack,
        {"schema_version", "id", "client", "meta", "reviewers_suggested", "coverage_notes", "summary"},
    )
    jobs: List[Dict[str, Any]] = []
    for job in pack.get("jobs") or []:
        if not isinstance(job, dict):
            continue
        projected_job = _copy_allowed(job, job_allowed)
        projected_job["candidates"] = [
            _copy_allowed(cand, candidate_allowed)
            for cand in (job.get("candidates") or [])
            if isinstance(cand, dict)
        ]
        jobs.append(projected_job)
    out["jobs"] = jobs
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


def load_public_review_pack(
    token: str,
    password: Optional[str],
    reviewer_token: Optional[str] = None,
) -> Dict[str, Any]:
    row = _resolve_review_pack_share(token)
    context_name = str(row["entity_id"])
    owner_id = str(row["owner_id"])
    rel = _pack_file_rel(row)
    pack = _resolve_pack_document(context_name, rel, owner_id=owner_id)
    _check_pack_expiry(pack)
    _verify_pack_password(pack, password)
    pack_id = str(pack.get("id") or _pack_id_from_rel(rel))
    events = _list_feedback_events(context_name, pack_id)
    reviewer = _resolve_reviewer(pack, reviewer_token) if reviewer_token else None
    return {
        "pack": public_pack_projection(pack),
        "consensus": aggregate_consensus(events),
        "reviewer": reviewer,
    }


def load_public_feedback(
    token: str,
    reviewer_token: str,
    password: Optional[str],
) -> Dict[str, Any]:
    row = _resolve_review_pack_share(token)
    context_name = str(row["entity_id"])
    owner_id = str(row["owner_id"])
    rel = _pack_file_rel(row)
    pack = _resolve_pack_document(context_name, rel, owner_id=owner_id)
    _check_pack_expiry(pack)
    _verify_pack_password(pack, password)
    reviewer = _resolve_reviewer(pack, reviewer_token)
    pack_id = str(pack.get("id") or _pack_id_from_rel(rel))
    events = _list_feedback_events(context_name, pack_id)
    my_votes = [ev for ev in events if str(ev.get("reviewer_key") or "") == reviewer["key"]]
    return {
        "my_votes": my_votes,
        "consensus": aggregate_consensus(events),
        "reviewer": reviewer,
    }


def record_public_feedback(
    token: str,
    *,
    password: Optional[str],
    reviewer_token: str,
    job_id: str,
    candidate_id: str,
    verdict: ReviewVerdict,
    note: Optional[str],
) -> Dict[str, Any]:
    row = _resolve_review_pack_share(token)
    context_name = str(row["entity_id"])
    owner_id = str(row["owner_id"])
    rel = _pack_file_rel(row)
    pack = _resolve_pack_document(context_name, rel, owner_id=owner_id)
    _check_pack_expiry(pack)
    _verify_pack_password(pack, password)
    reviewer = _resolve_reviewer(pack, reviewer_token)

    resolved_pack_id = str(pack.get("id") or _pack_id_from_rel(rel))

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
    reviewer_key = reviewer["key"]
    feedback_rel = _feedback_rel(resolved_pack_id, reviewer_key, job_id, candidate_id)
    event = {
        "uuid": event_uuid,
        "pack_id": resolved_pack_id,
        "job_id": job_id,
        "candidate_id": candidate_id,
        "reviewer_key": reviewer_key,
        "reviewer_name": reviewer["name"],
        "reviewer_role": reviewer["role"] or None,
        "verdict": verdict,
        "note": note,
        "ts": now,
    }

    from services.context_access import _write_context_file

    _write_context_file(
        context_name,
        feedback_rel,
        (json.dumps(event, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8"),
        user_id=owner_id,
        tags=["review-pack-feedback"],
        file_metadata={"kind": "review_pack_feedback", "pack_id": resolved_pack_id},
    )

    events = _list_feedback_events(context_name, resolved_pack_id)
    return {"vote": event, "consensus": aggregate_consensus(events)}


def mint_review_pack_share_link(
    *,
    context_name: str,
    pack_id: str,
    owner_id: str,
) -> Dict[str, Any]:
    from services.context_access import _safe_context_file_or_400, _write_context_file
    from services.share_links import _create_or_get_standalone_share_link

    if not _PACK_ID_RE.match(pack_id):
        raise HTTPException(status_code=400, detail="Invalid pack_id")
    rel = f"review-packs/{pack_id}/pack.json"
    if not _safe_context_file_or_400(context_name, rel).is_file():
        raise HTTPException(status_code=404, detail="Review pack not found")
    pack = _load_pack_document(context_name, rel)
    next_pack, minted = ensure_reviewer_tokens(pack)
    if minted:
        _write_context_file(
            context_name,
            rel,
            (json.dumps(next_pack, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8"),
            user_id=owner_id,
            tags=["review-pack"],
            file_metadata={"kind": "review_pack", "pack_id": pack_id},
        )
    link = _create_or_get_standalone_share_link(
        entity_type="review_pack",
        entity_id=context_name,
        file_path=rel,
        owner_id=owner_id,
    )
    link["url"] = review_pack_share_url(link["token"])
    link["reviewer_links"] = [
        {
            "key": item["key"],
            "name": item["name"],
            "role": item["role"],
            "token": item["token"],
            "url": review_pack_reviewer_url(link["token"], item["token"]),
        }
        for item in minted
    ]
    return link
