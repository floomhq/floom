/**
 * detail-pane-engine.dom.test.tsx
 *
 * Parity tests for the detail-tab engine (DetailPane + DetailKit).
 * Covers:
 *   - Structured tabs: sections with rows/pairs/chips/note, and summary rows
 *   - Structured tab with empty section (no rows/pairs/chips) + `empty` fallback
 *   - Custom (escape-hatch) tab: render() is called, body renders freely
 *   - header.status pill is rendered when provided
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DetailPane } from "@/components/collection/DetailSplit";
import type { DetailTab, DetailHeader } from "@/lib/collection/types";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));

const TEST_TIMEOUT = 15_000;

/** Minimal header — no status or actions. */
function baseHeader(title = "Test Item"): DetailHeader {
  return { leading: null, title };
}

/** Renders DetailPane with one active tab and collects the DOM. */
function renderPane(header: DetailHeader, tabs: DetailTab[], activeTab: string) {
  const onTab = vi.fn();
  const onClose = vi.fn();
  const onCollapse = vi.fn();
  const { container } = render(
    <DetailPane
      header={header}
      tabs={tabs}
      activeTab={activeTab}
      onTab={onTab}
      onClose={onClose}
      onCollapse={onCollapse}
    />,
  );
  return container;
}

describe("detail-pane engine — structured tab", () => {
  it(
    "renders c-dgrp, c-drow, c-d2, c-dchip, c-dnote for a full section",
    () => {
      const tab: DetailTab = {
        key: "info",
        label: "Info",
        sections: [
          {
            key: "server",
            label: "Server",
            rows: [{ key: "endpoint", label: "Endpoint", value: "x" }],
            pairs: [{ key: "p1", label: "PairKey", value: "PairVal" }],
            chips: ["chipA"],
            note: "A helpful note",
          },
        ],
      };

      const container = renderPane(baseHeader(), [tab], "info");

      expect(container.querySelector(".c-dgrp")).toBeTruthy();
      expect(container.querySelector(".c-drow")).toBeTruthy();
      expect(screen.getByText("Endpoint")).toBeTruthy();
      expect(screen.getByText("x")).toBeTruthy();

      expect(container.querySelector(".c-d2")).toBeTruthy();
      expect(screen.getByText("PairKey")).toBeTruthy();
      expect(screen.getByText("PairVal")).toBeTruthy();

      expect(container.querySelector(".c-dchip")).toBeTruthy();
      expect(screen.getByText("chipA")).toBeTruthy();

      expect(container.querySelector(".c-dnote")).toBeTruthy();
      expect(screen.getByText("A helpful note")).toBeTruthy();
    },
    TEST_TIMEOUT,
  );

  it(
    "renders c-dsum for a structured tab with summary facts",
    () => {
      const tab: DetailTab = {
        key: "stats",
        label: "Stats",
        summary: [{ key: "runs", label: "Runs", value: "0" }],
      };

      const container = renderPane(baseHeader(), [tab], "stats");

      expect(container.querySelector(".c-dsum")).toBeTruthy();
      expect(screen.getByText("Runs")).toBeTruthy();
      expect(screen.getByText("0")).toBeTruthy();
    },
    TEST_TIMEOUT,
  );

  it(
    "renders c-dempty with the empty text when a section has no content",
    () => {
      const tab: DetailTab = {
        key: "tools",
        label: "Tools",
        sections: [
          {
            key: "tool-list",
            label: "Tools",
            // no rows/pairs/chips — triggers empty
            empty: "None",
          },
        ],
      };

      const container = renderPane(baseHeader(), [tab], "tools");

      expect(container.querySelector(".c-dempty")).toBeTruthy();
      expect(screen.getByText("None")).toBeTruthy();
    },
    TEST_TIMEOUT,
  );
});

describe("detail-pane engine — custom (escape-hatch) tab", () => {
  it(
    "calls render() and shows the custom body",
    () => {
      const tab: DetailTab = {
        key: "viewer",
        label: "File",
        custom: "file-viewer",
        render: () => <div>CUSTOM BODY</div>,
      };

      renderPane(baseHeader(), [tab], "viewer");

      expect(screen.getByText("CUSTOM BODY")).toBeTruthy();
      // No structured elements should appear
    },
    TEST_TIMEOUT,
  );
});

describe("detail-pane engine — header status pill", () => {
  it(
    "renders c-pill with the status label when header.status is set",
    () => {
      const header: DetailHeader = {
        leading: null,
        title: "My Connection",
        status: { tone: "ok", label: "Connected" },
      };

      const tab: DetailTab = {
        key: "overview",
        label: "Overview",
        summary: [{ key: "x", label: "X", value: "1" }],
      };

      const container = renderPane(header, [tab], "overview");

      const pill = container.querySelector(".c-pill");
      expect(pill).toBeTruthy();
      expect(pill!.textContent).toContain("Connected");
    },
    TEST_TIMEOUT,
  );
});
