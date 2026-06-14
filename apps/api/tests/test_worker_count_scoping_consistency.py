"""Regression: Overview and Workers-page worker counts must use identical scoping.

Root cause (2026-06-14 audits, data-scoping HIGH): the SAME workspace reported
three different worker counts — Emily 0, Overview 78, Workers page 104. The
Workers page (`list_workers`) resolved the access user id + role via
`_worker_access_user_id(auth)` + `_worker_repo_role(auth)`, while the Overview
(`system_overview` -> `_list_operator_workers`) used the RAW `auth.user_id` and
NO role. An admin member therefore saw the full workspace set on /workers but a
narrower owner-only set on the overview. Fix: the overview must resolve and
thread the IDENTICAL access user id + role.
"""

import inspect
import re

# PR #1073 ("oss-prep") moved these out of main.py into core/services/routers.
# Inspect the real functions at their new homes (robust to further file moves)
# rather than grepping main.py text.
from routers.overview import system_overview
from routers.worker_listing import list_workers
from services.worker_access import _list_operator_workers


def test_list_operator_workers_accepts_role():
    sig = inspect.getsource(_list_operator_workers)[:400]
    assert "role" in sig, "_list_operator_workers must accept a role parameter"


def test_list_workers_resolves_access_id_and_role():
    """Sanity-anchor: GET /workers uses _worker_access_user_id + _worker_repo_role."""
    fn = inspect.getsource(list_workers)
    assert "_worker_access_user_id(auth)" in fn
    assert "_worker_repo_role(auth)" in fn


def test_overview_uses_same_access_id_and_role_as_workers_page():
    """The overview worker fetch must resolve the access id + role identically."""
    fn_body = inspect.getsource(system_overview)
    # Must resolve the access-scoped user id and role exactly like /workers.
    assert "_worker_access_user_id(auth)" in fn_body, (
        "overview must resolve the access user id like GET /workers"
    )
    assert "_worker_repo_role(auth)" in fn_body, (
        "overview must resolve the repo role like GET /workers"
    )
    # The operator-worker list call inside the overview must pass role through.
    op_call = re.search(r"_list_operator_workers\((.*?)\)", fn_body, re.DOTALL)
    assert op_call is not None, "overview must call _list_operator_workers"
    assert "role=" in op_call.group(1), (
        "overview's _list_operator_workers call must pass role= for consistent scoping"
    )
    # The DB denominator must NOT use the raw auth.user_id anymore.
    assert "repos.workers.list(user_id=auth.user_id)" not in fn_body, (
        "overview DB worker list must use the access-resolved user id, not raw auth.user_id"
    )
