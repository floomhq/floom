import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InlineFileOpen } from "@/components/file-viewer/InlineFileOpen";

function dragStore() {
  const data = new Map<string, string>();
  const types: string[] = [];
  return {
    types,
    files: [],
    effectAllowed: "",
    dropEffect: "",
    setData: vi.fn((type: string, value: string) => {
      data.set(type, value);
      if (!types.includes(type)) types.push(type);
    }),
    getData: vi.fn((type: string) => data.get(type) ?? ""),
  };
}

describe("InlineFileOpen Brain row DnD", () => {
  it("shows the v4 drag caption and hover-grip affordance when row DnD is enabled", () => {
    const { container } = render(
      <InlineFileOpen
        rootLabel="company-facts"
        files={[{ id: "a.md", name: "a.md", url: "#" }]}
        onMoveItem={vi.fn()}
      />,
    );

    expect(screen.getByText("Drag rows to reorder, or drop into another folder")).toBeTruthy();
    expect(container.querySelectorAll(".c-row-grip").length).toBeGreaterThan(0);
    expect(screen.getByText("a.md").closest(".c-lrow")?.getAttribute("draggable")).toBe("true");
  });

  it("reorders file rows locally when a file row is dropped on another file row", () => {
    const { container } = render(
      <InlineFileOpen
        rootLabel="company-facts"
        files={[
          { id: "a.md", name: "a.md", url: "#" },
          { id: "b.md", name: "b.md", url: "#" },
        ]}
        onMoveItem={vi.fn()}
      />,
    );

    const transfer = dragStore();
    fireEvent.dragStart(screen.getByText("a.md").closest(".c-lrow") as HTMLElement, { dataTransfer: transfer });
    fireEvent.drop(screen.getByText("b.md").closest(".c-lrow") as HTMLElement, { dataTransfer: transfer });

    const names = Array.from(container.querySelectorAll(".c-lrow .nm")).map((node) => node.textContent);
    expect(names).toEqual(["b.md", "a.md"]);
  });

  it("drops a file row into another folder via onMoveItem", async () => {
    const onMoveItem = vi.fn().mockResolvedValue(undefined);
    render(
      <InlineFileOpen
        rootLabel="company-facts"
        files={[
          { id: "company-overview.md", name: "company-overview.md", url: "#" },
          { id: "reports/q1.md", name: "reports/q1.md", url: "#" },
        ]}
        onMoveItem={onMoveItem}
      />,
    );

    const transfer = dragStore();
    fireEvent.dragStart(screen.getByText("company-overview.md").closest(".c-lrow") as HTMLElement, {
      dataTransfer: transfer,
    });
    fireEvent.dragOver(screen.getByText("reports/").closest(".c-lrow") as HTMLElement, { dataTransfer: transfer });
    fireEvent.drop(screen.getByText("reports/").closest(".c-lrow") as HTMLElement, { dataTransfer: transfer });

    await waitFor(() =>
      expect(onMoveItem).toHaveBeenCalledWith(
        { kind: "file", path: "company-overview.md", name: "company-overview.md", dir: "" },
        "reports/",
      ),
    );
  });

  it("creates a subfolder at the current directory prefix", async () => {
    const onCreateSubfolder = vi.fn().mockResolvedValue(undefined);
    render(
      <InlineFileOpen
        rootLabel="company-facts"
        files={[{ id: "a.md", name: "a.md", url: "#" }]}
        onCreateSubfolder={onCreateSubfolder}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /New subfolder/i }));
    fireEvent.change(screen.getByPlaceholderText("reports"), { target: { value: "Quarterly Reports" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onCreateSubfolder).toHaveBeenCalledWith("", "Quarterly-Reports"));
  });
});
