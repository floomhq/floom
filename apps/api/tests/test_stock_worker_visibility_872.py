"""#872 — PUBLIC/PROTECTED stock worker sets must not include a tenant's real
private workers (they bypass visibility=private for any member).

Root cause: PUBLIC_STOCK_WORKER_IDS (and PROTECTED_STOCK_WORKER_IDS, consulted
by Emily's _worker_can_view) listed real private workers that read a tenant's
connected accounts (personal Gmail / CRM / analytics / recruiting integrations).
_get_visible_worker returns stock ids to ANY member regardless of visibility, so
members could list/run them. Fix: curate both sets to ship-with-product
templates + system workers only.

Run: cd apps/api && python -m pytest tests/test_stock_worker_visibility_872.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

# Account-reading example/template workers: these ship as is_example demos but
# must NEVER be in the cross-member stock-bypass sets — a member should only
# see/run them after owning a copy, never via the stock visibility bypass.
PRIVATE_WORKERS = {
    "gmail_inbox_manager",
    "gmail_intake_brief",
    "gmail-inbox-manager-plus",
    "gmail-smart-replies",
    "gmail-summarize-latest",
    "linkedin-post-engagements",
}

# genuine ship-with-product templates that MUST remain accessible
KEPT_TEMPLATES = {
    "csv_enricher",
    "github-digest",
    "node-smoke-test",
    "openblog",
    "opendraft",
    "outbound-approval-demo",
    "research_brief",
}


@pytest.fixture(scope="module")
def main():
    return importlib.import_module("main")


def test_private_workers_not_public_stock(main):
    leaked = PRIVATE_WORKERS & main.PUBLIC_STOCK_WORKER_IDS
    assert not leaked, f"private workers still in PUBLIC_STOCK_WORKER_IDS: {leaked}"


def test_private_workers_not_protected_stock(main):
    leaked = PRIVATE_WORKERS & main.PROTECTED_STOCK_WORKER_IDS
    assert not leaked, f"private workers still in PROTECTED_STOCK_WORKER_IDS: {leaked}"


def test_genuine_templates_still_stock(main):
    missing = KEPT_TEMPLATES - main.PUBLIC_STOCK_WORKER_IDS
    assert not missing, f"genuine templates dropped from PUBLIC_STOCK_WORKER_IDS: {missing}"


def test_system_workers_remain_protected(main):
    # removing these would break engine internals
    for wid in ("workspace-agent", "worker-author", "slack-listener", "whatsapp-listener"):
        assert wid in main.PROTECTED_STOCK_WORKER_IDS
