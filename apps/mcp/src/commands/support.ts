import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAuthenticatedClient, FloomApiError } from "../lib/api.js";
import { getCommandName } from "../lib/command-name.js";
import { log, printJson, renderTable } from "../lib/output.js";

// #806 — `floom support` ticket commands + `floom feedback`, 1:1 with the
// cloud member API (docs/SUPPORT-TICKETS.md, mounted at /api/support/*). The
// FloomApiClient prepends /api in hosted (cloud) mode, so paths here start at
// /support. Support is a cloud-only feature; against an OSS engine these routes
// 404 (handled below as a clear "cloud-only" message).

// Mirror the server-side caps (apps/api/support.py) so we fail fast and, for
// `feedback`, fit the appended transcript under the body limit.
const MAX_SUBJECT_LEN = 200;
const MAX_BODY_LEN = 20_000;
const VALID_SEVERITY = ["low", "normal", "high"] as const;
const VALID_STATUS = ["open", "resolved"] as const;

type Severity = (typeof VALID_SEVERITY)[number];

type SupportMessage = {
  id: string;
  author_kind: "opener" | "staff";
  body: string;
  created_at: string;
};

type SupportTicket = {
  id: string;
  subject: string;
  status: string;
  severity: string;
  opened_via?: string;
  unread_for_opener?: boolean;
  workspace_id?: string;
  created_at?: string;
  updated_at?: string;
  messages?: SupportMessage[];
};

type TicketListResponse = { tickets: SupportTicket[]; unread_count?: number };

// The dashboard ticket URL printed on file. Cloud serves the dashboard under
// /app on floom.dev; allow an env override rather than baking the host in.
function deepLink(ticketId: string): string {
  const base = (process.env.WORKEROS_APP_BASE || "https://floom.dev/app").replace(/\/+$/, "");
  return `${base}/support/${ticketId}`;
}

// Shared error mapping (mirrors runs.ts::handleAuthError). Returns an exit code
// when it recognises the error, or null to let the caller rethrow.
function handleAuthError(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Not logged in")) {
    log.err("Not authenticated.");
    process.stderr.write(`Run: ${getCommandName()} login\n`);
    return 1;
  }
  if (error instanceof FloomApiError && (error.status === 401 || error.status === 403)) {
    log.err("Your session expired.");
    process.stderr.write(`Re-run: ${getCommandName()} login\n`);
    return 1;
  }
  if (error instanceof FloomApiError && error.status && error.status >= 500) {
    log.err(`API error: ${message}`);
    process.stderr.write("Check API status, then retry.\n");
    return 1;
  }
  return null;
}

// Support has no OSS counterpart: a 404 on a *collection* route means the engine
// does not mount /api/support (self-hosted), not that a ticket is missing.
function noteCloudOnlyOn404(error: unknown): boolean {
  if (error instanceof FloomApiError && error.status === 404) {
    log.err("Support is a cloud-only feature.");
    process.stderr.write(`Log in to the hosted product: ${getCommandName()} login --cloud\n`);
    return true;
  }
  return false;
}

function validSeverity(value: string | undefined): value is Severity {
  return value !== undefined && (VALID_SEVERITY as readonly string[]).includes(value);
}

function renderThread(ticket: SupportTicket): void {
  log.heading(ticket.subject);
  log.kv("Ticket", ticket.id);
  log.kv("Status", ticket.status);
  log.kv("Severity", ticket.severity);
  if (ticket.opened_via) log.kv("Opened via", ticket.opened_via);
  if (ticket.workspace_id) log.kv("Workspace", ticket.workspace_id);
  const messages = ticket.messages || [];
  if (!messages.length) {
    log.blank();
    log.info("(no messages)");
    return;
  }
  for (const m of messages) {
    log.blank();
    const who = m.author_kind === "staff" ? "Support" : "You";
    log.info(`${who} · ${m.created_at}`);
    process.stdout.write(`${m.body}\n`);
  }
}

// --- support file -----------------------------------------------------------

export async function supportFileCommand(options: {
  subject?: string;
  body?: string;
  severity?: string;
  operation?: string;
  errorCode?: string;
  json?: boolean;
}): Promise<number> {
  const subject = (options.subject || "").trim();
  if (!subject) {
    log.err("--subject is required.");
    return 1;
  }
  if (subject.length > MAX_SUBJECT_LEN) {
    log.err(`--subject must be <= ${MAX_SUBJECT_LEN} characters.`);
    return 1;
  }
  if (options.severity !== undefined && !validSeverity(options.severity)) {
    log.err(`--severity must be one of: ${VALID_SEVERITY.join(", ")}.`);
    return 1;
  }
  // The first message body is --body plus any structured agent context. At least
  // one of these must be present (the API requires a non-empty body).
  const parts: string[] = [];
  if (options.body && options.body.trim()) parts.push(options.body.trim());
  if (options.operation && options.operation.trim()) parts.push(`Operation: ${options.operation.trim()}`);
  if (options.errorCode && options.errorCode.trim()) parts.push(`Error code: ${options.errorCode.trim()}`);
  const body = parts.join("\n\n");
  if (!body) {
    log.err("Provide --body (or --operation / --error-code for context).");
    return 1;
  }
  if (body.length > MAX_BODY_LEN) {
    log.err(`Message body must be <= ${MAX_BODY_LEN} characters.`);
    return 1;
  }

  try {
    const { client } = await createAuthenticatedClient();
    const ticket = (await client.requestJson("POST", "/support/tickets", {
      body: { subject, body, severity: options.severity || "normal", opened_via: "cli" },
    })) as SupportTicket;
    if (options.json) {
      printJson(ticket);
      return 0;
    }
    log.ok(`Filed ticket ${ticket.id}`);
    log.info(deepLink(ticket.id));
    log.info("You'll be notified by email and on your next session when support replies.");
    return 0;
  } catch (error) {
    if (noteCloudOnlyOn404(error)) return 1;
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}

// --- support list -----------------------------------------------------------

export async function supportListCommand(options: {
  status?: string;
  limit?: number;
  json?: boolean;
}): Promise<number> {
  if (options.status !== undefined && !(VALID_STATUS as readonly string[]).includes(options.status)) {
    log.err(`--status must be one of: ${VALID_STATUS.join(", ")}.`);
    return 1;
  }
  try {
    const { client } = await createAuthenticatedClient();
    const result = (await client.requestJson("GET", "/support/tickets", {
      query: { status: options.status, limit: options.limit },
    })) as TicketListResponse;
    if (options.json) {
      printJson(result);
      return 0;
    }
    const tickets = result.tickets || [];
    if (!tickets.length) {
      log.info("No tickets.");
      return 0;
    }
    process.stdout.write(
      renderTable(
        tickets.map((t) => ({
          id: t.id,
          subject: t.subject.length > 48 ? `${t.subject.slice(0, 47)}…` : t.subject,
          status: t.status,
          severity: t.severity,
          unread: t.unread_for_opener ? "•" : "",
          updated: t.updated_at || "-",
        })),
        [
          { key: "id", label: "Ticket" },
          { key: "subject", label: "Subject" },
          { key: "status", label: "Status" },
          { key: "severity", label: "Severity" },
          { key: "unread", label: "Unread" },
          { key: "updated", label: "Updated" },
        ],
      ) + "\n",
    );
    if (result.unread_count) log.info(`${result.unread_count} ticket(s) with unread replies.`);
    return 0;
  } catch (error) {
    if (noteCloudOnlyOn404(error)) return 1;
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}

// --- support get ------------------------------------------------------------

export async function supportGetCommand(ticketId: string, options: { json?: boolean }): Promise<number> {
  try {
    const { client } = await createAuthenticatedClient();
    const ticket = (await client.requestJson(
      "GET",
      `/support/tickets/${encodeURIComponent(ticketId)}`,
    )) as SupportTicket;
    if (options.json) {
      printJson(ticket);
      return 0;
    }
    renderThread(ticket);
    return 0;
  } catch (error) {
    // A 404 on a single-ticket route is genuinely "ticket not found" (the route
    // exists), so don't shadow it with the cloud-only hint.
    if (error instanceof FloomApiError && error.status === 404) {
      log.err(`Ticket '${ticketId}' not found.`);
      log.info(`List tickets: ${getCommandName()} support list`);
      return 1;
    }
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}

// --- support reply ----------------------------------------------------------

export async function supportReplyCommand(
  ticketId: string,
  options: { body?: string; json?: boolean },
): Promise<number> {
  const body = (options.body || "").trim();
  if (!body) {
    log.err("--body is required.");
    return 1;
  }
  if (body.length > MAX_BODY_LEN) {
    log.err(`--body must be <= ${MAX_BODY_LEN} characters.`);
    return 1;
  }
  try {
    const { client } = await createAuthenticatedClient();
    const ticket = (await client.requestJson(
      "POST",
      `/support/tickets/${encodeURIComponent(ticketId)}/messages`,
      { body: { body } },
    )) as SupportTicket;
    if (options.json) {
      printJson(ticket);
      return 0;
    }
    log.ok(`Replied to ${ticketId}`);
    return 0;
  } catch (error) {
    if (error instanceof FloomApiError && error.status === 404) {
      log.err(`Ticket '${ticketId}' not found.`);
      return 1;
    }
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}

// --- support ack ------------------------------------------------------------

export async function supportAckCommand(ticketId: string, options: { json?: boolean }): Promise<number> {
  try {
    const { client } = await createAuthenticatedClient();
    const ticket = (await client.requestJson(
      "POST",
      `/support/tickets/${encodeURIComponent(ticketId)}/ack`,
    )) as SupportTicket;
    if (options.json) {
      printJson(ticket);
      return 0;
    }
    log.ok(`Cleared unread flag on ${ticketId}`);
    return 0;
  } catch (error) {
    if (error instanceof FloomApiError && error.status === 404) {
      log.err(`Ticket '${ticketId}' not found.`);
      return 1;
    }
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}

// --- feedback ---------------------------------------------------------------

// Locate the local session transcript to attach to `feedback`. Only the local
// CLI can read the on-disk transcript (the MCP server can't), which is why this
// lives here and not in the API. Resolution order: explicit path → env override
// → newest *.jsonl under ~/.claude/projects. Returns null when none is found.
async function findSessionTranscript(explicitPath?: string): Promise<string | null> {
  const direct = explicitPath || process.env.WORKEROS_SESSION_TRANSCRIPT || process.env.CLAUDE_SESSION_TRANSCRIPT;
  if (direct) {
    try {
      await stat(direct);
      return direct;
    } catch {
      return null;
    }
  }
  const root = join(homedir(), ".claude", "projects");
  const candidates: { path: string; mtime: number }[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const s = await stat(full);
          candidates.push({ path: full, mtime: s.mtimeMs });
        } catch {
          /* skip unreadable */
        }
      }
    }
  }
  await walk(root, 0);
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (b.mtime > a.mtime ? b : a)).path;
}

// Append the transcript tail to `message`, clamped so the whole body fits under
// MAX_BODY_LEN (the API rejects longer). The tail is the most recent and most
// relevant part of a session.
function composeFeedbackBody(message: string, transcript: string | null): string {
  if (!transcript) return message;
  const header = "\n\n--- Session transcript (most recent, truncated) ---\n";
  const budget = MAX_BODY_LEN - message.length - header.length;
  if (budget <= 200) return message; // no meaningful room left
  const tail = transcript.length > budget ? transcript.slice(transcript.length - budget) : transcript;
  return `${message}${header}${tail}`;
}

export async function feedbackCommand(options: {
  message?: string;
  severity?: string;
  // commander folds `--transcript <path>` and `--no-transcript` into one key:
  //   undefined/true → auto-locate, string → explicit path, false → skip.
  transcript?: string | boolean;
  json?: boolean;
}): Promise<number> {
  const message = (options.message || "").trim();
  if (!message) {
    log.err("--message is required.");
    return 1;
  }
  if (options.severity !== undefined && !validSeverity(options.severity)) {
    log.err(`--severity must be one of: ${VALID_SEVERITY.join(", ")}.`);
    return 1;
  }

  const explicitPath = typeof options.transcript === "string" ? options.transcript : undefined;
  let transcript: string | null = null;
  if (options.transcript !== false) {
    const path = await findSessionTranscript(explicitPath);
    if (path) {
      try {
        transcript = await readFile(path, "utf8");
      } catch {
        transcript = null;
      }
    } else if (explicitPath) {
      log.warn(`Transcript not found at ${explicitPath}; filing feedback without it.`);
    }
  }

  const subjectSource = message.split("\n")[0].trim() || "CLI feedback";
  const subject = subjectSource.length > MAX_SUBJECT_LEN
    ? subjectSource.slice(0, MAX_SUBJECT_LEN - 1) + "…"
    : subjectSource;
  const body = composeFeedbackBody(message, transcript);

  try {
    const { client } = await createAuthenticatedClient();
    const ticket = (await client.requestJson("POST", "/support/tickets", {
      body: { subject, body, severity: options.severity || "normal", opened_via: "cli" },
    })) as SupportTicket;
    if (options.json) {
      printJson(ticket);
      return 0;
    }
    log.ok(`Filed feedback ${ticket.id}`);
    if (transcript) log.step("Attached the local session transcript.");
    log.info(deepLink(ticket.id));
    log.info("You'll be notified by email and on your next session when support replies.");
    return 0;
  } catch (error) {
    if (noteCloudOnlyOn404(error)) return 1;
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}
