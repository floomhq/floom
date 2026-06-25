import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { Collection } from "@/components/collection/Collection";
import type { CollectionConfig } from "@/lib/collection/types";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("sel=missing-id"),
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (message: string) => toastError(message),
  },
}));

interface Item {
  id: string;
  name: string;
}

function config(over: Partial<CollectionConfig<Item>> = {}): CollectionConfig<Item> {
  return {
    title: "Workers",
    items: [],
    idOf: (item) => item.id,
    resolveMissing: async () => null,
    searchOf: (item) => item.name,
    columns: { template: "1fr", headers: ["Name"] },
    row: (item) => ({ primary: item.name }),
    detail: (item) => ({
      header: { leading: null, title: item.name },
      tabs: [{ key: "About", label: "About", custom: "unmigrated" as const, render: () => null }],
    }),
    ...over,
  };
}

describe("Collection invalid deep-link feedback", () => {
  it("uses collection-specific copy for a genuinely missing selected item", async () => {
    render(
      <Collection
        config={config({
          invalidSelectionMessage: "Worker not found. It may have been deleted.",
        })}
      />,
    );

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("Worker not found. It may have been deleted.");
    });
  });
});
