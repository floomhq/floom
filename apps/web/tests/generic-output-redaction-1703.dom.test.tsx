import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { GenericOutput } from "@/components/generic-output";

// #1703: internal <REDACTED:SECRET_NAME> secret-scrubber markers must never
// render in user-facing output, across EVERY render type (table, csv, markdown,
// plain text, file). Locks the display-time sanitizer on each branch.

const TOKEN = "<REDACTED:EXTERNAL_APIFY_PROFILE_SCRAPER_MODE>";

describe("GenericOutput strips internal redaction markers (#1703)", () => {
  it("table cells (array-of-objects) drop the marker", () => {
    const shortlist = [
      { name: "Benjamin Glanz", title: `${TOKEN} Stack Entwickler` },
      { name: "Pedro Rodriguez", title: `${TOKEN} Stack Engineer` },
    ];
    const { container } = render(<GenericOutput type="json" value={shortlist} />);
    expect(container.textContent).not.toContain("<REDACTED:");
    expect(screen.getByText("Stack Entwickler")).toBeInTheDocument();
    expect(screen.getByText("Stack Engineer")).toBeInTheDocument();
  });

  it("CSV table cells drop the marker", () => {
    const csv = `name,title\nBenjamin,${TOKEN} Stack Entwickler\nPedro,${TOKEN} Stack Engineer`;
    const { container } = render(<GenericOutput type="csv" value={csv} />);
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.textContent).not.toContain("<REDACTED:");
    expect(screen.getByText("Stack Entwickler")).toBeInTheDocument();
  });

  it("markdown output drops the marker", () => {
    const md = `# Shortlist\n\n- ${TOKEN} Stack developer based in Berlin`;
    const { container } = render(<GenericOutput type="markdown" value={md} />);
    expect(container.textContent).not.toContain("<REDACTED:");
    expect(container.textContent).toContain("Stack developer based in Berlin");
  });

  it("plain text output drops the marker", () => {
    const { container } = render(<GenericOutput type="text" value={`${TOKEN} Stack Engineer`} />);
    expect(container.textContent).not.toContain("<REDACTED:");
    expect(container.textContent).toContain("Stack Engineer");
  });

  it("file-type output drops the marker", () => {
    const { container } = render(<GenericOutput type="file" value={`${TOKEN}-report.csv`} />);
    expect(container.textContent).not.toContain("<REDACTED:");
  });

  it("raw json code block (irregular shape) drops the marker", () => {
    // A non-tabular shape falls back to a JSON code block; it must be deep-sanitized.
    const value = { meta: { note: `${TOKEN} internal` }, items: [1, 2, 3] };
    const { container } = render(<GenericOutput type="json" value={value} />);
    expect(container.textContent).not.toContain("<REDACTED:");
  });

  // #1752: JSON KEYS (object-table headers, key/value list keys) were rendered
  // raw via humanizeColumn while only values were sanitized. Reachable on the
  // public share card. The keys must be sanitized too, including lower/mixed
  // case secret names that the old uppercase-only regex missed.
  it("array-of-objects table HEADERS drop the marker (#1752)", () => {
    const rows = [
      { "<REDACTED:apifyToken>": "v1", name: "ok" },
      { "<REDACTED:apifyToken>": "v2", name: "fine" },
    ];
    const { container } = render(<GenericOutput type="json" value={rows} />);
    const headers = Array.from(container.querySelectorAll("th")).map((th) => th.textContent ?? "");
    expect(headers.join("|")).not.toMatch(/<REDACTED/i);
    expect(container.textContent).not.toMatch(/<REDACTED/i);
  });

  it("key/value list KEYS drop the marker, incl. mixed/lower case (#1752)", () => {
    const obj = {
      "<REDACTED:my_key>": "alpha",
      "<REDACTED:Mixed_Case>": "beta",
      clean_field: "gamma",
    };
    const { container } = render(<GenericOutput type="json" value={obj} />);
    const keys = Array.from(container.querySelectorAll("dt")).map((dt) => dt.textContent ?? "");
    expect(keys.join("|")).not.toMatch(/<REDACTED/i);
    expect(container.textContent).not.toMatch(/<REDACTED/i);
    // values still present
    expect(container.textContent).toContain("alpha");
    expect(container.textContent).toContain("gamma");
  });
});
