import base64
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


URL = "http://127.0.0.1:3100/connections/browse"
SCREENSHOT = "/tmp/workeros-t2c-browse.png"


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 1000})
    page = context.new_page()
    page.on("console", lambda msg: print("console", msg.type, msg.text))
    page.on("pageerror", lambda exc: print("pageerror", exc))
    page.on(
        "response",
        lambda res: print("api_response", res.status, res.url)
        if "/api/proxy/integrations/catalog" in res.url or "/api/proxy/connections" in res.url
        else None,
    )
    for attempt in range(30):
        response = page.goto(URL, wait_until="networkidle")
        print("status", response.status if response else "none", "attempt", attempt + 1)
        if response and response.status == 200 and page.get_by_role("heading", name="Browse integrations").count() > 0:
            break
        page.wait_for_timeout(1000)
    print("url", page.url)
    if page.get_by_role("heading", name="Browse integrations").count() == 0:
        print(page.content()[:2000])

    expect(page.get_by_role("heading", name="Browse integrations")).to_be_visible()
    try:
        page.wait_for_selector("article img", timeout=30000)
    except Exception:
        print("body_text", page.locator("body").inner_text()[:2000])
        raise
    cdp = context.new_cdp_session(page)
    png = cdp.send("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})["data"]
    Path(SCREENSHOT).write_bytes(base64.b64decode(png))

    total_text = page.locator("text=/of [0-9,]+ integrations/").first().inner_text()
    initial_total = int(total_text.split(" of ", 1)[1].split(" integrations", 1)[0].replace(",", ""))
    card_count = page.locator("article").count()
    logo_count = page.locator("article img").evaluate_all(
        "(imgs) => imgs.filter((img) => img.complete && img.naturalWidth > 0 && img.currentSrc).length"
    )
    assert initial_total >= 100, initial_total
    assert card_count == 30, card_count
    assert logo_count == 30, logo_count

    page.get_by_label("Search integrations").fill("gmail")
    page.wait_for_timeout(500)
    page.wait_for_load_state("networkidle")
    expect(page.get_by_role("heading", name="Browse integrations")).to_be_visible()
    page.wait_for_selector("article img", timeout=30000)
    search_total_text = page.locator("text=/of [0-9,]+ integrations/").first().inner_text()
    search_total = int(search_total_text.split(" of ", 1)[1].split(" integrations", 1)[0].replace(",", ""))
    assert 0 < search_total < initial_total, (search_total, initial_total)

    with context.expect_page() as popup_info:
        page.locator("article", has_text="Gmail").get_by_role("button", name="Connect").click()
    popup = popup_info.value
    popup.wait_for_load_state("domcontentloaded", timeout=30000)
    popup.wait_for_timeout(1500)
    assert popup.url.startswith("https://backend.composio.dev/") or "composio" in popup.url, popup.url

    Path("/tmp/workeros-t2c-step-2.PASS").write_text(
        f"Step 2 browse UI verified. total={initial_total}, search_total={search_total}, popup={popup.url}\\n",
        encoding="utf-8",
    )
    browser.close()

print(f"screenshot={SCREENSHOT}")
