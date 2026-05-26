import base64
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

BASE = "http://127.0.0.1:3007"
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
        "email": "federico@floom.dev",
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


def install_routes(page, connections, delay_connections_ms=0):
    def route_handler(route):
        url = route.request.url
        if "/api/proxy/connections" in url and "/status" not in url:
            if delay_connections_ms:
                page.wait_for_timeout(delay_connections_ms)
            route.fulfill(json=connections)
            return
        if "/api/proxy/workers/" in url:
            worker_id = url.rsplit("/", 1)[-1]
            route.fulfill(json=WORKER_DETAILS[worker_id])
            return
        if "/api/proxy/workers" in url:
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


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        page = browser.new_page(viewport={"width": 1440, "height": 980})
        install_routes(page, CONNECTIONS)
        page.goto(f"{BASE}/connections")
        page.wait_for_load_state("networkidle")
        page.add_style_tag(content=NO_MOTION_CSS)
        expect(page.get_by_role("heading", name="Connections")).to_be_visible()
        expect(page.get_by_text("Connected as federico@floom.dev")).to_be_visible()
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

        mobile = browser.new_page(viewport={"width": 390, "height": 920})
        install_routes(mobile, CONNECTIONS)
        mobile.goto(f"{BASE}/connections")
        mobile.wait_for_load_state("networkidle")
        mobile.add_style_tag(content=NO_MOTION_CSS)
        expect(mobile.get_by_text("Connected as federico@floom.dev")).to_be_visible()
        capture(mobile, "workeros-t2a-connections-mobile.png")

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

        skeleton = browser.new_page(viewport={"width": 1180, "height": 820})
        install_routes(skeleton, CONNECTIONS, delay_connections_ms=700)
        skeleton.goto(f"{BASE}/connections")
        skeleton.wait_for_timeout(120)
        skeleton.add_style_tag(content=NO_MOTION_CSS)
        expect(skeleton.locator('[data-slot="skeleton"]').first).to_be_visible()
        capture(skeleton, "workeros-t2a-connections-skeleton.png")

        browser.close()
    print("connections UI verified")


if __name__ == "__main__":
    main()
