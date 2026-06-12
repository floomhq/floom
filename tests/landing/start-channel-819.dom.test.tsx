// #819 — channel install stays pre-auth, but the landing row exposes
// non-dev-friendly inline controls instead of dumping visitors into docs.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
    expect(screen.getByText("Floom in Slack")).toBeTruthy();
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
    fireEvent.click(screen.getByText("WhatsApp QR"));
    expect(screen.getByText("Open pairing flow").closest("a")!.getAttribute("href")).toBe("/login?install=whatsapp");
    expect(screen.getByText("Connect WhatsApp")).toBeTruthy();
  });

  it("mcp: setup is fully public with inline config, not a docs dump", async () => {
    render(await StartChannelPage({ params: Promise.resolve({ channel: "mcp" }) }));
    fireEvent.click(screen.getByText("MCP config"));
    expect(screen.getByText("Copy config")).toBeTruthy();
    expect(screen.getAllByText(/@floomhq\/workeros/).length).toBeGreaterThan(0);
    expect(screen.queryByText("Read the MCP setup")).toBeNull();
  });

  it("landing row exposes inline channel controls, not docs links", () => {
    const body = readFileSync(path.join(root, "app/v3/V3Body.tsx"), "utf-8");
    const row = body.slice(body.indexOf("Works without the dashboard"));
    expect(row).toContain("<ChannelActions />");
    expect(row.slice(0, 800)).not.toContain("/docs");
  });
});
