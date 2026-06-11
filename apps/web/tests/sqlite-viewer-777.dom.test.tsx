import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SqliteTableView } from "@/components/file-viewer/SqliteTableView";
import type { SqliteView } from "@/lib/types";

// #777: the inline SQLite viewer lists tables and renders rows of the active one.

beforeEach(() => vi.clearAllMocks());

describe("SqliteTableView (#777)", () => {
  it("loads tables then renders the first table's rows", async () => {
    const load = vi.fn(async (table?: string): Promise<SqliteView> => {
      if (!table) return { tables: ["users", "orders"] };
      return {
        tables: ["users", "orders"],
        table,
        columns: ["id", "name"],
        rows: [
          [1, "alice"],
          [2, "bob"],
        ],
        row_count: 2,
        truncated: false,
      };
    });

    render(<SqliteTableView load={load} />);

    // Table pills.
    expect(await screen.findByText("users")).toBeInTheDocument();
    expect(screen.getByText("orders")).toBeInTheDocument();

    // Rows of the active (first) table.
    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());
    expect(screen.getByText("bob")).toBeInTheDocument();
    expect(screen.getByText("id")).toBeInTheDocument();
  });
});
