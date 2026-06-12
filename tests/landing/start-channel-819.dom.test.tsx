// #819 — the "Works without the dashboard" row opens install flows directly
// (pre-auth /start/<channel> pages); sign-in only appears at the final bind
// step. Also pins the session-presence endpoint contract (#821).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import StartChannelPage, { generateStaticParams } from "@/app/start/[channel]/page";

const root = path.resolve(__dirname, "../..");

describe("pre-auth /start/<channel> pages (#819)", () => {
  it("covers slack, whatsapp and mcp", () => {
    expect(generateStaticParams().map((p) => p.channel).sort()).toEqual([
      "mcp",
      "slack",
      "whatsapp",
    ]);
  });

  it("slack: full flow shown pre-auth, sign-in deferred to the final CTA", async () => {
    render(await StartChannelPage({ params: Promise.resolve({ channel: "slack" }) }));
    expect(screen.getByText("WorkerOS in Slack")).toBeTruthy();
    const cta = screen.getByText("Add to Slack").closest("a")!;
    expect(cta.getAttribute("href")).toBe("/login?install=slack");
    // Within the page content the only /login reference is the final bind
    // CTA — the steps are public. (The shared nav chrome has its own CTA.)
    const main = document.querySelector("main")!;
    const anchors = Array.from(main.querySelectorAll("a")).filter((a) =>
      (a.getAttribute("href") ?? "").startsWith("/login"),
    );
    expect(anchors).toHaveLength(1);
  });

  it("whatsapp: pre-auth flow with deferred bind", async () => {
    render(await StartChannelPage({ params: Promise.resolve({ channel: "whatsapp" }) }));
    expect(screen.getByText("Connect WhatsApp").closest("a")!.getAttribute("href")).toBe(
      "/login?install=whatsapp",
    );
  });

  it("mcp: setup is fully public (docs link, no sign-in CTA)", async () => {
    render(await StartChannelPage({ params: Promise.resolve({ channel: "mcp" }) }));
    expect(screen.getByText("Read the MCP setup").closest("a")!.getAttribute("href")).toBe(
      "/v3/docs#mcp",
    );
  });

  it("landing row routes to /start/*, NOT /login (#819 regression)", () => {
    const body = readFileSync(path.join(root, "app/v3/V3Body.tsx"), "utf-8");
    const row = body.slice(body.indexOf("Works without the dashboard"));
    expect(row).toContain('href="/start/slack"');
    expect(row).toContain('href="/start/whatsapp"');
    expect(row).toContain('href="/start/mcp"');
    expect(row.slice(0, 600)).not.toContain("/login?install=");
  });
});
