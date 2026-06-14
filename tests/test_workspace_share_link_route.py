"""Regression guard for #205.

The WorkspaceSwitcher overlay used to POST to `/workspaces/{id}/share-links`,
a route that did not exist (404). The de-fork (PRs #203/#204) removed that
overlay and the cloud API gained a real workspace share-link route. This test
pins the route's existence so it can't silently disappear again.
"""

from __future__ import annotations

from apps.api.routes.workspaces import router as workspaces_router


def _route_methods() -> set[tuple[str, str]]:
    pairs: set[tuple[str, str]] = set()
    for route in workspaces_router.routes:
        for method in getattr(route, "methods", set()) or set():
            pairs.add((route.path, method))
    return pairs


def test_workspace_share_link_routes_registered():
    pairs = _route_methods()
    # The route whose absence caused the 404 in #205.
    assert ("/workspaces/{workspace_id}/share-links", "POST") in pairs
    # Its revoke counterpart, so a created link can be invalidated.
    assert ("/workspaces/{workspace_id}/share-links/{link_id}", "DELETE") in pairs
    # And the public preview path the share URL resolves against.
    assert ("/workspaces/shares/{token}", "GET") in pairs
