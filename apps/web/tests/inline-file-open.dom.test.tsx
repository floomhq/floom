import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InlineFileOpen } from "@/components/file-viewer/InlineFileOpen";

// Rule #5: one inline file-open pattern (breadcrumb + Back + Download; images
// render as <img>; text loads inline; binary gets an honest fallback).

const files = [
  { id: "chart.png", name: "chart.png", url: "/files/chart.png", sizeBytes: 2048 },
  { id: "notes.md", name: "notes.md", url: "/files/notes.md", sizeBytes: 100 },
  { id: "data.db", name: "data.db", url: "/files/data.db", binary: true },
];

describe("InlineFileOpen", () => {
  it("lists files with sizes; empty label when none", () => {
    const { unmount } = render(<InlineFileOpen files={files} rootLabel="Output" />);
    expect(screen.getByText("chart.png")).toBeTruthy();
    expect(screen.getByText("2 KB")).toBeTruthy();
    unmount();
    render(<InlineFileOpen files={[]} rootLabel="Output" emptyLabel="No files yet." />);
    expect(screen.getByText("No files yet.")).toBeTruthy();
  });

  it("opens an image inline as <img> with breadcrumb, Back and Download", () => {
    render(<InlineFileOpen files={files} rootLabel="Output" />);
    fireEvent.click(screen.getByText("chart.png"));
    const img = document.querySelector("img");
    expect(img?.getAttribute("src")).toBe("/files/chart.png");
    expect(screen.getByText(/Output \//)).toBeTruthy(); // breadcrumb
    expect(screen.getByText("Download").closest("a")?.getAttribute("href")).toBe("/files/chart.png");
    fireEvent.click(screen.getByText("Back"));
    expect(document.querySelector("img")).toBeNull(); // back to the list
  });

  it("loads text content inline via loadText", async () => {
    const loadText = vi.fn().mockResolvedValue("# hello brain");
    render(<InlineFileOpen files={files} rootLabel="company-facts" loadText={loadText} />);
    fireEvent.click(screen.getByText("notes.md"));
    await waitFor(() => expect(screen.getByText("# hello brain")).toBeTruthy());
    expect(loadText).toHaveBeenCalledWith(expect.objectContaining({ id: "notes.md" }));
  });

  it("never text-loads binary files; .db gets the #777 fallback", () => {
    const loadText = vi.fn();
    render(<InlineFileOpen files={files} rootLabel="company-facts" loadText={loadText} />);
    fireEvent.click(screen.getByText("data.db"));
    expect(loadText).not.toHaveBeenCalled();
    expect(screen.getByText(/SQLite database/)).toBeTruthy();
  });

  it("shows an upload affordance only when onUpload is provided", () => {
    const { unmount } = render(<InlineFileOpen files={files} rootLabel="Output" />);
    expect(screen.queryByText(/Drag files here to upload/i)).toBeNull();
    unmount();
    render(<InlineFileOpen files={files} rootLabel="brain" onUpload={vi.fn()} />);
    expect(screen.getByText(/Drag files here to upload/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /browse/i })).toBeTruthy();
  });

  it("offers the dropzone even for an empty folder (so files can be added)", () => {
    render(<InlineFileOpen files={[]} rootLabel="brain" emptyLabel="This folder is empty." onUpload={vi.fn()} />);
    expect(screen.getByText(/Drag files here to upload/i)).toBeTruthy();
    expect(screen.getByText("This folder is empty.")).toBeTruthy();
  });

  it("drag-and-drop calls onUpload with the dropped files and current dir prefix", async () => {
    const onUpload = vi.fn().mockResolvedValue(undefined);
    render(<InlineFileOpen files={files} rootLabel="brain" onUpload={onUpload} />);
    const dropped = new File(["hi"], "memo.txt", { type: "text/plain" });
    const target = screen.getByText(/Drag files here to upload/i).parentElement as HTMLElement;
    fireEvent.dragOver(target, { dataTransfer: { files: [dropped], types: ["Files"] } });
    fireEvent.drop(target, { dataTransfer: { files: [dropped], types: ["Files"] } });
    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(1));
    const [files0, dirPrefix] = onUpload.mock.calls[0];
    expect(files0[0].name).toBe("memo.txt");
    expect(dirPrefix).toBe(""); // root level
  });

  it("Browse picker routes selected files to onUpload", async () => {
    const onUpload = vi.fn().mockResolvedValue(undefined);
    const { container } = render(<InlineFileOpen files={files} rootLabel="brain" onUpload={onUpload} />);
    const picker = container.querySelector('input[type="file"]') as HTMLInputElement;
    const picked = new File(["x"], "pick.csv", { type: "text/csv" });
    fireEvent.change(picker, { target: { files: [picked] } });
    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(1));
    expect(onUpload.mock.calls[0][0][0].name).toBe("pick.csv");
  });

  it("shows Edit between Back and Download and saves edited text", async () => {
    const loadText = vi.fn().mockResolvedValue("# old");
    const onSaveText = vi.fn().mockResolvedValue(undefined);
    render(<InlineFileOpen files={files} rootLabel="company-facts" loadText={loadText} onSaveText={onSaveText} />);
    fireEvent.click(screen.getByText("notes.md"));
    await waitFor(() => expect(screen.getByText("# old")).toBeTruthy());

    const back = screen.getByRole("button", { name: /Back/i });
    const edit = screen.getByRole("button", { name: /Edit/i });
    const download = screen.getByRole("link", { name: /Download/i });
    expect(Boolean(back.compareDocumentPosition(edit) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(edit.compareDocumentPosition(download) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);

    fireEvent.click(edit);
    const editor = screen.getByDisplayValue("# old");
    fireEvent.change(editor, { target: { value: "# new" } });
    fireEvent.click(screen.getByRole("button", { name: /Save/i }));

    await waitFor(() => expect(onSaveText).toHaveBeenCalledWith(expect.objectContaining({ id: "notes.md" }), "# new"));
    expect(screen.getByText("# new")).toBeTruthy();
  });
});
