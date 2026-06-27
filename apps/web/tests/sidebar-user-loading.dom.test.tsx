import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { UserProfileFooter } from "@/components/layout/sidebar";

const apiMock = vi.hoisted(() => ({
  me: vi.fn(),
  workspaceList: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/workers",
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/api", () => ({
  api: {
    me: apiMock.me,
    workspace: {
      list: apiMock.workspaceList,
    },
  },
}));

function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("UserProfileFooter", () => {
  it("does not flash the OSS Local user fallback while account identity loads", async () => {
    const me = pending<{
      user_id: string;
      email: string;
      display_name: string;
    }>();
    apiMock.me.mockReturnValue(me.promise);
    apiMock.workspaceList.mockResolvedValue({
      active_id: "ws_1",
      workspaces: [{ id: "ws_1", name: "Acme", owner_user_id: "u1", created_at: "2026-06-01T00:00:00Z" }],
    });

    render(<UserProfileFooter />);

    expect(screen.getByText("Loading account")).toBeInTheDocument();
    expect(screen.queryByText("Local user")).not.toBeInTheDocument();

    me.resolve({
      user_id: "u1",
      email: "vivek@floom.dev",
      display_name: "Vivek",
    });

    await waitFor(() => expect(screen.getByText("vivek@floom.dev")).toBeInTheDocument());
    expect(screen.queryByText("Loading account")).not.toBeInTheDocument();
  });
});
