import { describe, expect, it } from "vitest";

function base64Url(value: string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

describe("cloud /api/me route", () => {
  it("returns the signed-in user's profile photo and display name", async () => {
    const { parseCurrentUser } = await import("../app/lib/me");

    const accessTokenPayload = {
      sub: "user-123",
      email: "fede@example.com",
      name: "Federico De Ponte",
      user_metadata: {
        full_name: "Federico De Ponte",
        picture: "https://avatars.example.com/u/123.png",
      },
    };

    const sessionCookie = base64Url(JSON.stringify({
      access_token: `header.${base64Url(JSON.stringify(accessTokenPayload))}.signature`,
    }));
    expect(parseCurrentUser(sessionCookie)).toEqual({
      user_id: "user-123",
      email: "fede@example.com",
      display_name: "Federico De Ponte",
      picture: "https://avatars.example.com/u/123.png",
    });
  });
});
