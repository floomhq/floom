// #1022 — L4 permalink og-image + metadata.
//
// Two bugs are locked down here:
//  1. The og-image route streamed a 200 with a 0-byte body for real workers:
//     Satori threw MID-STREAM on `<div>Shared by {sharer}</div>` (a text node
//     PLUS an expression = two children on a non-flex div). Covered by (a) a
//     Satori flex-invariant walk over the ACTUAL rendered element tree — the
//     exact rule that threw — and (b) a fallback test proving a mid-render throw
//     yields the placeholder, NEVER an empty body.
//  2. og:image / canonical resolved to an unfetchable host without the /app
//     basePath. Covered by asserting generateMetadata emits an absolute,
//     basePath-aware URL on the real public host.

import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ---- mocks --------------------------------------------------------------

const fetchPublicWorkerPermalink = vi.fn();
vi.mock("@/lib/server-api", () => ({ fetchPublicWorkerPermalink }));

let requestHost: string | null = "floom.dev";
vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (k: string) => (k.toLowerCase() === "x-forwarded-host" ? requestHost : null),
  }),
}));

// Capture every element handed to ImageResponse and let the test decide whether
// arrayBuffer() succeeds (non-empty) or throws (simulating a Satori mid-render
// failure), so the fallback path is exercised deterministically without WASM.
const captured: ReactElement[] = [];
let throwOnRenders = 0; // number of leading arrayBuffer() calls that should throw
class MockImageResponse {
  private element: ReactElement;
  constructor(element: ReactElement) {
    this.element = element;
    captured.push(element);
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    if (throwOnRenders > 0) {
      throwOnRenders -= 1;
      throw new Error('Expected <div> to have explicit "display: flex" ...');
    }
    // Non-empty PNG-ish payload.
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]).buffer;
  }
}
vi.mock("next/og", () => ({ ImageResponse: MockImageResponse }));

// ---- Satori invariant walker (the rule that actually threw) --------------

const FLEX_DISPLAYS = new Set(["flex", "contents", "none"]);

function childCount(children: ReactNode): number {
  if (children === undefined || children === null || children === false) return 0;
  if (Array.isArray(children)) {
    return children.filter((c) => c !== undefined && c !== null && c !== false).length;
  }
  return 1;
}

// Throws the same way Satori does if a host <div> with >1 child lacks an
// explicit display. Walks the whole tree.
function assertSatoriFlexInvariant(node: ReactNode): void {
  if (!node || typeof node !== "object") return;
  const el = node as ReactElement<{ style?: Record<string, unknown>; children?: ReactNode }>;
  if (el.props) {
    const { style, children } = el.props;
    if (el.type === "div" && childCount(children) > 1) {
      const display = style?.display as string | undefined;
      if (!display || !FLEX_DISPLAYS.has(display)) {
        throw new Error(
          `Satori invariant: <div> with ${childCount(children)} children lacks display:flex`,
        );
      }
    }
    if (children !== undefined) {
      const arr = Array.isArray(children) ? children : [children];
      for (const c of arr) assertSatoriFlexInvariant(c as ReactNode);
    }
  }
}

// ---- fixtures ------------------------------------------------------------

const CARD = {
  entity_type: "worker_permalink",
  workspace: { id: "w", name: "depontefede", handle: "depontefede", profile_path: "/@depontefede" },
  worker: {
    id: "x",
    name: "Morning Brief",
    description: "Draft a concise 3-bullet morning brief every weekday at 8am Berlin time.",
    trigger_type: "schedule",
    connections: [],
    tags: [],
    inputs: [],
    outputs: [],
  },
  public_slug: "morning-brief",
  permalink: "/@depontefede/morning-brief",
  title: "Morning Brief",
  shared_by: { label: "depontefede" },
};

function resetMocks() {
  captured.length = 0;
  throwOnRenders = 0;
  requestHost = "floom.dev";
  fetchPublicWorkerPermalink.mockReset();
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_WORKEROS_DEPLOY", "cloud");
  vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/app");
}

// ---- og-image route ------------------------------------------------------

describe("#1022 og-image route", () => {
  afterEach(resetMocks);

  it("renders a NON-EMPTY png for a real public worker", async () => {
    resetMocks();
    fetchPublicWorkerPermalink.mockResolvedValue(CARD);
    const route = await import("@/app/[handle]/[workerSlug]/opengraph-image");
    const res = (await route.default({
      params: Promise.resolve({ handle: "%40depontefede", workerSlug: "morning-brief" }),
    })) as Response;
    const body = new Uint8Array(await res.arrayBuffer());
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(body.length).toBeGreaterThan(0);
  });

  it("the rendered worker-card tree satisfies the Satori flex invariant (regression for the empty-200)", async () => {
    resetMocks();
    fetchPublicWorkerPermalink.mockResolvedValue(CARD);
    const route = await import("@/app/[handle]/[workerSlug]/opengraph-image");
    await route.default({
      params: Promise.resolve({ handle: "%40depontefede", workerSlug: "morning-brief" }),
    });
    expect(captured.length).toBe(1);
    // Would throw on the original `<div>Shared by {sharer}</div>` two-child div.
    expect(() => assertSatoriFlexInvariant(captured[0])).not.toThrow();
  });

  it("falls back to the placeholder (NEVER an empty body) when the worker card throws mid-render", async () => {
    resetMocks();
    fetchPublicWorkerPermalink.mockResolvedValue(CARD);
    throwOnRenders = 1; // worker-card render throws; placeholder must save it
    const route = await import("@/app/[handle]/[workerSlug]/opengraph-image");
    const res = (await route.default({
      params: Promise.resolve({ handle: "%40depontefede", workerSlug: "morning-brief" }),
    })) as Response;
    const body = new Uint8Array(await res.arrayBuffer());
    expect(res.status).toBe(200);
    expect(body.length).toBeGreaterThan(0);
    // Two ImageResponse builds: the (throwing) worker card, then the placeholder.
    expect(captured.length).toBe(2);
    expect(() => assertSatoriFlexInvariant(captured[1])).not.toThrow();
  });

  it("renders the placeholder for a non-public / unknown handle", async () => {
    resetMocks();
    fetchPublicWorkerPermalink.mockResolvedValue(null);
    const route = await import("@/app/[handle]/[workerSlug]/opengraph-image");
    const res = (await route.default({
      params: Promise.resolve({ handle: "%40nobody", workerSlug: "nope" }),
    })) as Response;
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBeGreaterThan(0);
    expect(captured.length).toBe(1);
  });
});

// ---- metadata (og:image / canonical URL) --------------------------------

describe("#1022 permalink metadata", () => {
  afterEach(resetMocks);

  it("emits an absolute, basePath-aware og:image + canonical on the real host", async () => {
    resetMocks();
    fetchPublicWorkerPermalink.mockResolvedValue(CARD);
    const page = await import("@/app/[handle]/[workerSlug]/page");
    const meta = await page.generateMetadata({
      params: Promise.resolve({ handle: "%40depontefede", workerSlug: "morning-brief" }),
    });
    const img = meta.openGraph?.images;
    const imageUrl = Array.isArray(img) ? (img[0] as { url: string }).url : undefined;
    expect(imageUrl).toBe("https://floom.dev/app/%40depontefede/morning-brief/opengraph-image");
    expect(meta.openGraph?.url).toBe("https://floom.dev/app/%40depontefede/morning-brief");
    expect(meta.alternates?.canonical).toBe("https://floom.dev/app/%40depontefede/morning-brief");
    // Absolute + no infra alias + includes basePath.
    expect(imageUrl).toMatch(/^https:\/\/floom\.dev\/app\//);
    expect(imageUrl).not.toMatch(/r9-detail|vercel\.app|railway/);
  });

  it("noindexes and skips og for an unknown permalink", async () => {
    resetMocks();
    fetchPublicWorkerPermalink.mockResolvedValue(null);
    const page = await import("@/app/[handle]/[workerSlug]/page");
    const meta = await page.generateMetadata({
      params: Promise.resolve({ handle: "%40nobody", workerSlug: "nope" }),
    });
    expect(meta.robots).toMatchObject({ index: false });
    expect(meta.openGraph).toBeUndefined();
  });
});
