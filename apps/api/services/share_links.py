"""Standalone share-link store: mint/lookup/revoke signed public links.

The unified ``standalone_share_links`` table backing public share URLs for any
shareable entity (worker, brain file, brain pack, run). Used by the worker,
context/brain, and run share routes. Extracted verbatim from main.py.

db helpers are imported lazily inside the functions (purged + re-imported by
fixtures); the public URL is built from ``core.urls._frontend_base_url``.
"""

from __future__ import annotations

import re
import secrets as pysecrets
import sqlite3
import urllib.parse
from typing import Any, Dict, Literal, Optional

from fastapi import HTTPException

from core.urls import _frontend_base_url, _short_link_base_url

def _standalone_share_url(token: str) -> str:
    return f"{_frontend_base_url()}/s/{urllib.parse.quote(token, safe='')}"


def _mint_standalone_share_token() -> str:
    return f"fls_{pysecrets.token_urlsafe(18).replace('-', '').replace('_', '')[:24]}"


def _ensure_standalone_share_links_table() -> None:
    from db import get_db
    with get_db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS standalone_share_links (
                token TEXT PRIMARY KEY,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                file_path TEXT NOT NULL DEFAULT '',
                owner_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(entity_type, entity_id, file_path, owner_id)
            );
            CREATE INDEX IF NOT EXISTS idx_standalone_share_links_entity
                ON standalone_share_links(entity_type, entity_id, file_path, owner_id);
            """
        )


def _load_standalone_share_row(token: str) -> Optional[Dict[str, Any]]:
    from db import get_db
    if not re.fullmatch(r"fls_[A-Za-z0-9]{6,80}", token or ""):
        raise HTTPException(status_code=404, detail="Share link not found")
    _ensure_standalone_share_links_table()
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT token, entity_type, entity_id, file_path, owner_id, created_at
            FROM standalone_share_links
            WHERE token = ?
            LIMIT 1
            """,
            (token,),
        ).fetchone()
    return dict(row) if row else None


def _create_or_get_standalone_share_link(
    *,
    entity_type: Literal["worker", "brain_file", "brain_pack", "run"],
    entity_id: str,
    owner_id: str,
    file_path: str = "",
) -> Dict[str, str]:
    from db import get_db, now_iso
    safe_file_path = file_path or ""
    if not entity_id or not owner_id:
        raise HTTPException(status_code=409, detail="Item cannot be shared")
    _ensure_standalone_share_links_table()
    with get_db() as conn:
        existing = conn.execute(
            """
            SELECT token FROM standalone_share_links
            WHERE entity_type = ? AND entity_id = ? AND file_path = ? AND owner_id = ?
            LIMIT 1
            """,
            (entity_type, entity_id, safe_file_path, owner_id),
        ).fetchone()
        if existing:
            token = str(existing["token"])
        else:
            token = ""
            ts = now_iso()
            for _ in range(8):
                candidate = _mint_standalone_share_token()
                try:
                    conn.execute(
                        """
                        INSERT INTO standalone_share_links
                            (token, entity_type, entity_id, file_path, owner_id, created_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        (candidate, entity_type, entity_id, safe_file_path, owner_id, ts),
                    )
                    token = candidate
                    break
                except sqlite3.IntegrityError:
                    dup = conn.execute(
                        """
                        SELECT token FROM standalone_share_links
                        WHERE entity_type = ? AND entity_id = ? AND file_path = ? AND owner_id = ?
                        LIMIT 1
                        """,
                        (entity_type, entity_id, safe_file_path, owner_id),
                    ).fetchone()
                    if dup:
                        token = str(dup["token"])
                        break
            if not token:
                raise HTTPException(status_code=500, detail="Could not create share link")
    return {
        "token": token,
        "url": _standalone_share_url(token),
        "entity_type": entity_type,
    }


def _revoke_standalone_share_link(
    *,
    entity_type: str,
    entity_id: str,
    owner_id: str,
    file_path: str = "",
) -> Dict[str, bool]:
    # #766: delete the token row so the public link stops resolving. A later
    # POST /share-link mints a fresh token (the frontend toggle off->on flow).
    from db import get_db
    _ensure_standalone_share_links_table()
    with get_db() as conn:
        cursor = conn.execute(
            """
            DELETE FROM standalone_share_links
            WHERE entity_type = ? AND entity_id = ? AND file_path = ? AND owner_id = ?
            """,
            (entity_type, entity_id, file_path or "", owner_id),
        )
    return {"revoked": cursor.rowcount > 0}


# Worker short-links: the per-worker /w/<short_id> redirect store (sibling of the
# standalone share-link table above; one short_id per (worker, owner)).
def _mint_worker_short_id() -> str:
    return f"fls_{pysecrets.token_urlsafe(8).replace('-', '').replace('_', '')[:10]}"


def _ensure_worker_short_links_table() -> None:
    from db import get_db
    with get_db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS worker_short_links (
                short_id TEXT PRIMARY KEY,
                worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
                owner_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(worker_id, owner_id)
            );
            CREATE INDEX IF NOT EXISTS idx_worker_short_links_worker_owner
                ON worker_short_links(worker_id, owner_id);
            """
        )


def _worker_short_link_response(worker: Dict[str, Any]) -> Dict[str, str]:
    from db import get_db, now_iso
    worker_id = str(worker.get("id") or "")
    owner_id = str(worker.get("owner_id") or "")
    if not worker_id or not owner_id:
        raise HTTPException(status_code=409, detail="Worker cannot be shared")
    _ensure_worker_short_links_table()
    with get_db() as conn:
        existing = conn.execute(
            """
            SELECT short_id FROM worker_short_links
            WHERE worker_id = ? AND owner_id = ?
            LIMIT 1
            """,
            (worker_id, owner_id),
        ).fetchone()
        if existing:
            short_id = str(existing["short_id"])
        else:
            ts = now_iso()
            for _ in range(5):
                short_id = _mint_worker_short_id()
                try:
                    conn.execute(
                        """
                        INSERT INTO worker_short_links (short_id, worker_id, owner_id, created_at)
                        VALUES (?, ?, ?, ?)
                        """,
                        (short_id, worker_id, owner_id, ts),
                    )
                    break
                except sqlite3.IntegrityError:
                    owner_existing = conn.execute(
                        """
                        SELECT short_id FROM worker_short_links
                        WHERE worker_id = ? AND owner_id = ?
                        LIMIT 1
                        """,
                        (worker_id, owner_id),
                    ).fetchone()
                    if owner_existing:
                        short_id = str(owner_existing["short_id"])
                        break
                    short_id = ""
            if not short_id:
                raise HTTPException(status_code=500, detail="Could not mint short link")
    return {"short_id": short_id, "short_url": f"{_short_link_base_url()}/{short_id}"}


def _load_short_link_public_worker(short_id: str, repos: "Repositories") -> Dict[str, Any]:
    from db import get_db
    if not re.fullmatch(r"fls_[A-Za-z0-9]{6,64}", short_id or ""):
        raise HTTPException(status_code=404, detail="Short link not found")
    _ensure_worker_short_links_table()
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT worker_id, owner_id
            FROM worker_short_links
            WHERE short_id = ?
            LIMIT 1
            """,
            (short_id,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Short link not found")
    worker = repos.workers.get_any(worker_id=str(row["worker_id"]))
    if not worker or str(worker.get("owner_id") or "") != str(row["owner_id"]):
        raise HTTPException(status_code=404, detail="Short link not found")
    return worker
