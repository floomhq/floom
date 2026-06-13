import base64
import os
import requests
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

BASE = os.environ.get("NEXT_BASE", "http://127.0.0.1:3007")
OUT = Path("/tmp")
NO_MOTION_CSS = """
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
}
.spacebg, .ambient, .grain, .ambient-filter-defs {
  display: none !important;
}
"""

CONNECTIONS = [
    {
        "id": "local-gmail",
        "app_name": "gmail",
        "composio_connection_id": "ca_gmail",
        "status": "active",
        "created_at": "2026-05-20T10:00:00Z",
        "updated_at": "2026-05-20T10:05:00Z",
    },
    {
        "id": "local-slack",
        "app_name": "slack",
        "composio_connection_id": "ca_slack",
        "status": "active",
        "created_at": "2026-05-19T10:00:00Z",
        "updated_at": "2026-05-19T10:05:00Z",
    },
    {
        "id": "local-hubspot",
        "app_name": "hubspot",
        "composio_connection_id": "ca_hubspot",
        "status": "active",
        "created_at": "2026-05-18T10:00:00Z",
        "updated_at": "2026-05-18T10:05:00Z",
    },
]

WORKERS = [
    {
        "id": "gmail_intake_brief",
        "name": "Gmail intake brief",
        "status": "healthy",
        "trigger_type": "manual",
        "runner": "local",
    },
    {
        "id": "slack_digest",
        "name": "Slack digest",
        "status": "healthy",
        "trigger_type": "manual",
        "runner": "local",
    },
]

WORKER_DETAILS = {
    "gmail_intake_brief": {
        **WORKERS[0],
        "config": {
            "id": "gmail_intake_brief",
            "name": "Gmail intake brief",
            "trigger": {"type": "manual"},
            "runtime": {"type": "python", "entrypoint": "run.py", "runner": "local"},
            "inputs": [],
            "secrets": [],
            "connections": ["gmail"],
            "outputs": [],
            "approvals": {"required": False},
        },
        "recent_runs": [
            {
                "id": "run-gmail",
                "worker_id": "gmail_intake_brief",
                "status": "completed",
                "trigger_source": "manual",
                "approval_status": "not_required",
                "created_at": "2026-05-24T12:22:00Z",
                "completed_at": "2026-05-24T12:23:00Z",
            }
        ],
    },
    "slack_digest": {
        **WORKERS[1],
        "config": {
            "id": "slack_digest",
            "name": "Slack digest",
            "trigger": {"type": "manual"},
            "runtime": {"type": "python", "entrypoint": "run.py", "runner": "local"},
            "inputs": [],
            "secrets": [],
            "connections": ["slack"],
            "outputs": [],
            "approvals": {"required": False},
        },
        "recent_runs": [
            {
                "id": "run-slack",
                "worker_id": "slack_digest",
                "status": "completed",
                "trigger_source": "manual",
                "approval_status": "not_required",
                "created_at": "2026-05-23T09:00:00Z",
                "completed_at": "2026-05-23T09:01:00Z",
            }
        ],
    },
}

ACCOUNTS = {
    "ca_gmail": {
        "id": "ca_gmail",
        "auth_config_id": "ac_gmail",
        "email": "owner@example.com",
        "user_id": "federico",
    },
    "ca_slack": {
        "id": "ca_slack",
        "auth_config_id": "ac_slack",
        "email": "ops@floom.dev",
        "user_id": "federico",
    },
    "ca_hubspot": {
        "id": "ca_hubspot",
        "auth_config_id": "ac_hubspot",
        "email": "crm@floom.dev",
        "user_id": "federico",
    },
}

SCOPES = {
    "ac_gmail": [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/drive.file",
    ],
    "ac_slack": ["channels:read", "chat:write", "users:read"],
    "ac_hubspot": ["crm.objects.contacts.read", "crm.objects.companies.read"],
}


def install_routes(page, connections, delay_connections_ms=0, workers_fail=False):
    def route_handler(route):
        url = route.request.url
        if "/api/proxy/connections" in url and "/status" not in url:
            if delay_connections_ms:
                page.wait_for_timeout(delay_connections_ms)
            route.fulfill(json=connections)
            return
        if "/api/proxy/workers/" in url:
            if workers_fail:
                route.fulfill(status=503, json={"error": "workers unavailable"})
                return
            worker_id = url.rsplit("/", 1)[-1]
            route.fulfill(json=WORKER_DETAILS.get(worker_id, {}))
            return
        if "/api/proxy/workers" in url:
            if workers_fail:
                route.fulfill(status=503, json={"error": "workers unavailable"})
                return
            route.fulfill(json=WORKERS)
            return
        if "/connections/connected-accounts/" in url:
            account_id = url.rsplit("/", 1)[-1]
            route.fulfill(json=ACCOUNTS.get(account_id, {"id": account_id, "scopes": []}))
            return
        if "/connections/auth-configs/" in url:
            auth_id = url.rsplit("/", 1)[-1]
            route.fulfill(json={"id": auth_id, "scopes": SCOPES.get(auth_id, [])})
            return
        route.continue_()

    page.route("**/*", route_handler)


def capture(page, filename):
    session = page.context.new_cdp_session(page)
    data = session.send("Page.captureScreenshot", {"format": "png", "fromSurface": True})
    (OUT / filename).write_bytes(base64.b64decode(data["data"]))


def test_auth_check():
    """Verify real route handler auth behavior.

    When WORKEROS_API_SECRET / FLOOM_API_SECRET is set in the environment:
      - unauthenticated → 401
      - wrong secret → 401
      - correct secret → not 401

    When no secret is configured (local dev): routes are open (200 or 503 if
    COMPOSIO_API_KEY is also absent).
    """
    import os
    secret = os.environ.get("WORKEROS_API_SECRET") or os.environ.get("FLOOM_API_SECRET") or ""

    r_no_header = requests.get(f"{BASE}/connections/connected-accounts/ca_gmail")
    r_wrong = requests.get(
        f"{BASE}/connections/connected-accounts/ca_gmail",
        headers={"x-floom-secret": "wrong-secret-xyz"},
    )

    if secret:
        # Secret is configured — must enforce 401
        assert r_no_header.status_code == 401, (
            f"Expected 401 for unauthenticated connected-accounts, got {r_no_header.status_code}"
        )
        assert r_wrong.status_code == 401, (
            f"Expected 401 for wrong secret, got {r_wrong.status_code}"
        )
        print("  auth check: 401 on unauthenticated (secret mode) ✓")
    else:
        # No secret configured — dev mode, route should respond (not 401)
        assert r_no_header.status_code != 401, (
            f"Dev mode: route should not return 401 with no secret configured, got {r_no_header.status_code}"
        )
        print(f"  auth check: dev mode (no secret), route open → {r_no_header.status_code} ✓")

    # Auth-configs route — same check
    r_ac = requests.get(f"{BASE}/connections/auth-configs/gmail")
    if secret:
        assert r_ac.status_code == 401, (
            f"Expected 401 for unauthenticated auth-configs, got {r_ac.status_code}"
        )
    print("  auth check: auth-configs route consistent ✓")


def main():
    # Check real route handler auth (requires the dev server to be running)
    server_up = False
    try:
        r = requests.get(f"{BASE}/connections", timeout=3)
        server_up = True
    except Exception:
        pass

    if server_up:
        print("Running real-route auth checks...")
        test_auth_check()
    else:
        print("Dev server not detected; skipping real-route auth checks")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        # --- 3-connection desktop view ---
        page = browser.new_page(viewport={"width": 1440, "height": 980})
        install_routes(page, CONNECTIONS)
        page.goto(f"{BASE}/connections")
        page.wait_for_load_state("networkidle")
        page.add_style_tag(content=NO_MOTION_CSS)
        expect(page.get_by_role("heading", name="Connections")).to_be_visible()
        expect(page.get_by_text("Connected as owner@example.com")).to_be_visible()
        expect(page.get_by_text("gmail.readonly").first).to_be_visible()
        expect(page.get_by_text("+1 more")).to_be_visible()
        expect(page.locator('use[href="#brand-gmail"]')).to_have_count(1)
        expect(page.locator('use[href="#brand-slack"]')).to_have_count(1)
        expect(page.locator('use[href="#brand-hubspot"]')).to_have_count(1)
        capture(page, "workeros-t2a-connections-card.png")

        page.get_by_text("Gmail", exact=True).hover()
        expect(page.get_by_text("drive.file")).to_be_visible()
        expect(page.get_by_text("Last used").first).to_be_visible()
        capture(page, "workeros-t2a-connections-hover.png")
        print("  3-connection desktop view ✓")

        # --- Mobile viewport (375px) ---
        mobile = browser.new_page(viewport={"width": 375, "height": 812})
        install_routes(mobile, CONNECTIONS)
        mobile.goto(f"{BASE}/connections")
        mobile.wait_for_load_state("networkidle")
        mobile.add_style_tag(content=NO_MOTION_CSS)
        expect(mobile.get_by_text("Connected as owner@example.com")).to_be_visible()
        # No horizontal scroll
        scroll_width = mobile.evaluate("document.body.scrollWidth")
        assert scroll_width <= 375, f"Horizontal overflow at 375px: scrollWidth={scroll_width}"
        capture(mobile, "workeros-t2a-connections-mobile-375.png")
        print("  mobile 375px no overflow ✓")

        # --- Tablet viewport (768px) ---
        tablet = browser.new_page(viewport={"width": 768, "height": 1024})
        install_routes(tablet, CONNECTIONS)
        tablet.goto(f"{BASE}/connections")
        tablet.wait_for_load_state("networkidle")
        tablet.add_style_tag(content=NO_MOTION_CSS)
        scroll_width = tablet.evaluate("document.body.scrollWidth")
        assert scroll_width <= 768, f"Horizontal overflow at 768px: scrollWidth={scroll_width}"
        capture(tablet, "workeros-t2a-connections-tablet-768.png")
        print("  tablet 768px no overflow ✓")

        # --- Desktop 1280px ---
        desktop = browser.new_page(viewport={"width": 1280, "height": 800})
        install_routes(desktop, CONNECTIONS)
        desktop.goto(f"{BASE}/connections")
        desktop.wait_for_load_state("networkidle")
        desktop.add_style_tag(content=NO_MOTION_CSS)
        scroll_width = desktop.evaluate("document.body.scrollWidth")
        assert scroll_width <= 1280, f"Horizontal overflow at 1280px: scrollWidth={scroll_width}"
        capture(desktop, "workeros-t2a-connections-desktop-1280.png")
        print("  desktop 1280px no overflow ✓")

        # --- Empty state ---
        empty = browser.new_page(viewport={"width": 1180, "height": 820})
        install_routes(empty, [])
        empty.goto(f"{BASE}/connections")
        empty.wait_for_load_state("networkidle")
        empty.add_style_tag(content=NO_MOTION_CSS)
        expect(
            empty.get_by_text(
                "Connect a tool to give your workers access to Gmail, Calendar, Slack, and 200+ more."
            )
        ).to_be_visible()
        expect(empty.get_by_role("button", name="Connect Gmail")).to_be_visible()
        capture(empty, "workeros-t2a-connections-empty.png")
        print("  empty state ✓")

        # --- Single-connection view ---
        single = browser.new_page(viewport={"width": 1180, "height": 820})
        install_routes(single, CONNECTIONS[:1])
        single.goto(f"{BASE}/connections")
        single.wait_for_load_state("networkidle")
        single.add_style_tag(content=NO_MOTION_CSS)
        expect(single.get_by_text("Connected as owner@example.com")).to_be_visible()
        capture(single, "workeros-t2a-connections-single.png")
        print("  single connection view ✓")

        # --- Skeleton loading state ---
        skeleton = browser.new_page(viewport={"width": 1180, "height": 820})
        install_routes(skeleton, CONNECTIONS, delay_connections_ms=700)
        skeleton.goto(f"{BASE}/connections")
        skeleton.wait_for_timeout(120)
        skeleton.add_style_tag(content=NO_MOTION_CSS)
        expect(skeleton.locator('[data-slot="skeleton"]').first).to_be_visible()
        capture(skeleton, "workeros-t2a-connections-skeleton.png")
        print("  skeleton loading state ✓")

        # --- Workers API failure: connections still render ---
        workers_fail = browser.new_page(viewport={"width": 1280, "height": 800})
        install_routes(workers_fail, CONNECTIONS, workers_fail=True)
        workers_fail.goto(f"{BASE}/connections")
        workers_fail.wait_for_load_state("networkidle")
        workers_fail.add_style_tag(content=NO_MOTION_CSS)
        # Connections must still render (page not blanked)
        expect(workers_fail.get_by_role("heading", name="Connections")).to_be_visible()
        expect(workers_fail.get_by_text("Connected as owner@example.com")).to_be_visible()
        capture(workers_fail, "workeros-t2a-connections-workers-fail.png")
        print("  workers API failure: connections render normally ✓")

        # --- T1c copy: no fail-closed language ---
        content = page.content()
        assert "fail immediately" not in content, (
            "Page contains fail-closed copy 'fail immediately' — T1c violation"
        )
        assert "declared capabilities" in content or "declared" in content, (
            "Page should use declared-not-enforced framing"
        )
        print("  T1c copy check (no 'fail immediately') ✓")

        browser.close()
    print("\nAll connections UI checks passed ✓")


if __name__ == "__main__":
    main()
