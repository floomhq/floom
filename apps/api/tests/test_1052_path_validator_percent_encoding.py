"""#1052 (item 2) — path-validator inconsistency: `..%2f` was accepted as a
literal filename by workers.write_file while contexts.write rejected the decoded
traversal. Both validators now reject percent-encoded path separators (%2f/%5c)
so they agree.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import main
from contexts import normalize_context_file_path

ENCODED = ["..%2fzz.txt", "..%2Fzz.txt", "..%5cx", "..%5Cx", "dir%2f..%2fetc"]


@pytest.mark.parametrize("bad", ENCODED)
def test_worker_file_path_rejects_percent_encoded_separators(bad):
    with pytest.raises(HTTPException) as exc:
        main._validate_worker_file_path(bad)
    assert exc.value.status_code == 400


@pytest.mark.parametrize("bad", ENCODED)
def test_context_file_path_rejects_percent_encoded_separators(bad):
    with pytest.raises(ValueError):
        normalize_context_file_path(bad)


def test_worker_file_path_accepts_normal_names():
    for ok in ("run.py", "lib/helper.py", "docs/notes.md"):
        main._validate_worker_file_path(ok)  # no raise


def test_context_file_path_accepts_normal_names():
    assert normalize_context_file_path("notes.md") == "notes.md"
    assert normalize_context_file_path("a/b/c.txt") == "a/b/c.txt"


def test_existing_plain_traversal_still_rejected():
    with pytest.raises(HTTPException):
        main._validate_worker_file_path("../etc/passwd")
    with pytest.raises(ValueError):
        normalize_context_file_path("../etc/passwd")
