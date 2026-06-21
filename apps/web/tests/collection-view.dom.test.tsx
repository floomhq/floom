import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
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

describe("CollectionView — grouped (day-section) list variant (#1225)", () => {
  it("renders the SHARED column header above day groups, same as the flat list", () => {
    // Day-grouping is a variant WITHIN the shared Collection grammar: it must
    // still carry the column-header row (Worker/Status) the other Collection
    // pages show, with the group labels layered as an in-list option.
    const { container } = render(
      <Harness
        config={makeConfig({ group: (i) => (i.status === "failing" ? "Today" : "Yesterday") })}
        initial={emptyState("list")}
      />,
    );
    // Shared header chrome is present (the grammar) ...
    const head = container.querySelector(".c-grouped > .c-lhead");
    expect(head).toBeInTheDocument();
    expect(screen.getByText("Worker")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
    // ... AND the day-group labels render as the variant (not a bespoke layout).
    expect(container.querySelectorAll(".c-grouped > .c-daygrp").length).toBe(2);
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Yesterday")).toBeInTheDocument();
  });
});

describe("CollectionView — tag filtering (§8e)", () => {
  it("filters by a single status tag", async () => {
    const user = userEvent.setup();
    render(<Harness config={makeConfig()} />);
    expect(screen.getByText("DACH Compliance")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Add filter/i }));
    await user.click(screen.getByRole("button", { name: "ok" }));
    expect(screen.queryByText("DACH Compliance")).not.toBeInTheDocument(); // failing filtered out
    expect(screen.getByText("Weekly Update")).toBeInTheDocument();
    expect(screen.getByText("Gmail Intake")).toBeInTheDocument();
  });

  it("multi-selects content tags (OR) and clears with the all chip", async () => {
    const user = userEvent.setup();
    render(<Harness config={makeConfig()} />);

    await user.click(screen.getByRole("button", { name: /Add filter/i }));
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
    await user.click(screen.getByRole("button", { name: /Add filter/i }));
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

  it("resting list: ArrowDown roves focus, Enter opens the focused row (§8c)", () => {
    const { container } = render(
      <Harness config={makeConfig()} initial={{ ...emptyState("list") }} />,
    );
    const root = container.firstChild as HTMLElement;
    fireEvent.keyDown(root, { key: "ArrowDown" }); // focus row 0 (Weekly Update)
    fireEvent.keyDown(root, { key: "ArrowDown" }); // focus row 1 (DACH Compliance)
    expect(document.activeElement?.textContent).toContain("DACH Compliance");
    fireEvent.keyDown(document.activeElement!, { key: "Enter" }); // row opens itself
    expect(screen.getByText("About DACH Compliance")).toBeInTheDocument();
  });

  it("Escape closes the detail", async () => {
    const user = userEvent.setup();
    render(<Harness config={makeConfig()} />);
    await user.click(screen.getByText("Weekly Update"));
    expect(screen.getByRole("tab", { name: "About" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tab", { name: "About" })).not.toBeInTheDocument();
  });

  it("+Add opens the create panel in the detail pane; ✕ closes it (§5)", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        config={makeConfig({
          add: { label: "Add", panel: { title: "Create thing", render: () => <div>create form</div> } },
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByText("Create thing")).toBeInTheDocument();
    expect(screen.getByText("create form")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close detail" }));
    expect(screen.queryByText("create form")).not.toBeInTheDocument();
  });

  // GAP-POPCLOSE: the +Add panel is an inline split-pane (no backdrop), but it
  // must still dismiss like a proper popover — on click-outside and on Escape,
  // not only via the ✕.
  it("+Add panel dismisses on click-outside (GAP-POPCLOSE)", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        config={makeConfig({
          add: { label: "Add", panel: { title: "Create thing", render: () => <div>create form</div> } },
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByText("create form")).toBeInTheDocument();

    // A click anywhere outside the add pane (here: the document body) closes it.
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("create form")).not.toBeInTheDocument();
  });

  it("+Add panel dismisses on Escape (GAP-POPCLOSE)", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        config={makeConfig({
          add: { label: "Add", panel: { title: "Create thing", render: () => <div>create form</div> } },
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByText("create form")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    expect(screen.queryByText("create form")).not.toBeInTheDocument();
  });

  it("mouseDown INSIDE the +Add panel does NOT dismiss it (GAP-POPCLOSE)", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        config={makeConfig({
          add: { label: "Add", panel: { title: "Create thing", render: () => <div>create form</div> } },
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Add" }));
    const form = screen.getByText("create form");
    fireEvent.mouseDown(form);
    expect(screen.getByText("create form")).toBeInTheDocument();
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

describe("CollectionView — resolveMissing deep-link hydration (#1558)", () => {
  // A valid id deep-linked via ?sel that isn't in the loaded (partial/paged)
  // list must NOT false-toast: resolveMissing hydrates it, the detail opens.
  it("hydrates a deep-linked id absent from the list and opens it WITHOUT a toast", async () => {
    const onInvalidSel = vi.fn();
    const resolveMissing = vi.fn(async (id: string) =>
      id === "99"
        ? { id: "99", name: "Hydrated Worker", status: "ok", content: ["recruiting"] }
        : null,
    );
    render(
      <CollectionView
        config={makeConfig({ resolveMissing })}
        // "99" is not in ITEMS — it only exists via resolveMissing.
        state={{ ...emptyState("grid"), sel: "99" }}
        onChange={() => {}}
        onInvalidSel={onInvalidSel}
      />,
    );
    // detail opens once hydration resolves; no false "not found" toast.
    expect(await screen.findByText("About Hydrated Worker")).toBeInTheDocument();
    expect(resolveMissing).toHaveBeenCalledWith("99");
    expect(onInvalidSel).not.toHaveBeenCalled();
  });

  // A genuinely-missing id (resolveMissing → null) must still surface the toast.
  it("still toasts (onInvalidSel) when resolveMissing returns null for a real miss", async () => {
    const onInvalidSel = vi.fn();
    const resolveMissing = vi.fn(async () => null);
    render(
      <CollectionView
        config={makeConfig({ resolveMissing })}
        state={{ ...emptyState("grid"), sel: "ghost-id" }}
        onChange={() => {}}
        onInvalidSel={onInvalidSel}
      />,
    );
    await vi.waitFor(() => expect(onInvalidSel).toHaveBeenCalledWith("ghost-id"));
    expect(resolveMissing).toHaveBeenCalledWith("ghost-id");
    expect(screen.queryByText("About ghost-id")).not.toBeInTheDocument();
  });

  // A throw is a genuine miss too (e.g. 404/403 from the api client).
  it("toasts when resolveMissing throws", async () => {
    const onInvalidSel = vi.fn();
    const resolveMissing = vi.fn(async () => {
      throw new Error("404");
    });
    render(
      <CollectionView
        config={makeConfig({ resolveMissing })}
        state={{ ...emptyState("grid"), sel: "boom-id" }}
        onChange={() => {}}
        onInvalidSel={onInvalidSel}
      />,
    );
    await vi.waitFor(() => expect(onInvalidSel).toHaveBeenCalledWith("boom-id"));
  });

  // Guard: resolveMissing fires at most once per id (no loops/refetch storms).
  it("calls resolveMissing only once for the same id", async () => {
    const onInvalidSel = vi.fn();
    const resolveMissing = vi.fn(async (id: string) => ({
      id,
      name: "Once",
      status: "ok",
      content: [],
    }));
    render(
      <CollectionView
        config={makeConfig({ resolveMissing })}
        state={{ ...emptyState("grid"), sel: "once-id" }}
        onChange={() => {}}
        onInvalidSel={onInvalidSel}
      />,
    );
    expect(await screen.findByText("About Once")).toBeInTheDocument();
    expect(resolveMissing).toHaveBeenCalledTimes(1);
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

  // #1726/#1709 polish pass 2: a truly-empty collection hides the toolbar
  // (search + view toggle + add button) and tag filters — the empty state owns
  // the screen — so there is no duplicate "Add"/"New worker" CTA or useless
  // filter chrome with zero items.
  it("hides the search/filter/view-toggle toolbar when the collection is empty", () => {
    const { container } = render(<Harness config={makeConfig({ items: [] })} />);
    expect(screen.getByText("No workers yet")).toBeInTheDocument();
    // No search box, view toggle, tag bar, or toolbar add button on the empty surface.
    expect(container.querySelector(".c-toolbar")).not.toBeInTheDocument();
    expect(container.querySelector(".c-srch")).not.toBeInTheDocument();
    expect(container.querySelector(".c-tagbar-wrap")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View mode" })).not.toBeInTheDocument();
    // The empty-state fallback action (the page's add) is still reachable once,
    // not duplicated by a toolbar button.
    expect(screen.getAllByRole("button", { name: /Add/ })).toHaveLength(1);
  });

  // When a search/filter narrows a NON-empty list to zero, the toolbar STAYS so
  // the user can clear the query (only a genuinely empty collection hides it).
  it("keeps the toolbar when a filter narrows a non-empty list to zero", () => {
    const { container } = render(
      <Harness
        config={makeConfig()}
        initial={{ ...emptyState("grid"), q: "zzz-no-match" }}
      />,
    );
    expect(screen.getByText("No workers yet")).toBeInTheDocument();
    expect(container.querySelector(".c-toolbar")).toBeInTheDocument();
    expect(container.querySelector(".c-srch")).toBeInTheDocument();
  });
});
