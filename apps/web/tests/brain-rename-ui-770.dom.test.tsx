import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InlineFileOpen } from "@/components/file-viewer/InlineFileOpen";

// #770: the inline rename control calls onRename with the new base name (no
// native prompt).

beforeEach(() => vi.clearAllMocks());

describe("InlineFileOpen rename (#770)", () => {
  it("renames a file inline via onRename", async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    render(
      <InlineFileOpen
        rootLabel="alpha"
        files={[{ id: "sub/notes.txt", name: "sub/notes.txt", url: "#" }]}
        onRename={onRename}
      />
    );

    // #783: the file lives under "sub/" — descend into the folder first.
    fireEvent.click(screen.getByText("sub"));
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByDisplayValue("notes.txt"); // base name, not the full path
    fireEvent.change(input, { target: { value: "renamed.txt" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(onRename).toHaveBeenCalledWith(
        expect.objectContaining({ id: "sub/notes.txt" }),
        "renamed.txt"
      )
    );
  });

  it("shows no rename control when onRename is absent", () => {
    render(
      <InlineFileOpen rootLabel="alpha" files={[{ id: "a.txt", name: "a.txt", url: "#" }]} />
    );
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });
});
