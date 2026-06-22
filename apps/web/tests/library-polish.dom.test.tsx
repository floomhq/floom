import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// UI lane: three Library (Brain) polish fixes.
//   FIX 1 — empty state matches the standard centered pattern (no dashed box).
//   FIX 2 — a single clean drag-over overlay (no stacked drop targets).
//   FIX 3 — folder-create never opens a blocking name prompt (auto-names).

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));

const createSpy = vi.fn().mockResolvedValue({ name: "new-folder", files: [] });
const uploadSpy = vi.fn().mockResolvedValue(undefined);
const listSpy = vi.fn().mockResolvedValue([]);

vi.mock("@/lib/api", () => ({
  api: {
    contexts: {
      list: (...args: unknown[]) => listSpy(...args),
      get: vi.fn().mockResolvedValue({ files: [], used_by: [] }),
      create: (...args: unknown[]) => createSpy(...args),
      upload: (...args: unknown[]) => uploadSpy(...args),
      delete: vi.fn(),
    },
  },
}));

function TestQueryProvider({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

async function renderEmptyLibrary() {
  const { default: BrainCollection } = await import("@/app/brain/BrainCollection");
  const view = render(
    <TestQueryProvider>
      <BrainCollection initialFolders={[]} />
    </TestQueryProvider>,
  );
  // Wait for the empty state (the list query resolves to []).
  await screen.findByText("Your Library is empty");
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  listSpy.mockResolvedValue([]);
  createSpy.mockResolvedValue({ name: "new-folder", files: [] });
  uploadSpy.mockResolvedValue(undefined);
});

describe("Library polish — empty state (FIX 1)", () => {
  it("renders the standard centered empty state WITHOUT the dashed drop-zone box", async () => {
    const { container } = await renderEmptyLibrary();

    // Standard state box is present...
    const box = container.querySelector(".c-statebox");
    expect(box).toBeTruthy();
    // ...but NOT the heavy dashed drop-zone variant.
    expect(container.querySelector(".c-dropbox")).toBeNull();
    expect(box?.classList.contains("c-dropbox")).toBe(false);
  });

  it("offers exactly one empty-state action (Browse files), no stacked New folder", async () => {
    await renderEmptyLibrary();

    // The standard pattern shows ONE action under the subtext.
    expect(screen.getByRole("button", { name: /browse files/i })).toBeTruthy();
    // "New folder" lives in the toolbar, not stacked inside the empty state.
    const statebox = document.querySelector(".c-statebox") as HTMLElement;
    expect(statebox.querySelector("button")?.textContent).toMatch(/browse files/i);
    expect(statebox.textContent).not.toMatch(/new folder/i);
    // No leftover "Drop files here to get started" headline box copy.
    expect(screen.queryByText(/drop files here to get started/i)).toBeNull();
  });
});

describe("Library polish — single clean drag overlay (FIX 2)", () => {
  it("shows ONE overlay with a single 'Drop to add to your Library' message on drag-over", async () => {
    await renderEmptyLibrary();
    const zone = screen.getByTestId("library-dropzone");

    fireEvent.dragOver(zone, { dataTransfer: { types: ["Files"] } });

    const overlay = screen.getByTestId("library-drag-overlay");
    expect(overlay).toBeTruthy();
    expect(screen.getByText("Drop to add to your Library")).toBeTruthy();
    // No competing drag affordances: the old "Drop to create a new folder"
    // caption and a second drop target must NOT appear at the same time.
    expect(screen.queryByText(/drop to create a new folder/i)).toBeNull();
    expect(document.querySelectorAll('[data-testid="library-drag-overlay"]').length).toBe(1);
  });

  it("clears the overlay when the drag leaves the page", async () => {
    await renderEmptyLibrary();
    const zone = screen.getByTestId("library-dropzone");

    fireEvent.dragOver(zone, { dataTransfer: { types: ["Files"] } });
    expect(screen.queryByTestId("library-drag-overlay")).toBeTruthy();

    fireEvent.dragLeave(zone, { relatedTarget: document.body });
    expect(screen.queryByTestId("library-drag-overlay")).toBeNull();
  });
});

describe("Library polish — no folder-name prompt (FIX 3)", () => {
  // The toolbar (with "New folder") renders once the Library has at least one
  // folder; render with a populated list so the toolbar action is reachable.
  async function renderPopulatedLibrary(initial = [{ name: "existing", file_count: 0, updated_at: "", visibility: "private" }]) {
    listSpy.mockResolvedValue(initial);
    const { default: BrainCollection } = await import("@/app/brain/BrainCollection");
    const view = render(
      <TestQueryProvider>
        <BrainCollection initialFolders={initial as never} />
      </TestQueryProvider>,
    );
    await screen.findByText(initial[0].name);
    return view;
  }

  it("toolbar 'New folder' auto-creates immediately with NO name dialog", async () => {
    await renderPopulatedLibrary();

    fireEvent.click(screen.getByRole("button", { name: /^new folder$/i }));

    // Folder is created right away with an auto-derived slug.
    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    const [slug, writeable] = createSpy.mock.calls[0];
    expect(slug).toMatch(/^new-folder/);
    expect(writeable).toBe(true);

    // No blocking name dialog: no "Folder name" input, no Create button.
    expect(screen.queryByText(/folder name/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /^create folder$/i })).toBeNull();
  });

  it("dropping files auto-creates an auto-named folder and uploads, no prompt", async () => {
    await renderEmptyLibrary();
    const zone = screen.getByTestId("library-dropzone");

    const file = new File(["hello"], "Q3 Notes.pdf", { type: "application/pdf" });
    fireEvent.drop(zone, { dataTransfer: { files: [file], types: ["Files"] } });

    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    // Slug seeded from the dropped file name (no name dialog presented).
    expect(createSpy.mock.calls[0][0]).toBe("q3-notes");
    await waitFor(() => expect(uploadSpy).toHaveBeenCalledTimes(1));
    expect(uploadSpy.mock.calls[0][0]).toBe("q3-notes");

    // No name-prompt modal at any point.
    expect(screen.queryByText(/folder name/i)).toBeNull();
  });

  it("avoids name collisions by auto-incrementing the slug", async () => {
    await renderPopulatedLibrary([{ name: "new-folder", file_count: 0, updated_at: "", visibility: "private" }]);

    fireEvent.click(screen.getByRole("button", { name: /^new folder$/i }));
    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    expect(createSpy.mock.calls[0][0]).toBe("new-folder-2");
  });
});
