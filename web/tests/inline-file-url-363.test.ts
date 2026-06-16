import { describe, expect, it } from "vitest";
import { safeInlineFileUrl } from "@/components/file-viewer/InlineFileOpen";

describe("#363 InlineFileOpen URL allowlist", () => {
  const origin = "https://workers.floom.dev";

  it("allows same-origin proxy and upload paths", () => {
    expect(safeInlineFileUrl("/api/proxy/contexts/a/files/b.png?download=1", origin)).toBe(
      "/api/proxy/contexts/a/files/b.png?download=1",
    );
    expect(safeInlineFileUrl("https://workers.floom.dev/app/api/proxy/runs/r1/download", origin)).toBe(
      "/app/api/proxy/runs/r1/download",
    );
    expect(safeInlineFileUrl("/uploads/abc.png", origin)).toBe("/uploads/abc.png");
  });

  it("blocks external, protocol-relative, and unexpected same-origin paths", () => {
    expect(safeInlineFileUrl("https://evil.example/file.png", origin)).toBeNull();
    expect(safeInlineFileUrl("//evil.example/file.png", origin)).toBeNull();
    expect(safeInlineFileUrl("javascript:alert(1)", origin)).toBeNull();
    expect(safeInlineFileUrl("/login?next=/api/proxy/contexts/a", origin)).toBeNull();
  });
});
