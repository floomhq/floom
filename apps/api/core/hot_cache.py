"""Tiny in-process TTL cache for hot authenticated GET endpoints."""

from __future__ import annotations

import copy
import threading
import time
from collections.abc import Hashable
from typing import Any


_CACHE_TTL_SECONDS = 30.0
_MAX_ENTRIES = 256
_lock = threading.Lock()
_items: dict[Hashable, tuple[float, Any]] = {}


def get(key: Hashable) -> Any | None:
    now = time.monotonic()
    with _lock:
        item = _items.get(key)
        if item is None:
            return None
        expires_at, value = item
        if expires_at <= now:
            _items.pop(key, None)
            return None
        return copy.deepcopy(value)


def set(key: Hashable, value: Any) -> None:
    now = time.monotonic()
    with _lock:
        if len(_items) >= _MAX_ENTRIES:
            for old_key, (expires_at, _) in list(_items.items()):
                if expires_at <= now:
                    _items.pop(old_key, None)
            if len(_items) >= _MAX_ENTRIES:
                _items.pop(next(iter(_items)))
        _items[key] = (now + _CACHE_TTL_SECONDS, copy.deepcopy(value))


def delete(key: Hashable) -> None:
    with _lock:
        _items.pop(key, None)


def clear() -> None:
    with _lock:
        _items.clear()
