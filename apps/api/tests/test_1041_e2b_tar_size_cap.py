"""#1041 — _extract_context_tar reads each tar member fully into memory with no
size cap, so a sandboxed worker can OOM the API host via the writeback tar.

Fix: enforce per-member and total byte caps (read from tar metadata, BEFORE
reading the member); oversized members are skipped (logged), not extracted.
"""
from __future__ import annotations

import io
import logging
import tarfile

import pytest

from runner_sandbox import e2b_driver


def _tar_bytes(members: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for name, content in members.items():
            info = tarfile.TarInfo(name=name)
            info.size = len(content)
            tar.addfile(info, io.BytesIO(content))
    return buf.getvalue()


def test_normal_member_extracted(tmp_path):
    content = b"hello context\n" * 10
    e2b_driver._extract_context_tar(_tar_bytes({"notes.md": content}), tmp_path / "ctx")
    assert (tmp_path / "ctx" / "notes.md").read_bytes() == content


def test_oversized_member_skipped(tmp_path, monkeypatch, caplog):
    monkeypatch.setattr(e2b_driver, "MAX_CONTEXT_TAR_MEMBER_BYTES", 16)
    big = b"x" * 64  # > 16-byte cap
    small = b"ok\n"  # <= cap
    raw = _tar_bytes({"huge.bin": big, "small.txt": small})

    with caplog.at_level(logging.WARNING):
        e2b_driver._extract_context_tar(raw, tmp_path / "ctx")

    assert not (tmp_path / "ctx" / "huge.bin").exists()
    assert (tmp_path / "ctx" / "small.txt").read_bytes() == small
    assert any("oversized member" in r.message and "huge.bin" in r.message
               for r in caplog.records)


def test_total_cap_stops_extraction(tmp_path, monkeypatch, caplog):
    monkeypatch.setattr(e2b_driver, "MAX_CONTEXT_TAR_MEMBER_BYTES", 1024)
    monkeypatch.setattr(e2b_driver, "MAX_CONTEXT_TAR_TOTAL_BYTES", 50)
    raw = _tar_bytes({"a.txt": b"a" * 40, "b.txt": b"b" * 40, "c.txt": b"c" * 40})

    with caplog.at_level(logging.WARNING):
        e2b_driver._extract_context_tar(raw, tmp_path / "ctx")

    # First member (40 <= 50) lands; second would push total to 80 > 50 -> stop.
    assert (tmp_path / "ctx" / "a.txt").exists()
    assert not (tmp_path / "ctx" / "b.txt").exists()
    assert not (tmp_path / "ctx" / "c.txt").exists()
    assert any("total extraction cap" in r.message for r in caplog.records)


def test_path_traversal_still_skipped(tmp_path):
    raw = _tar_bytes({"../escape.txt": b"evil"})
    e2b_driver._extract_context_tar(raw, tmp_path / "ctx")
    assert not (tmp_path / "escape.txt").exists()
