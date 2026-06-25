// #749: the CloudAccountFooter seeds the account/workspace identity ("vbellala"
// + workspace name) from sessionStorage so a hard reload paints the real user
// INSTANTLY instead of flashing a placeholder while the slow /api/me round-trip
// is in flight. The module-level cache alone is wiped on reload; sessionStorage
// survives it. These cover the seed read/write/clear that the footer relies on.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readSessionCloudUser,
  writeSessionCloudUser,
  clearSessionCloudUser,
} from "@/components/CloudAccountFooter";

const SESSION_KEY = "floom_cloud_user";
const USER = {
  user_id: "user-123",
  email: "fede@floom.dev",
  display_name: "Federico De Ponte",
  picture: null,
} as const;

describe("CloudAccountFooter sessionStorage identity seed (#749)", () => {
  beforeEach(() => window.sessionStorage.clear());
  afterEach(() => window.sessionStorage.clear());

  it("returns null when nothing is cached", () => {
    expect(readSessionCloudUser()).toBeNull();
  });

  it("round-trips the user: write persists, read returns it on the next mount", () => {
    writeSessionCloudUser(USER as never);
    expect(readSessionCloudUser()).toEqual(USER);
    // Survives a notional reload (sessionStorage is untouched by remount).
    expect(JSON.parse(window.sessionStorage.getItem(SESSION_KEY)!)).toEqual(USER);
  });

  it("clears the cached user (logout path)", () => {
    writeSessionCloudUser(USER as never);
    clearSessionCloudUser();
    expect(readSessionCloudUser()).toBeNull();
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it("ignores a malformed entry instead of throwing", () => {
    window.sessionStorage.setItem(SESSION_KEY, "{not valid json");
    expect(readSessionCloudUser()).toBeNull();
  });

  it("ignores an incomplete user with no email (avoids seeding a blank mark)", () => {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ user_id: "x" }));
    expect(readSessionCloudUser()).toBeNull();
  });
});
