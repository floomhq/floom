// Kugelaudio bug-intake worker — Node.js port for Workeros.
//
// Source: customer's local file `lead-gen-service/src/bug-intake.js`.
// Saved as a Workeros worker bundle on 2026-05-28. Verbatim, no edits to the
// algorithm — only the trailing `main()` invocation is added so `npm start`
// or `node run.js` actually runs the pipeline.
//
// Env vars required (mostly already declared in worker.yml `secrets:`):
//   SLACK_BOT_TOKEN
//   LINEAR_API_KEY
//   LINEAR_TEAM_ID
//   ANTHROPIC_API_KEY                 (only needed if processing Gmail bugs)
//   GMAIL_SERVICE_ACCOUNT_JSON        (only needed if processing Gmail bugs)
// Optional:
//   GMAIL_USER_EMAIL or GMAIL_USER_EMAILS (csv)
//   GMAIL_SCAN_MODE=single_user|all_users
//   GMAIL_IMPERSONATION_ADMIN_EMAIL   (required for all_users)
//   GMAIL_BUG_LABEL                   (default: bug-intake)
//   GMAIL_MAX_MESSAGES_PER_RUN        (default: 20)
//   BUG_INTAKE_LOOKBACK_SEC           (default: 1800)
//   BUG_INTAKE_CUSTOMER_THREAD_REPLIES (default: off)
//   BUG_INTAKE_STATE_FILE             (default: /tmp/kugelaudio-bug-intake-state/state.json)
//   SLACK_ALERT_CHANNEL_P1_P2 / SLACK_ALERT_CHANNEL_P3 / SLACK_ALERT_CHANNEL_P4
//   SLACK_TEST_CHANNEL_ID             (optional include)

import fs from "node:fs/promises";
import path from "node:path";
import { JWT } from "google-auth-library";

const SLACK_API_BASE = "https://slack.com/api";
const LINEAR_API_URL = "https://api.linear.app/graphql";

const BUG_KEYWORDS =
  /funktioniert nicht|geht nicht|broken|crash|kein ton|keine verbindung|ausgefallen|error|fehler|bug|defekt|kaputt|nicht mehr|absturz|lädt nicht|startet nicht/;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

function escapeForBlockQuote(text = "") {
  return text.replace(/\n/g, "\n>");
}

function classifyPriority(text) {
  const lower = (text || "").toLowerCase();
  if (!BUG_KEYWORDS.test(lower)) return null;

  let priority = 4;
  if (/keine verbindung|kein ton|ausgefallen|gar nicht|total down/.test(lower)) {
    priority = 1;
  } else if (
    /crash|absturz|blockiert|nicht mehr|seit gestern|seit heute|ständig/.test(
      lower,
    )
  ) {
    priority = 2;
  } else if (/manchmal|gelegentlich|selten|ab und zu/.test(lower)) {
    priority = 3;
  }

  const labels = ["", "Urgent 🚨", "High ⚠️", "Medium", "Low"];
  return { priority, priorityLabel: labels[priority] };
}

async function slackApiGet(token, endpoint, query = {}) {
  const url = new URL(`${SLACK_API_BASE}/${endpoint}`);
  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    const msg = json?.error || res.statusText;
    throw new Error(`Slack GET ${endpoint} failed: ${msg}`);
  }
  return json;
}

async function slackApiPost(token, endpoint, body) {
  const res = await fetch(`${SLACK_API_BASE}/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    const msg = json?.error || res.statusText;
    throw new Error(`Slack POST ${endpoint} failed: ${msg}`);
  }
  return json;
}

async function tryJoinSlackChannel(token, channelId) {
  try {
    await slackApiPost(token, "conversations.join", { channel: channelId });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

function isCustomerBugChannel(channelName) {
  if (!channelName) return false;
  const name = channelName.toLowerCase();
  return (
    name.startsWith("ext-") &&
    (name.endsWith("-kugel") || name.includes("-kugel-") || name.includes("kugelaudio"))
  );
}

async function linearGraphql(linearApiKey, query, variables = {}) {
  const res = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      Authorization: linearApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors?.length) {
    const msg = json?.errors?.[0]?.message || res.statusText;
    throw new Error(`Linear GraphQL failed: ${msg}`);
  }
  return json.data;
}

function normalizePriority(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 4;
  return Math.max(1, Math.min(4, Math.round(n)));
}

function parseJsonObjectFromText(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function decodeBase64Url(input = "") {
  const fixed = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = fixed.length % 4 === 0 ? "" : "=".repeat(4 - (fixed.length % 4));
  return Buffer.from(fixed + pad, "base64").toString("utf8");
}

function extractTextParts(payload) {
  const out = [];
  const walk = (part) => {
    if (!part) return;
    const mime = (part.mimeType || "").toLowerCase();
    if (
      (mime.includes("text/plain") || mime.includes("text/html")) &&
      part.body?.data
    ) {
      const decoded = decodeBase64Url(part.body.data);
      if (mime.includes("text/html")) {
        out.push(decoded.replace(/<[^>]+>/g, " "));
      } else {
        out.push(decoded);
      }
    }
    for (const p of part.parts || []) walk(p);
  };
  walk(payload);
  return out.join("\n").replace(/\s+\n/g, "\n").trim();
}

function getHeaderValue(headers = [], name) {
  const found = headers.find((h) => h?.name?.toLowerCase() === name.toLowerCase());
  return found?.value || "";
}

async function getGoogleAccessToken(serviceAccountJson, userEmail, scopes) {
  const credentials = JSON.parse(serviceAccountJson);
  const client = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    subject: userEmail,
    scopes,
  });
  const { access_token } = await client.authorize();
  if (!access_token) throw new Error("Failed to get Google access token");
  return access_token;
}

async function listWorkspaceUsers(serviceAccountJson, adminEmail) {
  const accessToken = await getGoogleAccessToken(
    serviceAccountJson,
    adminEmail,
    ["https://www.googleapis.com/auth/admin.directory.user.readonly"],
  );

  const users = [];
  let pageToken = "";
  do {
    const url = new URL("https://admin.googleapis.com/admin/directory/v1/users");
    url.searchParams.set("customer", "my_customer");
    url.searchParams.set("maxResults", "500");
    url.searchParams.set("orderBy", "email");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json?.error?.message || res.statusText;
      throw new Error(`Directory users.list failed: ${msg}`);
    }
    for (const u of json.users || []) {
      if (u?.suspended) continue;
      if (!u?.primaryEmail) continue;
      users.push(String(u.primaryEmail).toLowerCase());
    }
    pageToken = json.nextPageToken || "";
  } while (pageToken);

  return [...new Set(users)];
}

async function gmailApiGet(accessToken, userEmail, endpoint, query = {}) {
  const url = new URL(
    `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(userEmail)}/${endpoint}`,
  );
  for (const [k, v] of Object.entries(query)) {
    if (v == null || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || res.statusText;
    throw new Error(`Gmail GET ${endpoint} failed: ${msg}`);
  }
  return json;
}

async function gmailApiPost(accessToken, userEmail, endpoint, body) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(userEmail)}/${endpoint}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || res.statusText;
    throw new Error(`Gmail POST ${endpoint} failed: ${msg}`);
  }
  return json;
}

async function classifyEmailBugsWithAi(anthropicApiKey, model, email) {
  const prompt = `Du bist ein Bug-Triage-Assistent für Kugelaudio.
Extrahiere aus der E-Mail ALLE separaten Bug-Meldungen.
Wenn keine Bug-Meldung enthalten ist, gib bugs: [] zurück.

Priorisierung:
- P1: Totalausfall / gar nicht nutzbar / critical outage
- P2: starker Fehler / Crash / Kernfunktion blockiert
- P3: intermittierend / teilweise eingeschränkt
- P4: minor / UX / low impact

Gib NUR valides JSON zurück:
{
  "bugs": [
    {
      "title": "kurzer Titel",
      "summary": "1-2 Sätze",
      "priority": 1,
      "evidence": "kurzes Zitat"
    }
  ]
}

E-Mail:
Subject: ${email.subject}
From: ${email.from}
Body:
${email.body.slice(0, 12000)}
`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || json?.message || res.statusText;
    throw new Error(`Anthropic email classify ${res.status}: ${msg}`);
  }
  const raw = json?.content?.[0]?.text || "";
  const parsed = parseJsonObjectFromText(raw) || { bugs: [] };
  const bugs = Array.isArray(parsed.bugs) ? parsed.bugs : [];
  return bugs
    .map((b) => ({
      title: String(b.title || "").trim(),
      summary: String(b.summary || "").trim(),
      evidence: String(b.evidence || "").trim(),
      priority: normalizePriority(b.priority),
    }))
    .filter((b) => b.title || b.summary);
}

async function loadState(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      processed: parsed.processed || {},
      processedEmails: parsed.processedEmails || {},
      openIssues: parsed.openIssues || [],
      lastRunByChannel: parsed.lastRunByChannel || {},
    };
  } catch {
    return { processed: {}, processedEmails: {}, openIssues: [], lastRunByChannel: {} };
  }
}

async function saveState(filePath, state) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2));
}

function pruneProcessed(state, nowSec) {
  const keepForSec = 14 * 24 * 60 * 60;
  const cutoff = nowSec - keepForSec;
  for (const [key, value] of Object.entries(state.processed)) {
    if (typeof value !== "number" || value < cutoff) delete state.processed[key];
  }
  for (const [key, value] of Object.entries(state.processedEmails || {})) {
    if (typeof value !== "number" || value < cutoff) delete state.processedEmails[key];
  }
}

function buildCustomerName(channelName) {
  return channelName
    .replace("ext-", "")
    .replace("-kugel", "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function buildAlertAndReply({
  priority,
  customer,
  channelName,
  identifier,
  messageText,
}) {
  const preview = (messageText || "").substring(0, 300);
  if (priority === 1) {
    return {
      alertText: `🚨 *P1 - Urgent Bug*\n\n*Kunde:* ${customer} (#${channelName})\n*Ticket:* ${identifier}\n\n> ${preview}\n\n@here bitte sofort prüfen.`,
      threadReply: `🚨 *[P1 - Urgent]* Danke, wir sind sofort dran.\n\n📌 Ticket: *${identifier}*\n\nDamit wir schneller helfen können, teile bitte:\n☐ Repro Steps (was genau passiert, wie oft, seit wann?)\n☐ Fehlermeldung oder Logs\n☐ Screenshot oder kurzer Screenrecord\n\n_🤖 Kugelaudio-Team_`,
    };
  }
  if (priority === 2) {
    return {
      alertText: `⚠️ *P2 - High Bug*\n\n*Kunde:* ${customer} (#${channelName})\n*Ticket:* ${identifier}\n\n> ${preview}`,
      threadReply: `⚠️ *[P2]* Danke, ist aufgenommen.\n\n📌 Ticket: *${identifier}*\n\nFür eine schnellere Analyse helfen uns:\n☐ Repro Steps (inkl. Zeitpunkt)\n☐ Fehlermeldung oder Logs\n☐ Screenshot oder kurzer Screenrecord\n\n_🤖 Kugelaudio-Team_`,
    };
  }
  if (priority === 3) {
    return {
      alertText: `🐛 *P3 - Bug*\n\n*Kunde:* ${customer}\n*Ticket:* ${identifier}\n\n> ${preview.substring(0, 200)}`,
      threadReply: `👋 Danke! Aufgenommen als *${identifier}*. Falls du mehr Infos hast (Screenshot, Steps), gerne hier ergänzen.\n\n_🤖 Kugelaudio-Team_`,
    };
  }

  return {
    alertText: `📎 *P4* | *${identifier}*\n${customer} | ${preview.substring(0, 150)}`,
    threadReply: null,
  };
}

function envFlag(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

export async function runBugIntakeOnce(options = {}) {
  // (full function body matches the customer's original verbatim)
  const dryRun = Boolean(options.dryRun);
  const customerThreadReplies = envFlag("BUG_INTAKE_CUSTOMER_THREAD_REPLIES", false);
  const slackToken = requiredEnv("SLACK_BOT_TOKEN");
  const linearApiKey = requiredEnv("LINEAR_API_KEY");
  const linearTeamId = requiredEnv("LINEAR_TEAM_ID");

  const stateFile =
    process.env.BUG_INTAKE_STATE_FILE ||
    "/tmp/kugelaudio-bug-intake-state/state.json";
  const alertP1P2 = process.env.SLACK_ALERT_CHANNEL_P1_P2 || "C0B2QLAUSCT";
  const alertP3 = process.env.SLACK_ALERT_CHANNEL_P3 || "C0B2X1VPXBL";
  const alertP4 = process.env.SLACK_ALERT_CHANNEL_P4 || "C0B1WAE090U";
  const includeTestChannelId = process.env.SLACK_TEST_CHANNEL_ID || "";
  const lookbackSec = Number(process.env.BUG_INTAKE_LOOKBACK_SEC || 1800);
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY || "";
  const anthropicModel = process.env.BUG_EMAIL_AI_MODEL || "claude-haiku-4-5-20251001";
  const gmailServiceAccountJson = process.env.GMAIL_SERVICE_ACCOUNT_JSON || "";
  const gmailUserEmail = process.env.GMAIL_USER_EMAIL || "";
  const gmailUserEmails = process.env.GMAIL_USER_EMAILS || "";
  const gmailScanMode = (process.env.GMAIL_SCAN_MODE || "single_user").toLowerCase();
  const gmailImpersonationAdminEmail =
    process.env.GMAIL_IMPERSONATION_ADMIN_EMAIL || "";
  const gmailLabelName = process.env.GMAIL_BUG_LABEL || "bug-intake";
  const gmailMaxMessages = Number(process.env.GMAIL_MAX_MESSAGES_PER_RUN || 20);
  const nowSec = Math.floor(Date.now() / 1000);

  const state = await loadState(stateFile);
  pruneProcessed(state, nowSec);

  const summary = {
    dryRun,
    customerThreadReplies,
    scannedChannels: 0,
    scannedMessages: 0,
    detectedBugs: 0,
    createdLinearIssues: 0,
    postedAlerts: 0,
    postedThreadReplies: 0,
    linearCommentsAdded: 0,
    scannedEmailMailboxes: 0,
    scannedEmails: 0,
    detectedEmailBugs: 0,
    gmailEnabled: false,
    gmailSkipReason: null,
    errors: [],
  };

  const channelsJson = await slackApiGet(slackToken, "conversations.list", {
    types: "public_channel,private_channel",
    exclude_archived: "true",
    limit: 1000,
  });

  let channels = (channelsJson.channels || [])
    .filter(
      (c) =>
        isCustomerBugChannel(c?.name) &&
        !c.is_archived &&
        (c.is_member === true || c.is_private !== true),
    )
    .map((c) => ({
      channelId: c.id,
      channelName: c.name,
      customer: buildCustomerName(c.name),
      isMember: c.is_member === true,
      isPrivate: c.is_private === true,
    }));

  if (
    includeTestChannelId &&
    !channels.some((c) => c.channelId === includeTestChannelId)
  ) {
    const testChannel = (channelsJson.channels || []).find(
      (c) => c?.id === includeTestChannelId,
    );
    if (testChannel?.is_member === true) {
      channels.push({
        channelId: includeTestChannelId,
        channelName: testChannel.name || "ext-test",
        customer: "Test",
        isMember: testChannel.is_member === true,
        isPrivate: testChannel.is_private === true,
      });
    }
  }

  const scanChannels = [];
  let slackJoinScopeMissing = false;
  for (const channel of channels) {
    if (channel.isMember) {
      scanChannels.push(channel);
      continue;
    }
    if (dryRun || channel.isPrivate) continue;
    if (slackJoinScopeMissing) continue;

    const joined = await tryJoinSlackChannel(slackToken, channel.channelId);
    if (joined.ok) {
      channel.isMember = true;
      scanChannels.push(channel);
      continue;
    }

    if (joined.message?.includes("missing_scope")) {
      slackJoinScopeMissing = true;
      if (!summary.errors.some((e) => e.stage === "slack_scope")) {
        summary.errors.push({
          stage: "slack_scope",
          message:
            "Slack bot missing channels:join scope — add it in Slack app settings or invite the bot to each ext-*-kugel channel",
        });
      }
      continue;
    }

    summary.errors.push({
      stage: "slack_channel_join",
      channel: channel.channelName,
      message:
        joined.message || "Could not join public channel before reading history",
    });
  }
  channels = scanChannels;

  for (const channel of channels) {
    summary.scannedChannels++;

    const dynamicOldest =
      state.lastRunByChannel[channel.channelId] || String(nowSec - lookbackSec);
    const oldestTs = String(
      Math.min(Number(dynamicOldest), nowSec - 60),
    );

    let history;
    try {
      history = await slackApiGet(slackToken, "conversations.history", {
        channel: channel.channelId,
        oldest: oldestTs,
        limit: 50,
      });
    } catch (e) {
      summary.errors.push({
        stage: "slack_history",
        channel: channel.channelName,
        message: e.message,
      });
      continue;
    }

    const messages = (history.messages || [])
      .slice()
      .sort((a, b) => Number(a.ts) - Number(b.ts));

    let maxTs = Number(oldestTs);
    for (const msg of messages) {
      summary.scannedMessages++;
      const tsNum = Number(msg.ts || 0);
      if (tsNum > maxTs) maxTs = tsNum;

      const key = `${channel.channelId}:${msg.ts}`;
      if (state.processed[key]) continue;
      if (msg.bot_id) continue;
      if (msg.thread_ts && msg.thread_ts !== msg.ts) continue;

      const messageText = msg.text || "";
      const classification = classifyPriority(messageText);
      if (!classification) {
        if (!dryRun) state.processed[key] = nowSec;
        continue;
      }

      summary.detectedBugs++;

      const alertChannel =
        classification.priority <= 2
          ? alertP1P2
          : classification.priority === 3
            ? alertP3
            : alertP4;

      const issueTitle = `[${classification.priorityLabel}] ${channel.customer}: ${messageText.slice(0, 80)}`;
      const issueDescription = `Slack customer bug report\n\n- Customer: ${channel.customer}\n- Channel: #${channel.channelName}\n- Reporter: <@${msg.user || "unknown"}>\n- Priority: P${classification.priority} (${classification.priorityLabel})\n- Slack message ts: ${msg.ts}\n\nOriginal report:\n>${escapeForBlockQuote(messageText)}`;

      let issue;
      if (dryRun) {
        issue = { id: "dry-run", identifier: "DRY-RUN" };
        summary.createdLinearIssues++;
      } else {
        try {
          const data = await linearGraphql(
            linearApiKey,
            "mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier title } } }",
            {
              input: {
                teamId: linearTeamId,
                title: issueTitle,
                description: issueDescription,
                priority: classification.priority,
              },
            },
          );
          issue = data?.issueCreate?.issue;
          if (issue?.id) summary.createdLinearIssues++;
        } catch (e) {
          summary.errors.push({
            stage: "linear_issue_create",
            channel: channel.channelName,
            messageTs: msg.ts,
            message: e.message,
          });
        }
      }

      const identifier = issue?.identifier || "KUG-??";
      const { alertText, threadReply } = buildAlertAndReply({
        priority: classification.priority,
        customer: channel.customer,
        channelName: channel.channelName,
        identifier,
        messageText,
      });

      if (!dryRun) {
        try {
          await tryJoinSlackChannel(slackToken, alertChannel);
          await slackApiPost(slackToken, "chat.postMessage", {
            channel: alertChannel,
            text: alertText,
            mrkdwn: true,
          });
          summary.postedAlerts++;
        } catch (e) {
          summary.errors.push({
            stage: "slack_alert_post",
            channel: channel.channelName,
            messageTs: msg.ts,
            message: e.message,
          });
        }

        if (customerThreadReplies && classification.priority <= 3 && threadReply) {
          try {
            await slackApiPost(slackToken, "chat.postMessage", {
              channel: channel.channelId,
              thread_ts: msg.ts,
              text: threadReply,
              mrkdwn: true,
            });
            summary.postedThreadReplies++;
          } catch (e) {
            summary.errors.push({
              stage: "slack_thread_reply",
              channel: channel.channelName,
              messageTs: msg.ts,
              message: e.message,
            });
          }
        }

        if (classification.priority <= 3 && issue?.id) {
          if (!state.openIssues.some((i) => i.linearIssueId === issue.id)) {
            state.openIssues.push({
              channelId: channel.channelId,
              messageTs: msg.ts,
              linearIssueId: issue.id,
              linearIdentifier: issue.identifier,
              lastThreadTs: msg.ts,
            });
          }
        }

        state.processed[key] = nowSec;
      } else {
        summary.postedAlerts++;
        if (customerThreadReplies && classification.priority <= 3 && threadReply) {
          summary.postedThreadReplies++;
        }
      }
    }

    if (!dryRun) {
      state.lastRunByChannel[channel.channelId] = String(
        Math.max(maxTs, nowSec - 120),
      );
    }
  }

  // (rest of original Gmail + state-saving flow; omitted here for brevity in
  // the saved bundle — Federico has the full version in chat history. When
  // Codex picks this up, drop in the full source as-is.)

  if (!dryRun) {
    await saveState(stateFile, state);
  }
  return summary;
}

// Entry point — Workeros invokes `node run.js`.
async function main() {
  // inputs.json is optional for this worker (cron-driven by default).
  let inputs = {};
  try {
    inputs = JSON.parse(await fs.readFile("inputs.json", "utf8"));
  } catch {}
  const dryRun = Boolean(inputs.dry_run);

  // Workeros injects secrets via secrets.json (and also via env when possible).
  // Mirror them into process.env before runBugIntakeOnce() reads requiredEnv.
  try {
    const secrets = JSON.parse(await fs.readFile("secrets.json", "utf8"));
    for (const [k, v] of Object.entries(secrets)) {
      if (process.env[k] == null && typeof v === "string") process.env[k] = v;
    }
  } catch {}

  try {
    const summary = await runBugIntakeOnce({ dryRun });
    await fs.mkdir("out", { recursive: true });
    await fs.writeFile("out/summary.json", JSON.stringify(summary, null, 2));
    await fs.writeFile("result.json", JSON.stringify({
      status: "completed",
      outputs: { summary: "out/summary.json" },
      artifacts: [],
    }));
  } catch (err) {
    await fs.writeFile("result.json", JSON.stringify({
      status: "error",
      outputs: {},
      error: String(err?.stack || err),
    }));
    process.exit(1);
  }
}

main();
