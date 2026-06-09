import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CollectionView } from "@/components/collection/CollectionView";
import { Avatar } from "@/components/collection/Avatar";
import { emptyState } from "@/lib/collection/url-state";
import type { CollectionConfig, CollectionState } from "@/lib/collection/types";

interface Item {
  id: string;
  name: string;
  status: string;
  content: string[];
}

const ITEMS: Item[] = [
  { id: "1", name: "Weekly Update", status: "ok", content: ["operations"] },
  { id: "2", name: "DACH Compliance", status: "failing", content: ["dach"] },
  { id: "3", name: "Gmail Intake", status: "ok", content: ["recruiting"] },
];

function makeConfig(over: Partial<CollectionConfig<Item>> = {}): CollectionConfig<Item> {
  return {
    title: "Workers",
    items: ITEMS,
    idOf: (i) => i.id,
    searchOf: (i) => i.name,
    tagsOf: (i) => ({ status: [i.status], content: i.content }),
    tags: {
      status: [
        { value: "ok", label: "ok" },
        { value: "failing", label: "failing" },
      ],
      content: [
        { value: "operations", label: "operations" },
        { value: "dach", label: "dach" },
        { value: "recruiting", label: "recruiting" },
      ],
    },
    view: { default: "grid", grid: true },
    columns: { template: "1fr 120px 40px", headers: ["Worker", "Status", ""] },
    row: (i) => ({
      leading: <Avatar name={i.name} />,
      primary: i.name,
      secondary: "a worker",
      status: { tone: "ok", label: "Active" },
      menu: [{ label: "Delete", onSelect: () => {}, danger: true }],
    }),
    card: (i) => ({
      leading: <Avatar name={i.name} />,
      name: i.name,
      description: "a worker",
      status: { tone: "ok", label: "Active" },
    }),
    detail: (i) => ({
      header: { leading: <Avatar name={i.name} />, title: i.name },
      tabs: [
        { key: "About", label: "About", render: () => <div>About {i.name}</div> },
        { key: "Runs", label: "Runs", render: () => <div>Runs body</div> },
      ],
    }),
    add: { label: "Add", onSelect: () => {} },
    ...over,
  };
}

function Harness({
  config,
  initial,
}: {
  config: CollectionConfig<Item>;
  initial?: CollectionState;
}) {
  const [state, setState] = useState<CollectionState>(initial ?? emptyState("grid"));
  return <CollectionView config={config} state={state} onChange={setState} />;
}

describe("CollectionView — list & grid (§8e)", () => {
  it("renders grid by default and toggles to list (showing headers)", async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness config={makeConfig()} />);
    expect(container.querySelector(".c-grid")).toBeInTheDocument();
    expect(screen.queryByText("Worker")).not.toBeInTheDocument(); // no list header yet

    await user.click(screen.getByRole("button", { name: "List view" }));
    expect(container.querySelector(".c-grid")).not.toBeInTheDocument();
    expect(screen.getByText("Worker")).toBeInTheDocument(); // list header column
  });
});

describe("CollectionView — tag filtering (§8e)", () => {
  it("filters by a single status tag", async () => {
    const user = userEvent.setup();
    render(<Harness config={makeConfig()} />);
    expect(screen.getByText("DACH Compliance")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "ok" }));
    expect(screen.queryByText("DACH Compliance")).not.toBeInTheDocument(); // failing filtered out
    expect(screen.getByText("Weekly Update")).toBeInTheDocument();
    expect(screen.getByText("Gmail Intake")).toBeInTheDocument();
  });

  it("multi-selects content tags (OR) and clears with the all chip", async () => {
    const user = userEvent.setup();
    render(<Harness config={makeConfig()} />);

    await user.click(screen.getByRole("button", { name: "dach" }));
    await user.click(screen.getByRole("button", { name: "recruiting" }));
    expect(screen.getByText("DACH Compliance")).toBeInTheDocument();
    expect(screen.getByText("Gmail Intake")).toBeInTheDocument();
    expect(screen.queryByText("Weekly Update")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "all" }));
    expect(screen.getByText("Weekly Update")).toBeInTheDocument(); // back to everything
  });

  it("ANDs search with the active tag filter", async () => {
    const user = userEvent.setup();
    render(<Harness config={makeConfig()} />);
    await user.click(screen.getByRole("button", { name: "ok" }));
    await user.type(screen.getByRole("searchbox", { name: "Search" }), "gmail");
    expect(screen.getByText("Gmail Intake")).toBeInTheDocument();
    expect(screen.queryByText("Weekly Update")).not.toBeInTheDocument();
  });
});

describe("CollectionView — split detail (§8e)", () => {
  it("opens a row into the split, switches tabs, and closes", async () => {
    const user = userEvent.setup();
    render(<Harness config={makeConfig()} />);

    await user.click(screen.getByText("Weekly Update"));
    // detail header + first tab body
    expect(screen.getByRole("tab", { name: "About" })).toBeInTheDocument();
    expect(screen.getByText("About Weekly Update")).toBeInTheDocument();
    // resting toolbar is gone in split mode (search/tags move into the list col)
    expect(screen.queryByRole("button", { name: "Grid view" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Runs" }));
    expect(screen.getByText("Runs body")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close detail" }));
    expect(screen.queryByRole("tab", { name: "About" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Grid view" })).toBeInTheDocument();
  });

  it("collapses and expands the list column", async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness config={makeConfig()} />);
    await user.click(screen.getByText("Weekly Update"));
    expect(container.querySelector(".c-split")).toBeInTheDocument();
    expect(container.querySelector(".c-split.lc")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Collapse list" }));
    expect(container.querySelector(".c-split.lc")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Expand list" }));
    expect(container.querySelector(".c-split.lc")).not.toBeInTheDocument();
  });

  it("Escape closes the detail", async () => {
    const user = userEvent.setup();
    render(<Harness config={makeConfig()} />);
    await user.click(screen.getByText("Weekly Update"));
    expect(screen.getByRole("tab", { name: "About" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tab", { name: "About" })).not.toBeInTheDocument();
  });

  it("clears selection and toasts when ?sel points at a missing item", () => {
    const onInvalidSel = vi.fn();
    render(
      <CollectionView
        config={makeConfig()}
        state={{ ...emptyState("grid"), sel: "does-not-exist" }}
        onChange={() => {}}
        onInvalidSel={onInvalidSel}
      />,
    );
    expect(onInvalidSel).toHaveBeenCalledWith("does-not-exist");
  });
});

describe("CollectionView — states (§7)", () => {
  it("renders empty state with the page's add action", () => {
    render(<Harness config={makeConfig({ items: [] })} />);
    expect(screen.getByText("No workers yet")).toBeInTheDocument();
  });

  it("renders loading skeleton", () => {
    render(<Harness config={makeConfig({ loading: true })} />);
    expect(screen.getByLabelText("Loading")).toBeInTheDocument();
  });

  it("renders error state with retry", async () => {
    const retry = vi.fn();
    render(<Harness config={makeConfig({ error: "boom", states: { errorRetry: retry } })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("boom");
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalled();
  });
});
