import { useState } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { CollectionView } from "@/components/collection/CollectionView";
import type { CollectionConfig, CollectionState } from "@/lib/collection/types";

type Row = {
  id: string;
  name: string;
  count: number;
  status: string;
};

const rows: Row[] = [
  { id: "b", name: "Beta", count: 2, status: "Ready" },
  { id: "a", name: "Alpha", count: 9, status: "Running" },
  { id: "c", name: "Gamma", count: 4, status: "Idle" },
];

const config: CollectionConfig<Row> = {
  title: "Rows",
  items: rows,
  idOf: (row) => row.id,
  searchOf: (row) => row.name,
  columns: {
    template: "1fr 80px 100px",
    headers: ["Name", "Count", "Status"],
    statusColumn: false,
    menuColumn: false,
  },
  sort: {
    columns: {
      0: { value: (row) => row.name },
      1: { value: (row) => row.count },
      2: { value: (row) => row.status },
    },
  },
  row: (row) => ({
    primary: row.name,
    cols: [row.count, row.status],
  }),
  detail: (row) => ({
    header: { leading: undefined, title: row.name },
    tabs: [
      {
        key: "About",
        label: "About",
        summary: [{ key: "name", label: "Name", value: row.name }],
      },
    ],
  }),
};

function rowOrder(): string[] {
  return Array.from(document.querySelectorAll(".c-lrow .nm")).map((node) => node.textContent ?? "");
}

function Harness() {
  const [state, setState] = useState<CollectionState>({
    sel: null,
    tab: null,
    view: "list",
    q: "",
    tags: {},
  });
  return <CollectionView config={config} state={state} onChange={setState} />;
}

describe("Collection table sorting", () => {
  it("sorts a shared collection table ascending and descending with indicators", () => {
    render(<Harness />);

    expect(rowOrder()).toEqual(["Beta", "Alpha", "Gamma"]);

    fireEvent.click(screen.getByRole("button", { name: "Sort by Name" }));
    expect(rowOrder()).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(screen.getByRole("columnheader", { name: "Name" })).toHaveAttribute("aria-sort", "ascending");

    fireEvent.click(screen.getByRole("button", { name: "Sort Name descending" }));
    expect(rowOrder()).toEqual(["Gamma", "Beta", "Alpha"]);
    expect(screen.getByRole("columnheader", { name: "Name" })).toHaveAttribute("aria-sort", "descending");

    fireEvent.click(screen.getByRole("button", { name: "Sort by Count" }));
    expect(rowOrder()).toEqual(["Beta", "Gamma", "Alpha"]);
    expect(screen.getByRole("columnheader", { name: "Count" })).toHaveAttribute("aria-sort", "ascending");
  });
});
