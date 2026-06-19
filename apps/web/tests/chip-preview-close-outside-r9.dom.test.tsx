import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Dialog, DialogContent } from "@/components/ui/dialog";

// GAP-POPCLOSE (Maintainer 2026-06-16): the integration/brain chip preview popover
// must close when the user clicks OUTSIDE the box (the backdrop), not only via
// the X. This mounts the real ChipPreviewDialog and proves both close paths.

vi.mock("@/lib/api", () => ({
  api: {
    integrations: { catalogTools: vi.fn().mockResolvedValue([]) },
    contexts: {
      get: vi.fn().mockResolvedValue({ files: [] }),
      fileUrl: () => "",
      readTextFile: vi.fn(),
      sqlite: vi.fn(),
      fetchFileBlob: vi.fn(),
    },
  },
}));

// BrandLogo hits the network/icon registry; stub to a plain element.
vi.mock("@/components/connections/BrandLogo", () => ({
  BrandLogo: () => <span data-testid="brand-logo" />,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

async function mountOpen() {
  const { ChipPreviewDialog } = await import("@/components/worker/ChipPreviewDialog");
  const onOpenChange = vi.fn();
  render(
    <ChipPreviewDialog target={{ kind: "integration", app: "gmail" }} onOpenChange={onOpenChange} />,
  );
  // Title proves the popover is open.
  await screen.findByText("Actions this tool can run");
  return { onOpenChange };
}

describe("GAP-POPCLOSE: chip preview popover dismissal", () => {
  it("closes when clicking the backdrop (outside the box)", async () => {
    const { onOpenChange } = await mountOpen();

    const backdrop = document.querySelector('[data-slot="dialog-overlay"]') as HTMLElement;
    expect(backdrop).toBeTruthy();

    // A real outside click is pointerdown -> mouseup -> click on the backdrop.
    fireEvent.pointerDown(backdrop);
    fireEvent.mouseUp(backdrop);
    fireEvent.click(backdrop);

    await waitFor(() =>
      expect(onOpenChange.mock.calls.some(([open]) => open === false)).toBe(true),
    );
  });

  it("still closes via the X close button", async () => {
    const { onOpenChange } = await mountOpen();

    const closeBtn = screen.getByRole("button", { name: /close/i });
    fireEvent.click(closeBtn);

    await waitFor(() =>
      expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything()),
    );
  });

  it("closes on Escape key", async () => {
    const { onOpenChange } = await mountOpen();

    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });

    await waitFor(() =>
      expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything()),
    );
  });

  // The realistic reproduction: the chip preview opens from inside the worker
  // detail Dialog (WorkerBrainEditor / WorkerToolsEditor render inside it), so
  // it is a NESTED Base UI dialog. This is where the backdrop-equality branch
  // bit Maintainer in the real browser.
  it("closes on outside click while nested inside another open Dialog", async () => {
    const { ChipPreviewDialog } = await import("@/components/worker/ChipPreviewDialog");
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent>
          <ChipPreviewDialog
            target={{ kind: "integration", app: "gmail" }}
            onOpenChange={onOpenChange}
          />
        </DialogContent>
      </Dialog>,
    );
    await screen.findByText("Actions this tool can run");

    // The chip preview's own backdrop is the last dialog-overlay in the DOM
    // (rendered after the parent's overlay).
    const overlays = document.querySelectorAll('[data-slot="dialog-overlay"]');
    const backdrop = overlays[overlays.length - 1] as HTMLElement;
    expect(backdrop).toBeTruthy();

    fireEvent.pointerDown(backdrop);
    fireEvent.mouseUp(backdrop);
    fireEvent.click(backdrop);

    await waitFor(() =>
      expect(onOpenChange.mock.calls.some(([open]) => open === false)).toBe(true),
    );
  });
});
