// Emily home — first-worker post-signup hero (funnel reframe).
//
// The post-signup home must be HONEST about the two real activation paths and
// must NOT promise Emily builds a worker from prose (prose authoring is disabled
// server-side — chat_service WORKER_AUTHORING_RULES). Guarantees:
//   1. Primary path (Cloud): "Browse templates" routes to the templates gallery.
//   2. Secondary path: "Set up in your coding agent" opens the MCP install path.
//   3. Emily is framed as a HELPER (ask a question) — no "Emily builds it" copy,
//      no "Create a … worker" seed pills that dead-end on disabled authoring.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/query/hooks", () => ({
  // First-worker gate: 0 real workers, loaded successfully (not error/loading).
  useOverview: () => ({
    data: { stats: { work_shipped_7d: 0 }, outcomes: [], recent_runs: [], scheduled_today: [], needs_attention: [] },
    isError: false,
    isLoading: false,
  }),
  useWorkers: () => ({ data: [], isError: false, isLoading: false }),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  return {
    ...mod,
    api: {
      ...(mod.api as Record<string, unknown>),
      me: vi.fn().mockResolvedValue({ display_name: "Fede", email: "fede@floom.dev" }),
    },
  };
});

import { EmilyHomeEmpty } from "@/components/home/EmilyHomeEmpty";
import { PromptInput } from "@/components/emily/PromptInput";

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
});

function renderFirstWorker() {
  return render(<EmilyHomeEmpty onSeed={() => {}} onPickMcp={() => {}} />);
}

describe("Emily home empty — first-worker two-path hero (Cloud)", () => {
  beforeEach(() => {
    // Templates gallery is a Cloud-only surface; the primary path only renders
    // when the dashboard is the managed Cloud wrapper.
    vi.stubEnv("NEXT_PUBLIC_WORKEROS_DEPLOY", "cloud");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders the first-worker hero heading", async () => {
    renderFirstWorker();
    expect(await screen.findByText(/hire your first worker/i)).toBeInTheDocument();
  });

  it("does NOT claim Emily builds a worker from prose", async () => {
    renderFirstWorker();
    await screen.findByText(/hire your first worker/i);
    expect(screen.queryByText(/builds it, connects the tools/i)).not.toBeInTheDocument();
    // No "Create a … worker" seed pills (they dead-end on disabled authoring).
    expect(screen.queryByRole("button", { name: /Create a Linear triage worker/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Daily GitHub PR digest/i })).not.toBeInTheDocument();
  });

  it("primary path: 'Browse templates' links to the templates gallery", async () => {
    renderFirstWorker();
    await screen.findByText(/hire your first worker/i);
    const link = screen.getByRole("link", { name: /Browse templates/i });
    expect(link.getAttribute("href")).toMatch(/\/templates$/);
  });

  it("secondary path: 'Set up in your coding agent' opens the MCP install path", async () => {
    const onPickMcp = vi.fn();
    render(<EmilyHomeEmpty onSeed={() => {}} onPickMcp={onPickMcp} />);
    await screen.findByText(/hire your first worker/i);
    screen.getByRole("button", { name: /Set up in your coding agent/i }).click();
    expect(onPickMcp).toHaveBeenCalledTimes(1);
  });

  it("Emily-as-helper: seeds a question she can answer (not a build prompt)", async () => {
    const onSeed = vi.fn();
    render(<EmilyHomeEmpty onSeed={onSeed} onPickMcp={() => {}} />);
    await screen.findByText(/hire your first worker/i);
    screen.getByRole("button", { name: /How do workers work\?/i }).click();
    expect(onSeed).toHaveBeenCalledWith("How do workers work?");
  });
});

describe("Emily home empty — first-worker hero (OSS self-host, no gallery)", () => {
  it("omits the templates path and promotes the coding-agent path", async () => {
    // Default (non-cloud) env: no NEXT_PUBLIC_WORKEROS_DEPLOY=cloud.
    renderFirstWorker();
    await screen.findByText(/hire your first worker/i);
    expect(screen.queryByRole("link", { name: /Browse templates/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Set up in your coding agent/i })).toBeInTheDocument();
  });
});

describe("Emily home composer - bigger, borderless, no Uses row", () => {
  it("hero composer (landing + large) is borderless and has no 'Uses' chip row", () => {
    const { container } = render(
      <PromptInput
        value="Summarise my Granola meetings → HubSpot"
        onChange={() => {}}
        onSubmit={() => {}}
        onFilesChange={() => {}}
        attachedFiles={[]}
        variant="landing"
        large
      />,
    );
    const textarea = screen.getByRole("textbox", { name: /describe the job/i });
    const wrapper = textarea.closest(".rounded-xl") as HTMLElement;
    // Borderless (landing): no divider outline; grey bg-2 fill for discoverability.
    expect(wrapper.className).not.toContain("[border:var(--bd-div)]");
    expect(wrapper.className).toContain("bg-[var(--bg-2)]");
    expect(wrapper.className).not.toContain("bg-[var(--bg-app)]");
    // Larger hero sizing: roomier padding + bigger min-height than the compact
    // conversation composer.
    expect(textarea.className).toContain("min-h-[60px]");
    expect(textarea.className).toContain("text-[15px]");
    // No "Uses" / "Will use" PromptChips row in the landing composer even though
    // the prompt clearly references Granola + HubSpot.
    expect(container.textContent).not.toContain("Uses");
    expect(container.textContent).not.toContain("Will use");
    // But the tools are still highlighted inline in the prompt itself with the
    // same BrandLogo token treatment as the landing examples.
    const brandUses = Array.from(container.querySelectorAll("use"))
      .map((u) => u.getAttribute("href") || "")
      .filter((h) => h.startsWith("#brand-"));
    expect(brandUses).toContain("#brand-granola");
    expect(brandUses).toContain("#brand-hubspot");
    const token = container.querySelector("span.bg-\\[var\\(--bg-3\\)\\]");
    expect(token).not.toBeNull();
    expect(token!.textContent).toContain("Granola");
    expect(token!.parentElement?.className).toContain("ph-no-capture");
  });

  it("default conversation composer keeps the Uses chip row", () => {
    const { container } = render(
      <PromptInput
        value="Summarise my Granola meetings → HubSpot"
        onChange={() => {}}
        onSubmit={() => {}}
        onFilesChange={() => {}}
        attachedFiles={[]}
        variant="default"
      />,
    );
    const textarea = screen.getByRole("textbox", { name: /describe the job/i });
    const wrapper = textarea.closest(".rounded-xl") as HTMLElement;
    expect(wrapper.className).toContain("bg-[var(--bg-2)]");
    expect(wrapper.className).not.toContain("[border:var(--bd-div)]");
    // The default composer still surfaces the detected tools as the "Uses" row.
    expect(container.textContent).toContain("Uses");
  });

  // Regression: the "Uses" chip must render the SAME inline "[logo] Name"
  // treatment as the landing/home (faint --bg-3 token + real BrandLogo), NOT a
  // divergent bordered --bg-2 pill. Federico (2026-06-23): "should show stripe +
  // logo inline, like on landing page. not different on this chatbox."
  it("Uses chip renders the unified inline token treatment (matches landing)", () => {
    const { container } = render(
      <PromptInput
        value="Create a Stripe alert worker"
        onChange={() => {}}
        onSubmit={() => {}}
        onFilesChange={() => {}}
        attachedFiles={[]}
        variant="default"
      />,
    );
    expect(screen.getByText(/^Uses$/)).toBeInTheDocument();

    // The Stripe brand logo is shown inline via the BrandLogo sprite.
    const brandUses = Array.from(container.querySelectorAll("use"))
      .map((u) => u.getAttribute("href") || "")
      .filter((h) => h.startsWith("#brand-"));
    expect(brandUses).toContain("#brand-stripe");

    // The chip is the shared inline token: faint --bg-3 highlight, NOT the old
    // bordered --bg-2 pill (the divergent treatment we removed).
    const token = container.querySelector("span.bg-\\[var\\(--bg-3\\)\\]");
    expect(token).not.toBeNull();
    expect(token!.textContent).toContain("Stripe");
    const borderedPill = container.querySelector(
      "span.\\[border\\:var\\(--bd-card\\)\\]",
    );
    expect(borderedPill).toBeNull();
  });
});
