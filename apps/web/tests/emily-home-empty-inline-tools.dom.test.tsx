// Emily home — first-worker zero-state (funnel reframe 2026-07).
//
// The post-signup first screen presents the TWO real activation paths and frames
// the assistant as a HELPER, not an in-dashboard worker builder:
//   1. PRIMARY: "Browse templates" links to the template gallery (the gallery's
//      "Add to workspace" lands a running worker in one click).
//   2. SECONDARY: "Set up in your coding agent" opens the Floom MCP install
//      (Claude Code / Codex / Cursor) — the coding-agent native path.
//   3. Helper pills seed the real composer with questions the assistant can
//      answer (choose a template, connect a tool); it does NOT build the worker.
//   4. No "Uses" / "Will use" chip-row label; no decorative radar mark.
import { describe, expect, it, vi, beforeEach } from "vitest";
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

describe("Emily home empty — first-worker zero-state (funnel reframe)", () => {
  it("renders the first-worker hero heading", async () => {
    renderFirstWorker();
    expect(await screen.findByText(/get your first worker running/i)).toBeInTheDocument();
  });

  it("presents the two real activation paths, template gallery first", async () => {
    renderFirstWorker();
    await screen.findByText(/get your first worker running/i);

    // PRIMARY: template gallery (a real link to the /templates gallery).
    const browse = screen.getByRole("link", { name: /Browse templates/i });
    expect(browse).toBeInTheDocument();
    expect(browse.getAttribute("href")).toMatch(/\/templates$/);

    // SECONDARY: coding-agent / MCP native path (opens the install modal).
    expect(screen.getByRole("button", { name: /Set up in your coding agent/i })).toBeInTheDocument();

    // Helper pills (assistant guides; does NOT build the worker in-dashboard).
    expect(screen.getByRole("button", { name: /Which template fits my team/i })).toBeInTheDocument();
    // The old false "Emily builds it" create pills are gone.
    expect(screen.queryByRole("button", { name: /Create a Linear triage worker/i })).not.toBeInTheDocument();
  });

  it("has NO separate 'Uses' / 'Will use' chip-row label", async () => {
    renderFirstWorker();
    await screen.findByText(/get your first worker running/i);
    expect(screen.queryByText(/^Uses$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Will use$/)).not.toBeInTheDocument();
  });

  it("removes the decorative radar mark above the heading", async () => {
    const { container } = renderFirstWorker();
    const heading = await screen.findByText(/get your first worker running/i);
    // The radar mark was a full 48x48 viewBox SVG sibling above the heading.
    // After the change, any remaining inline SVG (e.g. pill capability glyphs)
    // must NOT be the 48-viewBox radar mark.
    const radar = container.querySelector('svg[viewBox="0 0 48 48"]');
    expect(radar).toBeNull();
    // Sanity: the heading hero block has no SVG rendered directly before it.
    const heroBlock = heading.parentElement as HTMLElement;
    expect(heroBlock.querySelector("svg")).toBeNull();
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
