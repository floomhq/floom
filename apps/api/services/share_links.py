"""Standalone share-link store: mint/lookup/revoke signed public links.

The unified ``standalone_share_links`` table backing public share URLs for any
shareable entity (worker, brain file, brain pack, run). Used by the worker,
context/brain, and run share routes. Extracted verbatim from main.py.

db helpers are imported lazily inside the functions (purged + re-imported by
fixtures); the public URL is built from ``core.urls._frontend_base_url``.
"""

from __future__ import annotations

import hashlib
import inspect
import logging
import re
import secrets as pysecrets
import sqlite3
import urllib.parse
from typing import Any, Dict, Literal, Optional

from fastapi import HTTPException

from core.urls import _frontend_base_url, _short_link_base_url

_API_PUBLIC_HOSTS = {"workeros-api.floom.dev", "workers-api.floom.dev"}
logger = logging.getLogger("floom.api.share_links")
StandaloneShareEntity = Literal["worker", "brain_file", "brain_pack", "run", "review_pack", "approvals_batch"]


def _public_share_frontend_base_url() -> str:
    base = _frontend_base_url()
    parsed = urllib.parse.urlparse(base)
    if parsed.hostname in _API_PUBLIC_HOSTS:
        base = "https://floom.dev"
    # Cloud hosts the dashboard under /app, but public standalone shares are
    # top-level, no-auth URLs. The apex rewrites /s/* into the dashboard route.
    if base.endswith("/app"):
        base = base[:-len("/app")]
    return base.rstrip("/")


def _standalone_share_url(token: str, *, permalink_path: str | None = None) -> str:
    base = _public_share_frontend_base_url()
    if permalink_path:
        # Worker shares mint the canonical permalink + an unguessable ?share=
        # key instead of a separate /s/<token> URL (Fede 2026-07-06: "access
        # is a property, not a URL namespace" — one URL per worker forever).
        sep = "&" if "?" in permalink_path else "?"
        return f"{base}{permalink_path}{sep}share={urllib.parse.quote(token, safe='')}"
    return f"{base}/s/{urllib.parse.quote(token, safe='')}"


def _urlsafe_alnum(length: int) -> str:
    value = ""
    while len(value) < length:
        value += pysecrets.token_urlsafe(length).replace("-", "").replace("_", "")
    return value[:length]


def _clean_slug(raw: str) -> str:
    """Lowercase, keep [a-z0-9-] only, collapse repeated hyphens, trim to 48 chars."""
    s = raw.lower()
    s = re.sub(r"[^a-z0-9-]", "-", s)
    s = re.sub(r"-{2,}", "-", s)
    s = s.strip("-")
    return s[:48]


def _mint_standalone_share_token(slug: str | None = None) -> str:
    rand = _urlsafe_alnum(8)
    if slug:
        clean = _clean_slug(slug)
        if clean:
            return f"fls_{clean}-{rand}"
    return f"fls_{_urlsafe_alnum(24)}"


def _hash_share_token(token: str) -> str:
    """#934: share tokens are bearer credentials — store only their SHA-256."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


_SHARE_LINKS_TABLE_SQL = """
    CREATE TABLE IF NOT EXISTS standalone_share_links (
        token_hash TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        file_path TEXT NOT NULL DEFAULT '',
        owner_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        -- share-loop: the raw public token, stored so the dashboard can
        -- RE-DISPLAY an existing link instead of the "shown once" ceremony.
        -- These are PUBLIC, unlisted links (not bearer secrets to a private
        -- resource), so re-showing the URL is not a security regression; the
        -- link stops working the moment it is revoked. Nullable for legacy
        -- (#934-hashed) rows whose raw token was discarded.
        share_token TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_standalone_share_links_entity
        ON standalone_share_links(entity_type, entity_id, file_path, owner_id);
"""


def _standalone_share_links_has_entity_unique(conn: sqlite3.Connection) -> bool:
    for index in conn.execute("PRAGMA index_list(standalone_share_links)").fetchall():
        if not int(index["unique"]):
            continue
        cols = [
            row["name"]
            for row in conn.execute(f"PRAGMA index_info({index['name']})").fetchall()
        ]
        if cols == ["entity_type", "entity_id", "file_path", "owner_id"]:
            return True
    return False


def _rebuild_standalone_share_links_without_entity_unique(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        "SELECT token_hash, entity_type, entity_id, file_path, owner_id, created_at "
        "FROM standalone_share_links"
    ).fetchall()
    conn.execute("ALTER TABLE standalone_share_links RENAME TO standalone_share_links_legacy")
    conn.executescript(_SHARE_LINKS_TABLE_SQL)
    for row in rows:
        conn.execute(
            """
            INSERT OR IGNORE INTO standalone_share_links
                (token_hash, entity_type, entity_id, file_path, owner_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                row["token_hash"],
                row["entity_type"],
                row["entity_id"],
                row["file_path"],
                row["owner_id"],
                row["created_at"],
            ),
        )
    conn.execute("DROP TABLE standalone_share_links_legacy")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_standalone_share_links_entity "
        "ON standalone_share_links(entity_type, entity_id, file_path, owner_id)"
    )


def _ensure_standalone_share_links_table() -> None:
    from db import get_db
    with get_db() as conn:
        cols = {row["name"] for row in conn.execute("PRAGMA table_info(standalone_share_links)")}
        if "token" in cols and "token_hash" not in cols:
            # #934 migration: legacy rows stored the raw token. Hash them in
            # place so a database dump no longer hands out every active link.
            rows = conn.execute(
                "SELECT token, entity_type, entity_id, file_path, owner_id, created_at "
                "FROM standalone_share_links"
            ).fetchall()
            conn.execute("ALTER TABLE standalone_share_links RENAME TO standalone_share_links_legacy")
            conn.executescript(_SHARE_LINKS_TABLE_SQL)
            for row in rows:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO standalone_share_links
                        (token_hash, entity_type, entity_id, file_path, owner_id, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        _hash_share_token(str(row["token"])),
                        row["entity_type"],
                        row["entity_id"],
                        row["file_path"],
                        row["owner_id"],
                        row["created_at"],
                    ),
                )
            conn.execute("DROP TABLE standalone_share_links_legacy")
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_standalone_share_links_entity "
                "ON standalone_share_links(entity_type, entity_id, file_path, owner_id)"
            )
            return
        conn.executescript(_SHARE_LINKS_TABLE_SQL)
        if cols and _standalone_share_links_has_entity_unique(conn):
            _rebuild_standalone_share_links_without_entity_unique(conn)
        # share-loop: additive column for re-displaying existing public links.
        cols_after = {row["name"] for row in conn.execute("PRAGMA table_info(standalone_share_links)")}
        if "share_token" not in cols_after:
            conn.execute("ALTER TABLE standalone_share_links ADD COLUMN share_token TEXT")


def _standalone_share_repo(repos: Any | None, *methods: str) -> Any | None:
    share_repo = getattr(repos, "share_links", None) if repos is not None else None
    if share_repo is None:
        return None
    if all(callable(getattr(share_repo, method, None)) for method in methods):
        return share_repo
    return None


def _create_or_get_standalone_share_link(
    *,
    entity_type: StandaloneShareEntity,
    entity_id: str,
    owner_id: str,
    file_path: str = "",
    repos: Any | None = None,
    slug: str | None = None,
    regenerate: bool = False,
    permalink_path: str | None = None,
) -> Dict[str, str]:
    from db import get_db, now_iso
    safe_file_path = file_path or ""
    if not entity_id or not owner_id:
        raise HTTPException(status_code=409, detail="Item cannot be shared")

    if regenerate:
        # Delete existing tokens for this entity so the new minted one is fresh.
        _revoke_standalone_share_link(
            entity_type=entity_type,
            entity_id=entity_id,
            owner_id=owner_id,
            file_path=safe_file_path,
            repos=repos,
        )

    share_repo = _standalone_share_repo(repos, "create_standalone_share")
    if share_repo is not None:
        # share-loop: reuse an existing active public link for this entity so the
        # dashboard shows a STABLE URL instead of minting a new one (and orphaning
        # the previously-shared link) on every open.
        existing = _list_standalone_share_urls(
            entity_type=entity_type,
            entity_id=entity_id,
            owner_id=owner_id,
            file_path=safe_file_path,
            repos=repos,
            permalink_path=permalink_path,
        )
        if existing:
            return {"token": existing[0]["token"], "url": existing[0]["url"], "entity_type": entity_type}
        # Detect share_token support by INSPECTING the signature rather than
        # catching TypeError — the latter would swallow a genuine TypeError
        # raised from inside the repo call and mask a real bug.
        try:
            supports_share_token = "share_token" in inspect.signature(
                share_repo.create_standalone_share
            ).parameters
        except (TypeError, ValueError):
            supports_share_token = False
        ts = now_iso()
        for _ in range(8):
            candidate = _mint_standalone_share_token(slug=slug)
            kwargs: Dict[str, Any] = dict(
                entity_type=entity_type,
                entity_id=entity_id,
                file_path=safe_file_path,
                owner_id=owner_id,
                token_hash=_hash_share_token(candidate),
                created_at=ts,
            )
            if supports_share_token:
                # Persisted so the link can be re-displayed.
                kwargs["share_token"] = candidate
            try:
                share_repo.create_standalone_share(**kwargs)
                return {
                    "token": candidate,
                    "url": _standalone_share_url(candidate, permalink_path=permalink_path),
                    "entity_type": entity_type,
                }
            except Exception:
                logger.warning("standalone share-link repository create failed", exc_info=True)
        raise HTTPException(status_code=500, detail="Could not create share link")

    _ensure_standalone_share_links_table()
    # share-loop: the raw token is now persisted in share_token so an existing
    # public link can be RE-DISPLAYED (these are public, unlisted links, not
    # bearer secrets). Reuse an active link for the entity instead of minting a
    # second one; revoke still deletes every row for the entity.
    existing = _list_standalone_share_urls(
        entity_type=entity_type,
        entity_id=entity_id,
        owner_id=owner_id,
        file_path=safe_file_path,
        repos=repos,
        permalink_path=permalink_path,
    )
    if existing:
        return {"token": existing[0]["token"], "url": existing[0]["url"], "entity_type": entity_type}
    token = ""
    ts = now_iso()
    with get_db() as conn:
        for _ in range(8):
            candidate = _mint_standalone_share_token(slug=slug)
            try:
                conn.execute(
                    """
                    INSERT INTO standalone_share_links
                        (token_hash, entity_type, entity_id, file_path, owner_id, created_at, share_token)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (_hash_share_token(candidate), entity_type, entity_id, safe_file_path, owner_id, ts, candidate),
                )
                token = candidate
                break
            except sqlite3.IntegrityError:
                # token_hash PK collision (astronomically unlikely) — retry.
                continue
    if not token:
        raise HTTPException(status_code=500, detail="Could not create share link")
    return {
        "token": token,
        "url": _standalone_share_url(token, permalink_path=permalink_path),
        "entity_type": entity_type,
    }


def _list_standalone_share_urls(
    *,
    entity_type: str,
    entity_id: str,
    owner_id: str,
    file_path: str = "",
    repos: Any | None = None,
    permalink_path: str | None = None,
) -> list[Dict[str, str]]:
    """Existing, active public share links for an entity (reconstructable URLs).

    Returns only links whose raw token was persisted (``share_token``). Legacy
    #934-hashed rows without a stored token are omitted (their URL is
    unrecoverable by design). Enables the dashboard to show + copy an existing
    public link instead of the "shown once" ceremony.
    """
    from db import get_db, now_iso
    safe_file_path = file_path or ""
    share_repo = _standalone_share_repo(repos, "list_standalone_shares")
    rows: list[Dict[str, Any]] = []
    if share_repo is not None:
        try:
            rows = [
                dict(r)
                for r in (
                    share_repo.list_standalone_shares(
                        entity_type=entity_type,
                        entity_id=entity_id,
                        owner_id=owner_id,
                        file_path=safe_file_path,
                        now_iso_str=now_iso(),
                    )
                    or []
                )
            ]
        except Exception:
            logger.warning("standalone share-link repository list failed", exc_info=True)
            rows = []
    else:
        _ensure_standalone_share_links_table()
        with get_db() as conn:
            rows = [
                dict(r)
                for r in conn.execute(
                    """
                    SELECT share_token, created_at
                    FROM standalone_share_links
                    WHERE entity_type = ? AND entity_id = ? AND file_path = ? AND owner_id = ?
                    ORDER BY created_at ASC
                    """,
                    (entity_type, entity_id, safe_file_path, owner_id),
                ).fetchall()
            ]
    out: list[Dict[str, str]] = []
    for row in rows:
        raw = str(row.get("share_token") or "").strip()
        if not raw:
            continue
        out.append(
            {
                "token": raw,
                "url": _standalone_share_url(raw, permalink_path=permalink_path),
                "entity_type": entity_type,
            }
        )
    return out


def _load_standalone_share_row(token: str, repos: Any | None = None) -> Optional[Dict[str, Any]]:
    from db import get_db, now_iso
    if not re.fullmatch(r"fls_[A-Za-z0-9_-]{6,128}", token or ""):
        raise HTTPException(status_code=404, detail="Share link not found")
    share_repo = _standalone_share_repo(repos, "resolve_standalone_share")
    if share_repo is not None:
        row = share_repo.resolve_standalone_share(
            token_hash=_hash_share_token(token),
            now_iso_str=now_iso(),
        )
        return dict(row) if row else None

    _ensure_standalone_share_links_table()
    with get_db() as conn:
        # #934: lookup is by SHA-256 of the presented token — the raw value is
        # never stored, so a DB dump can't be replayed as live share links.
        row = conn.execute(
            """
            SELECT entity_type, entity_id, file_path, owner_id, created_at
            FROM standalone_share_links
            WHERE token_hash = ?
            LIMIT 1
            """,
            (_hash_share_token(token),),
        ).fetchone()
    return dict(row) if row else None


def _revoke_standalone_share_link(
    *,
    entity_type: str,
    entity_id: str,
    owner_id: str,
    file_path: str = "",
    repos: Any | None = None,
) -> Dict[str, bool]:
    # #766: delete the token row so the public link stops resolving. A later
    # POST /share-link mints a fresh token (the frontend toggle off->on flow).
    from db import get_db, now_iso
    share_repo = _standalone_share_repo(repos, "revoke_standalone_share")
    if share_repo is not None:
        return {
            "revoked": bool(
                share_repo.revoke_standalone_share(
                    entity_type=entity_type,
                    entity_id=entity_id,
                    file_path=file_path or "",
                    owner_id=owner_id,
                    revoked_at=now_iso(),
                )
            )
        }

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
    return f"fls_{_urlsafe_alnum(24)}"


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
    if not re.fullmatch(r"fls_[A-Za-z0-9]{24,64}", short_id or ""):
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
