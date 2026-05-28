# Changelog

## 4.0.0 (2026-05-29)

### UX-only breaking changes

Human-readable stdout output has changed format. Programmatic JSON output (`--json` flag on every command) is **unchanged** — no schema regressions.

- **Structured log layer** ported from skills-neo: `log.step`, `log.ok`, `log.warn`, `log.err`, `log.kv`, `log.heading`, `log.blank`. All human output now uses these instead of raw `console.log`.
- **Every error includes a next-step hint** — `log.err("message")` is always followed by `log.info("Run: ...")` with a concrete recovery command.
- **`floom login`** now shows `log.heading("Login")`, `log.step("Requesting...")`, `log.ok("Open: <url>")`, `log.step("Waiting...")`, then on success `log.kv("API", ...)` + `log.kv("Token saved to", ...)` + `log.info("Try: floom workers list")`.
- **`floom doctor`** — new command. Runs 4 checks: API reachable, auth token valid, MCP config installed, recent runs endpoint. Each check emits green ✓ / yellow ! / red ✗. Final: "All checks passed." or "X checks failed; see hints above."
- **`floom workers info <id>`** — new command. Pretty single-worker view showing description, trigger, connections, secrets needed, last run age/status/duration, recent success rate. Different from `workers show` which dumps raw YAML.
- **chalk** added as a production dependency for ANSI colour output.

### Migration notes

If you parse `floom <cmd>` stdout in scripts: use `--json` instead. The `--json` schema is stable and will not change between minor versions.
