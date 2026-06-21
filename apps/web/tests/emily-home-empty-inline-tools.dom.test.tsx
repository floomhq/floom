// Emily home polish (Federico 2026-06-21) — first-worker zero-state pills.
//
// Three guarantees for the "Let's hire your first worker" home empty state:
//   1. Example prompts highlight their tool names INLINE, each with the tool's
//      real brand icon (BrandLogo sprite) — the same register as the marketing
//      landing prompt box, NOT a separate "Uses [pill] [pill]" row.
//   2. The empty state carries NO "Uses" / "Will use" chip-row label.
//   3. The decorative radar mark above the heading is gone (cleaner hero).
// The pill stays a real button whose accessible name is the full prompt text so
// clicking it still seeds the composer (asserted in new-worker-emily-chat-only).
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

describe("Emily home empty — first-worker zero-state polish", () => {
  it("renders the first-worker hero heading", async () => {
    renderFirstWorker();
    expect(await screen.findByText(/hire your first worker/i)).toBeInTheDocument();
  });

  it("example pills highlight tool names inline with brand icons", async () => {
    const { container } = renderFirstWorker();
    await screen.findByText(/hire your first worker/i);

    // The "Granola → HubSpot" pill is a button whose accessible name is the
    // full prompt text (so seeding still works).
    const pill = screen.getByRole("button", { name: /Summarise my Granola meetings/i });
    expect(pill).toBeInTheDocument();

    // Inline brand icons: BrandLogo renders an <svg><use href="#brand-..."/>.
    // Granola + HubSpot are both highlighted inline within that pill.
    const brandUses = Array.from(container.querySelectorAll("use"))
      .map((u) => u.getAttribute("href") || "")
      .filter((h) => h.startsWith("#brand-"));
    expect(brandUses).toContain("#brand-granola");
    expect(brandUses).toContain("#brand-hubspot");
  });

  it("has NO separate 'Uses' / 'Will use' chip-row label", async () => {
    renderFirstWorker();
    await screen.findByText(/hire your first worker/i);
    expect(screen.queryByText(/^Uses$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Will use$/)).not.toBeInTheDocument();
  });

  it("removes the decorative radar mark above the heading", async () => {
    const { container } = renderFirstWorker();
    const heading = await screen.findByText(/hire your first worker/i);
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

describe("Emily home composer — bigger, borderless, no Uses row", () => {
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
    const wrapper = textarea.parentElement as HTMLElement;
    // Borderless (landing): the composer box carries [border:none], never the
    // [border:var(--bd-div)] outline of the default in-conversation composer.
    expect(wrapper.className).toContain("[border:none]");
    expect(wrapper.className).not.toContain("[border:var(--bd-div)]");
    // Larger hero sizing: roomier padding + bigger min-height than the compact
    // conversation composer.
    expect(textarea.className).toContain("min-h-[60px]");
    expect(textarea.className).toContain("text-[15px]");
    // No "Uses" / "Will use" PromptChips row in the landing composer even though
    // the prompt clearly references Granola + HubSpot.
    expect(container.textContent).not.toContain("Uses");
    expect(container.textContent).not.toContain("Will use");
  });

  it("default conversation composer keeps its outline + the Uses chip row", () => {
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
    const wrapper = textarea.parentElement as HTMLElement;
    expect(wrapper.className).toContain("[border:var(--bd-div)]");
    // The default composer still surfaces the detected tools as the "Uses" row.
    expect(container.textContent).toContain("Uses");
  });
});
