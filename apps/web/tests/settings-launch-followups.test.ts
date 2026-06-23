import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const settingsSource = fs.readFileSync(
  path.join(process.cwd(), "app/settings/page.tsx"),
  "utf8",
);

describe("settings launch follow-ups", () => {
  it("keeps the last members payload available across remounts", () => {
    expect(settingsSource).toContain("let membersSettingsCache");
    expect(settingsSource).toContain("useState<WorkspaceMembersResponse | null>(() => membersSettingsCache)");
    expect(settingsSource.match(/membersSettingsCache = res/g)?.length).toBeGreaterThanOrEqual(2);
    expect(settingsSource).toContain("if (alive) {");
  });

  it("uses in-app history for settings cross-links instead of a full reload", () => {
    expect(settingsSource).toContain("function navigateSettingsSelection");
    expect(settingsSource).toContain("window.history.pushState");
    expect(settingsSource).toContain('window.dispatchEvent(new PopStateEvent("popstate"))');
    expect(settingsSource).not.toContain("window.location.href = `/settings?");
  });
});
