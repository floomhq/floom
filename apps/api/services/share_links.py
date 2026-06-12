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

from core.urls import _frontend_base_url

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
