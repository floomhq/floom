# MCP And Account Fixes, 2026-06-05

## M83: MCP Connections Default To JSON

Root cause: `/connections/mcp` opened the add flow in the manual form mode. The page did have JSON import support, but JSON was secondary and optimized for bulk client config import instead of the common single-server config.

Fix: the add flow now opens in `JSON config` mode by default. The editor validates the server payload before save, including transport, HTTP/SSE URL, stdio command, secret-name fields, `env` secret references, `args`, and `allowed_tools`.

Verification: local browser verification confirmed the first visible add mode is `JSON config` and shows `Valid JSON config` before save.

## M84: Add MCP Server Flow

Root cause: the previous flow mixed three concepts: installing Workeros into an MCP client, manually adding a third-party MCP server, and importing client JSON. That made the primary action feel like a form task even though MCP server setup is normally JSON config.

Fix: the page now separates the secondary client-install section from the worker MCP-server add flow. The add flow is JSON first, with `Form` and `Import from JSON` available as secondary modes. The copy avoids asking for secret values and keeps secret names explicit.

Verification: TypeScript production build and browser verification both exercised the new add panel. The changed UI copy contains no em dash or en dash characters.

## M81: Signed-In User Email

Root cause: the sidebar account footer was hardcoded to `Local user`. There was no `/me` backend identity endpoint and no same-origin `/api/me` route for the frontend to read the current `AuthContext`. `WorkspaceSwitcher` only handled workspace selection and did not expose the signed-in user identity.

Fix: the API now exposes `GET /me`, the Next app exposes `/api/me` and forwards auth, cookies, and workspace headers to the backend, and `UserProfileFooter` fetches `api.me()` to render the signed-in email when present.

Verification: backend test coverage confirms `/me` returns `fed@example.com` from the auth context. Local browser verification confirmed the sidebar footer renders `fed@example.com` and `Signed in`.

## Notes

No secret values were added. The JSON examples use secret names only.
