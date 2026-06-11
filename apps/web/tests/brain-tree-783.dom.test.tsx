import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { InlineFileOpen } from "@/components/file-viewer/InlineFileOpen";

// #783: nested paths fold into navigable folders; descending shows base names.

beforeEach(() => vi.clearAllMocks());

describe("InlineFileOpen nested tree (#783)", () => {
  it("shows a folder for nested files and navigates into it", () => {
    render(
      <InlineFileOpen
        rootLabel="alpha"
        files={[
          { id: "top.txt", name: "top.txt", url: "#" },
          { id: "docs/a.txt", name: "docs/a.txt", url: "#" },
          { id: "docs/b.txt", name: "docs/b.txt", url: "#" },
        ]}
      />
    );

    // Root level: the top-level file + a "docs" folder (not the nested files).
    expect(screen.getByText("top.txt")).toBeInTheDocument();
    expect(screen.getByText("docs")).toBeInTheDocument();
    expect(screen.queryByText("a.txt")).toBeNull();

    // Descend into docs → shows base names, breadcrumb back to root.
    fireEvent.click(screen.getByText("docs"));
    expect(screen.getByText("a.txt")).toBeInTheDocument();
    expect(screen.getByText("b.txt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "alpha" })).toBeInTheDocument();
  });
});
