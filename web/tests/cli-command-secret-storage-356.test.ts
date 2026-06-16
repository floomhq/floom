import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  getActiveWorkspaceId: () => null,
}));

vi.mock("@/lib/api-base", () => ({
  getPublicApiBase: () => "https://workeros-api.floom.dev",
  getPublicApiHost: () => "workeros-api.floom.dev",
}));

vi.mock("@/lib/mcp-config", () => ({
  buildMcpJson: (secret: string) => JSON.stringify({ secret }),
}));

vi.mock("@/components/ui/button", () => ({ Button: "button" }));
vi.mock("@/components/ui/tabs", () => ({
  Tabs: "div",
  TabsContent: "div",
  TabsList: "div",
  TabsTrigger: "button",
}));
vi.mock("@/components/McpToolCatalog", () => ({ McpToolCatalog: () => null }));

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
  };
}

function stubWindow() {
  const localStorage = storage();
  const sessionStorage = storage();
  vi.stubGlobal("window", { localStorage, sessionStorage });
  return { localStorage, sessionStorage };
}

describe("#356 CliCommandPanel secret storage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("stores new generated secrets only in sessionStorage", async () => {
    const { localStorage, sessionStorage } = stubWindow();
    const { storeSecretInSession } = await import("@/components/CliCommandPanel");

    storeSecretInSession("floom_secret_value");

    expect(sessionStorage.setItem).toHaveBeenCalledWith("floom_secret", "floom_secret_value");
    expect(localStorage.setItem).not.toHaveBeenCalled();
  });

  it("migrates legacy localStorage secrets into sessionStorage and purges localStorage", async () => {
    const { localStorage, sessionStorage } = stubWindow();
    localStorage.getItem.mockImplementation((key: string) => (key === "workeros_api_secret" ? " legacy-token " : null));
    const { readStoredSecret } = await import("@/components/CliCommandPanel");

    expect(readStoredSecret()).toBe("legacy-token");
    expect(sessionStorage.setItem).toHaveBeenCalledWith("floom_secret", "legacy-token");
    expect(localStorage.removeItem).toHaveBeenCalledWith("floom_secret");
    expect(localStorage.removeItem).toHaveBeenCalledWith("FLOOM_SECRET");
    expect(localStorage.removeItem).toHaveBeenCalledWith("workeros_api_secret");
  });

  it("clear removes session and legacy localStorage keys", async () => {
    const { localStorage, sessionStorage } = stubWindow();
    const { clearStoredSecrets } = await import("@/components/CliCommandPanel");

    clearStoredSecrets();

    for (const key of ["floom_secret", "FLOOM_SECRET", "workeros_api_secret"]) {
      expect(sessionStorage.removeItem).toHaveBeenCalledWith(key);
      expect(localStorage.removeItem).toHaveBeenCalledWith(key);
    }
  });
});
