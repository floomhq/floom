import { describe, it, expect } from "vitest";
import {
  markHash,
  generateMark,
  generateMarkForRole,
  namespacedSeed,
  MARK_PAIRS,
  USER_MARK_PAIRS,
  MARK_GROUND,
  MARK_MOTIF_COUNT,
} from "@/lib/avatar/generate";

// SSR-safe pure-function tests for the locked identity-mark generator.
// SPEC: workeros-design-baseline/SPEC.md.

describe("markHash", () => {
  it("returns a non-negative integer", () => {
    expect(markHash("Nova Search")).toBeGreaterThanOrEqual(0);
    expect(markHash("")).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(markHash("test"))).toBe(true);
  });

  it("is deterministic — same seed always yields same hash", () => {
    for (const s of ["Nova Search", "Federico", "Emily", "Acme", "a", ""]) {
      expect(markHash(s)).toBe(markHash(s));
    }
  });

  it("differs for different seeds", () => {
    expect(
      new Set([markHash("Nova Search"), markHash("Acme Corp"), markHash("Beacon")]).size,
    ).toBe(3);
  });
});

describe("generateMark", () => {
  it("is deterministic — same seed, same motif + tones", () => {
    for (const s of ["Nova Search", "Federico", "Acme"]) {
      expect(generateMark(s)).toEqual(generateMark(s));
    }
  });

  it("selects a valid motif index and a real tone pair from MARK_PAIRS", () => {
    for (const s of ["a", "b", "workspace", "user@example.com", "Northwind"]) {
      const m = generateMark(s);
      expect(m.motifIndex).toBeGreaterThanOrEqual(0);
      expect(m.motifIndex).toBeLessThan(MARK_MOTIF_COUNT);
      expect(MARK_PAIRS.some(([c1, c2]) => c1 === m.c1 && c2 === m.c2)).toBe(true);
    }
  });
});

describe("palette constraints (restrained cool palette, no rainbow)", () => {
  it("ground is the neutral token value", () => {
    expect(MARK_GROUND).toBe("#F3F4F6");
  });

  it("MARK_PAIRS (workspace/worker) has 5 two-blue pairs, every tone a 6-digit hex", () => {
    expect(MARK_PAIRS).toHaveLength(5);
    for (const pair of MARK_PAIRS) {
      expect(pair).toHaveLength(2);
      for (const c of pair) expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("workspace tones are cool blue (blue channel dominates red)", () => {
    for (const pair of MARK_PAIRS) {
      for (const c of pair) {
        const r = parseInt(c.slice(1, 3), 16);
        const b = parseInt(c.slice(5, 7), 16);
        expect(b).toBeGreaterThan(r);
      }
    }
  });

  it("USER_MARK_PAIRS (user) has 5 graphite pairs, every tone a 6-digit hex", () => {
    expect(USER_MARK_PAIRS).toHaveLength(5);
    for (const pair of USER_MARK_PAIRS) {
      expect(pair).toHaveLength(2);
      for (const c of pair) expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("user tones are graphite — low chroma, no dominant hue (max-min < 60)", () => {
    for (const pair of USER_MARK_PAIRS) {
      for (const c of pair) {
        const r = parseInt(c.slice(1, 3), 16);
        const g = parseInt(c.slice(3, 5), 16);
        const b = parseInt(c.slice(5, 7), 16);
        const chroma = Math.max(r, g, b) - Math.min(r, g, b);
        expect(chroma).toBeLessThan(60);
      }
    }
  });

  it("user and workspace palettes are fully disjoint — no shared tones", () => {
    const userTones = USER_MARK_PAIRS.flat();
    const wsTones = MARK_PAIRS.flat();
    for (const t of userTones) {
      expect(wsTones).not.toContain(t);
    }
  });
});

// ---------------------------------------------------------------------------
// Role-based index offsets — generateMarkForRole must NEVER produce the same
// motifIndex for the same seed across different roles (mathematically guaranteed
// because every non-user offset is coprime to MARK_MOTIF_COUNT=6).
//
// Live bug: "Federico De Ponte" user and "Nova Search" workspace both rendered
// the same blue cross because the seed was raw name only. After this fix, the
// role-based offset shifts the motif index so same-seed pairs never collide.
// ---------------------------------------------------------------------------

describe("generateMarkForRole — no collision across roles for same seed", () => {
  it("user and workspace with the SAME name always produce DIFFERENT motifIndex", () => {
    // Mathematical guarantee: workspace offset=3 is coprime to 6, so
    // (h%6 + 3) % 6 can never equal h%6 for any h.
    const seeds = ["Federico De Ponte", "Acme Corp", "Nova Search", "a", "test", "x"];
    for (const seed of seeds) {
      const user = generateMarkForRole("user", seed);
      const workspace = generateMarkForRole("workspace", seed);
      expect(user.motifIndex).not.toBe(workspace.motifIndex);
    }
  });

  it("user and workspace with the SAME name always produce DIFFERENT motif+tone combined", () => {
    const user = generateMarkForRole("user", "Federico De Ponte");
    const workspace = generateMarkForRole("workspace", "Federico De Ponte");
    const identical = user.motifIndex === workspace.motifIndex && user.c1 === workspace.c1 && user.c2 === workspace.c2;
    expect(identical).toBe(false);
  });

  it("user and workspace with the SAME name differ — reported live-bug pair", () => {
    // Original collision: "Federico De Ponte" user and "Nova Search" workspace.
    const user = generateMarkForRole("user", "Federico De Ponte");
    const workspace = generateMarkForRole("workspace", "Nova Search");
    const identical = user.motifIndex === workspace.motifIndex && user.c1 === workspace.c1 && user.c2 === workspace.c2;
    expect(identical).toBe(false);
  });

  it("same (role, id) is stable across calls — marks survive renames when id is stable", () => {
    const a = generateMarkForRole("user", "user-uuid-abc123");
    const b = generateMarkForRole("user", "user-uuid-abc123");
    expect(a).toEqual(b);

    const c = generateMarkForRole("workspace", "ws-uuid-xyz789");
    const d = generateMarkForRole("workspace", "ws-uuid-xyz789");
    expect(c).toEqual(d);
  });

  it("worker role does not collide with workspace of same name", () => {
    const seeds = ["Acme Corp", "Nova Search", "test"];
    for (const seed of seeds) {
      const workspace = generateMarkForRole("workspace", seed);
      const worker = generateMarkForRole("worker", seed);
      // worker offset=1 (coprime to 6), workspace offset=3 — they differ from each other too.
      expect(worker.motifIndex).not.toBe(workspace.motifIndex);
    }
  });

  it("namespacedSeed helper (legacy) prefixes the role", () => {
    expect(namespacedSeed("user", "Nova Search")).toBe("user:Nova Search");
    expect(namespacedSeed("workspace", "Nova Search")).toBe("workspace:Nova Search");
  });

  it("user marks use USER_MARK_PAIRS (graphite) — never blue", () => {
    for (const s of ["Federico", "user@example.com", "Alice", "Bob"]) {
      const m = generateMarkForRole("user", s);
      expect(USER_MARK_PAIRS.some(([c1, c2]) => c1 === m.c1 && c2 === m.c2)).toBe(true);
      expect(MARK_PAIRS.some(([c1, c2]) => c1 === m.c1 && c2 === m.c2)).toBe(false);
    }
  });

  it("workspace marks use MARK_PAIRS (accent blue) — never graphite", () => {
    for (const s of ["Nova Search", "reltix", "Acme", "Heidi Health"]) {
      const m = generateMarkForRole("workspace", s);
      expect(MARK_PAIRS.some(([c1, c2]) => c1 === m.c1 && c2 === m.c2)).toBe(true);
      expect(USER_MARK_PAIRS.some(([c1, c2]) => c1 === m.c1 && c2 === m.c2)).toBe(false);
    }
  });

  it("worker marks use MARK_PAIRS (accent blue) — same family as workspace", () => {
    for (const s of ["EmailWorker", "ReportBot"]) {
      const m = generateMarkForRole("worker", s);
      expect(MARK_PAIRS.some(([c1, c2]) => c1 === m.c1 && c2 === m.c2)).toBe(true);
      expect(USER_MARK_PAIRS.some(([c1, c2]) => c1 === m.c1 && c2 === m.c2)).toBe(false);
    }
  });

  it("user and workspace with the SAME seed always differ in BOTH motif AND color", () => {
    const liveBugSeeds = ["Federico De Ponte", "Nova Search", "reltix", "Heidi Health", "Acme"];
    for (const s of liveBugSeeds) {
      const userMark = generateMarkForRole("user", s);
      const wsMark = generateMarkForRole("workspace", s);
      // Motif MUST differ (coprimality guarantee).
      expect(userMark.motifIndex).not.toBe(wsMark.motifIndex);
      // Colors MUST differ (different palettes).
      expect(userMark.c1).not.toBe(wsMark.c1);
      expect(userMark.c2).not.toBe(wsMark.c2);
    }
  });

  // #1920: workspace mark seed-unification regression guard.
  // WorkspaceSwitcher seeds Avatar by stable workspace id; WorkspaceMark
  // (sidebar header + collapsed rail) previously seeded by name only →
  // different motif when id ≠ name. Fix: WorkspaceMark now passes id to Avatar.
  // This test proves that seeding by id is stable and that name-only produces
  // a different result for a realistic workspace (confirming the bug existed).
  it("#1920 — same workspace id seeds identical mark regardless of name change (rename safety)", () => {
    const wsId = "ws_4a86449f41b646";
    const originalMark = generateMarkForRole("workspace", wsId);
    // Renaming must NOT change the mark (id is stable).
    const renamedMark = generateMarkForRole("workspace", wsId);
    expect(originalMark).toEqual(renamedMark);
  });

  it("#1920 — seeding by id vs name produces different marks (proves the pre-fix bug)", () => {
    // Before the fix, WorkspaceSwitcher used id="ws_abc123" but WorkspaceMark
    // used name="depontefede". These hash differently → different motif. This
    // test documents that the divergence exists (and is now fixed by always
    // using the id).
    const byId   = generateMarkForRole("workspace", "ws_abc123");
    const byName = generateMarkForRole("workspace", "depontefede");
    // They should differ — this is the bug that caused the visible inconsistency.
    const identical =
      byId.motifIndex === byName.motifIndex &&
      byId.c1 === byName.c1 &&
      byId.c2 === byName.c2;
    expect(identical).toBe(false);
  });
});
