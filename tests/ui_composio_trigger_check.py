from playwright.sync_api import sync_playwright, expect

TRIGGERS = {
    "items": [
        {
            "event": "GMAIL_NEW_EMAIL",
            "name": "New Gmail Email",
            "display_name": "New Gmail Email",
            "description": "Fires when Gmail receives a new email.",
            "toolkit": {"slug": "gmail", "name": "Gmail"},
        },
        {
            "event": "SLACK_MESSAGE_POSTED",
            "name": "Slack Message Posted",
            "display_name": "Slack Message Posted",
            "toolkit": {"slug": "slack", "name": "Slack"},
        },
    ]
}

CONNECTIONS = [
    {
        "id": "local-gmail",
        "app_name": "gmail",
        "composio_connection_id": "conn_gmail_federico_stub",
        "status": "active",
        "created_at": "2026-05-26T00:00:00Z",
        "updated_at": "2026-05-26T00:00:00Z",
    }
]

WORKER = {
    "id": "gmail-composio",
    "name": "Gmail Composio",
    "description": "Run from a Composio Gmail event.",
    "status": "healthy",
    "paused": False,
    "trigger_type": "composio",
    "runner": "local",
    "config": {
        "id": "gmail-composio",
        "name": "Gmail Composio",
        "description": "Run from a Composio Gmail event.",
        "trigger": {
            "type": "composio",
            "composio": {
                "event": "GMAIL_NEW_EMAIL",
                "connection_id": "conn_gmail_federico_stub",
                "filters": {},
            },
        },
        "runtime": {"type": "python", "entrypoint": "run.py", "runner": "local"},
        "inputs": [],
        "secrets": [],
        "connections": ["gmail"],
        "outputs": [],
        "approvals": {"required": False},
    },
    "recent_runs": [],
    "manifest_yaml": 'schema_version: "0.3"\nname: gmail-composio\ntrigger:\n  type: composio\n',
    "run_py": "def run(inputs, context):\n    return {'status':'success','outputs':{},'artifacts':[]}\n",
}


def fulfill_json(route, data):
    route.fulfill(status=200, content_type="application/json", body=__import__("json").dumps(data))


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1200})
    page.route("**/api/proxy/integrations/triggers", lambda route: fulfill_json(route, TRIGGERS))
    page.route("**/api/proxy/connections", lambda route: fulfill_json(route, CONNECTIONS))
    page.route("**/api/proxy/workers/gmail-composio", lambda route: fulfill_json(route, WORKER))

    page.goto("http://127.0.0.1:3007/workers/new?trigger=composio")
    page.wait_for_load_state("networkidle")
    print(page.url)
    print(page.locator("body").inner_text())
    expect(page.get_by_text("Search events")).to_be_visible()
    expect(page.get_by_text("Filters JSON")).to_be_visible()
    page.screenshot(path="/tmp/workeros-t15a-new-composio.png", full_page=True)

    page.goto("http://127.0.0.1:3007/workers/gmail-composio/edit")
    page.wait_for_load_state("networkidle")
    expect(page.get_by_text("Composio event")).to_be_visible()
    expect(page.get_by_text("Filters JSON")).to_be_visible()
    page.screenshot(path="/tmp/workeros-t15a-edit-composio.png", full_page=True)
    browser.close()
