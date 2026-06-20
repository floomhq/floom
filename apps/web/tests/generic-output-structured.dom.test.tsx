import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { GenericOutput } from "@/components/generic-output";

// FIX 2 (round-09 detail roast): the run Output "Preview" must render
// STRUCTURED output, not a raw JSON dump. An array of objects (e.g. a candidate
// shortlist) renders as a table with columns derived from the keys; an object
// of scalars renders as a key/value list; genuinely irregular shapes fall back
// to a JSON code block.

describe("GenericOutput — structured JSON rendering", () => {
  it("renders an array of objects as a table, not a <pre> JSON dump", () => {
    const shortlist = [
      { name: "Ada Lovelace", score: 92, location: "London" },
      { name: "Alan Turing", score: 88, location: "Manchester" },
    ];
    const { container } = render(<GenericOutput type="json" value={shortlist} />);

    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    // No raw JSON code dump for this shape.
    expect(container.querySelector("pre")).toBeNull();

    // Columns come from the object keys (humanized).
    const headers = within(table as HTMLElement)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual(["Name", "Score", "Location"]);

    // Cell values are present.
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("Manchester")).toBeInTheDocument();
  });

  it("parses a JSON STRING of array-of-objects into a table too", () => {
    const json = JSON.stringify([{ id: "a", n: 1 }, { id: "b", n: 2 }]);
    const { container } = render(<GenericOutput type="json" value={json} />);
    expect(container.querySelector("table")).not.toBeNull();
  });

  it("renders an object of scalars as a key/value list, not raw JSON", () => {
    const { container } = render(
      <GenericOutput type="json" value={{ status: "ok", count: 3 }} />,
    );
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("Count")).toBeInTheDocument();
  });

  it("falls back to a JSON code block for irregular shapes", () => {
    // Mixed array (object + scalar) is not a clean table — keep it as JSON.
    const { container } = render(
      <GenericOutput type="json" value={[{ a: 1 }, "loose string"]} />,
    );
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector("pre")).not.toBeNull();
  });

  it("still renders markdown and text types unchanged", () => {
    const md = render(<GenericOutput type="markdown" value={"# Title"} />);
    expect(md.getByText("Title")).toBeInTheDocument();
    md.unmount();
    const txt = render(<GenericOutput type="text" value={"plain body"} />);
    expect(txt.getByText("plain body")).toBeInTheDocument();
  });
});
