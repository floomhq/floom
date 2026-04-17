# Legal + compliance

Floom is operated from Hamburg, Germany, which means every public page ships a §5 TMG imprint, a GDPR-shaped privacy notice, standard terms of service, and a cookie disclosure. All four pages live at top-level routes on `floom.dev`.

## Pages

- [Imprint](/imprint) · `/impressum` alias works for German readers
- [Privacy](/privacy)
- [Terms](/terms)
- [Cookies](/cookies)

Each page is also reachable under `/legal/<name>` for deep links from external docs.

## Data handling summary

- **No analytics cookies without consent.** The cookie banner on every page controls third-party analytics; only session-essential cookies (`floom_session`, `floom_device`) are set before consent.
- **Anonymous sessions are device-scoped.** Every visitor carries a `floom_device` cookie (HttpOnly, SameSite=Lax, 10-year TTL). All runs, memory, and secrets created while anonymous are bound to that device. On first login, `rekeyDevice` atomically re-keys every row to the authenticated user — idempotent, no migration job.
- **Per-user secrets are AES-256-GCM encrypted** with a per-workspace data-encryption key wrapped under `FLOOM_MASTER_KEY`. Plaintext never touches disk. Lose the master key, lose the secrets — back it up.
- **Per-user app memory is gated** by the app manifest's `memory_keys` declaration. Keys not in the allowlist are rejected with `403 memory_key_not_allowed`. Two users of the same app never see each other's state.
- **Runs are retained** in the local SQLite DB until you delete them via `/me` or the account-delete flow. Account delete is a hard delete — runs, memory, secrets, connections are wiped in one transaction.
- **No upstream telemetry.** Self-hosted Floom makes zero outbound requests unless you configure them (OpenAI embeddings, Composio, Stripe, webhook delivery).

If you need a signed DPA or have a specific compliance question, email [hello@floom.dev](mailto:hello@floom.dev).
