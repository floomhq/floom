// Centralised humanisation for run-detail + history operator views.
// Batch A (2026-05-29): one source of truth for turning raw API output
// (JSON keys, machine error codes, infra log lines, export booleans) into
// operator-readable language. Keeps the raw values available in the Raw tab.

// ---------------------------------------------------------------------------
// Output keys: "word_count" -> "Word count", "PDF_EXPORT" -> "PDF export"
// ---------------------------------------------------------------------------
const KEY_ACRONYMS = new Set(["pdf", "docx", "csv", "json", "url", "id", "html", "api", "crm", "jd"]);

export function humanizeKey(raw: string): string {
  if (!raw) return raw;
  const words = raw.replace(/[_-]+/g, " ").trim().split(/\s+/);
  if (words.length === 0) return raw;
  return words
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (KEY_ACRONYMS.has(lower)) return lower.toUpperCase();
      if (i === 0) return lower.charAt(0).toUpperCase() + lower.slice(1);
      return lower;
    })
    .join(" ");
}

// ---------------------------------------------------------------------------
// Export-success booleans. The OpenDraft (and similar) workers emit
// `pdf_export_success` / `docx_export_success` scalars. The matching
// export_report distinguishes "not requested" from "failed", but the bare
// scalar is just a boolean. Surface a clear human STATE, never bare `false`.
// ---------------------------------------------------------------------------
export function isExportSuccessKey(key: string): boolean {
  return /_export_success$/i.test(key) || /^export_success$/i.test(key);
}

export type ExportState = { label: string; tone: "ok" | "muted" | "warn" };

export function exportSuccessState(key: string, value: unknown): ExportState {
  // Format label e.g. pdf_export_success -> "PDF export"
  const base = key.replace(/_export_success$/i, "").replace(/^export_success$/i, "Export");
  const label = humanizeKey(base) + (base.toLowerCase() === "export" ? "" : " export");
  if (value === true) return { label, tone: "ok" };
  // false: we cannot tell "not requested" from "failed" from the scalar alone.
  // Treat absence of success as "Not generated" (muted) rather than a red
  // failure, because in practice false almost always means the format was not
  // requested for this run. A true failure surfaces via run.error / logs.
  return { label, tone: "muted" };
}

export function exportStateText(state: ExportState): string {
  return state.tone === "ok" ? `${state.label}: generated` : `${state.label}: not generated`;
}

// ---------------------------------------------------------------------------
// Infra / audit log lines. The operator Logs view must not show sandbox
// provider names, unsubstituted [redacted-*] placeholders, or per-file upload
// chatter. These stay available in the Raw tab.
// ---------------------------------------------------------------------------
export function isInfraLogLine(message: string): boolean {
  const m = (message || "").trim();
  if (!m) return false;
  // Sandbox provider chatter: "[e2b] ...", "[firecracker] ..."
  if (/^\[(e2b|firecracker|sandbox|runner)\]/i.test(m)) return true;
  // Unsubstituted redaction placeholders leaking into the message. Two formats:
  //   - square-bracket  [redacted-id]            (public_view log redactor)
  //   - angle-bracket   <REDACTED:SECRET_NAME>   (#1703, scrub_secrets)
  if (/\[redacted-[a-z-]+\]/i.test(m)) return true;
  // Secret names allow mixed/lower case ([A-Za-z_]); match them all (#1752).
  if (/<REDACTED(?::[A-Za-z0-9_]+)?>/.test(m)) return true;
  // Low-level lifecycle noise that duplicates the timeline / metrics strip
  if (/^(Validating inputs|Loading secrets)$/i.test(m)) return true;
  return false;
}

export function operatorLogs<T extends { message: string }>(logs: T[]): T[] {
  return logs.filter((l) => !isInfraLogLine(l.message));
}

// ---------------------------------------------------------------------------
// Machine error codes -> operator-readable messages.
//   "missing_connection: github"  -> "Missing connection: GitHub"
//   "output_validation_failed: enriched_csv file is too small (82 bytes...)"
//        -> "Output too small: enriched_csv file is too small (82 bytes...)"
// Also strips Python dict syntax from OpenAI-style "Error code: N - {...}".
// ---------------------------------------------------------------------------
const ERROR_CODE_LABELS: Record<string, string> = {
  missing_connection: "Missing connection",
  missing_secret: "Missing secret",
  missing_secrets: "Missing secrets",
  output_validation_failed: "Output validation failed",
  output_too_small: "Output too small",
  timeout: "Timed out",
  rate_limited: "Rate limited",
  connection_expired: "Connection expired",
  invalid_input: "Invalid input",
  execution_failed: "Execution failed",
  sandbox_error: "Sandbox error",
  e2b_sandbox_error: "Sandbox error",
};

// Calm headline for the sandbox-error code, mirroring the backend
// _SANDBOX_HEADLINE in apps/api/services/public_view.py. Used when only a raw
// `e2b_sandbox_error: <...>` string reaches the client (#1700).
const SANDBOX_HEADLINE =
  "The sandbox could not start or stay connected. Try again, then check the E2B configuration if it repeats.";

// Low-level transport/library exception reprs, e.g. h2's
// "<ConnectionTerminated error_code:1, last_stream_id:343, ...>". These must
// never render verbatim to an operator (#1700).
const LIBRARY_REPR = /<([A-Za-z_][A-Za-z0-9_]*)\b[^>]*>/g;

function titleCaseToken(tok: string): string {
  // Known service slugs get a friendly capitalisation.
  const known: Record<string, string> = {
    github: "GitHub",
    gmail: "Gmail",
    linkedin: "LinkedIn",
    googlecalendar: "Google Calendar",
    googledrive: "Google Drive",
    notion: "Notion",
    slack: "Slack",
  };
  const lower = tok.toLowerCase();
  if (known[lower]) return known[lower];
  return tok;
}

export function humanizeRunError(error: string | null | undefined): string {
  const cleaned = (error || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";

  // OpenAI-style "Error code: N - {'error': {'message': '...'}}"
  const dictMatch = cleaned.match(/Error code:\s*\d+\s*-\s*[{'"]/i);
  if (dictMatch) {
    const msgMatch =
      cleaned.match(/"message"\s*:\s*"([^"]{1,200})"/i) ||
      cleaned.match(/'message'\s*:\s*'([^']{1,200})'/i);
    if (msgMatch) {
      const msg = msgMatch[1].trim();
      return msg.length > 160 ? `${msg.slice(0, 157)}...` : msg;
    }
    const codeMatch = cleaned.match(/Error code:\s*(\d+)/i);
    if (codeMatch) return `Request error (code ${codeMatch[1]})`;
  }

  // Machine code prefix "<snake_code>: <rest>"
  const codeMatch = cleaned.match(/^([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*:\s*(.*)$/i);
  if (codeMatch) {
    const code = codeMatch[1].toLowerCase();
    const rest = codeMatch[2].trim();
    // Sandbox errors carry raw transport-layer detail (h2 reprs, template ids).
    // Never surface the detail; collapse to the calm headline (#1700).
    if (code === "e2b_sandbox_error" || code === "sandbox_error") {
      return SANDBOX_HEADLINE;
    }
    const label = ERROR_CODE_LABELS[code];
    if (label) {
      const restHuman =
        code === "missing_connection"
          ? rest.split(/[\s,]+/).map(titleCaseToken).join(", ")
          : rest;
      const out = restHuman ? `${label}: ${restHuman}` : label;
      return out.length > 160 ? `${out.slice(0, 157)}...` : out;
    }
  }

  // Defense-in-depth: strip any leftover raw library exception repr from the
  // passthrough text so a "<ConnectionTerminated ...>" never reaches the banner.
  const noRepr = cleaned.replace(LIBRARY_REPR, "$1").replace(/\s{2,}/g, " ").trim();
  return noRepr.length > 160 ? `${noRepr.slice(0, 157)}...` : noRepr;
}

// ---------------------------------------------------------------------------
// Operator-facing log-line humanisation (G5 rescore4 P2, 2026-05-29).
// The Result-tab "Recent logs" preview is a glance surface. Raw runtime/infra
// error strings ("Agent runtime error: Event loop is closed", tracebacks,
// asyncio internals) must not leak there — the calm headline already explains
// the failure. The full raw line stays in the Logs/Raw tabs.
//
// Mirrors the backend _RUNTIME_HEADLINE so the preview reads the same calm
// sentence the failure banner shows, instead of internal jargon.
// ---------------------------------------------------------------------------
const RUNTIME_LOG_HEADLINE =
  "This worker hit an internal error and stopped. Check the logs, then edit or re-run the worker.";

// Patterns that signal a low-level runtime/infra error an operator should never
// read verbatim. Kept in sync with the backend free-text error rules.
const INFRA_ERROR_PATTERNS: RegExp[] = [
  /Event loop is closed/i,
  /\basyncio\b/i,
  /\bcoroutine\b/i,
  /\bTraceback \(most recent call last\)/i,
  /\bRuntimeError\b/i,
  /Agent runtime error/i,
  /\b(?:KeyError|NameError|AttributeError|TypeError|ValueError|ImportError|ModuleNotFoundError)\b/,
  /\bSyntaxError\b|\bIndentationError\b/,
];

/**
 * Humanise a single log line for the operator-facing Result-tab preview.
 * Error/critical lines that carry raw runtime/infra jargon collapse to the
 * calm runtime headline; everything else passes through unchanged.
 */
export function humanizeLogMessage(level: string, message: string): string {
  const msg = (message || "").trim();
  if (!msg) return msg;
  const isError = level === "error" || level === "critical";
  if (!isError) return msg;
  if (INFRA_ERROR_PATTERNS.some((re) => re.test(msg))) {
    return RUNTIME_LOG_HEADLINE;
  }
  // Known machine-code error strings still get the structured humaniser.
  return humanizeRunError(msg) || msg;
}
