// Minimal GitHub issue filer for the Feedback button.
//
// Files an issue on floomhq/floom (or the repo named by
// FEEDBACK_GITHUB_REPO) when a user sends feedback, so the submission is
// triageable from one place and the user gets an issue number back to
// reference.
//
// Intentionally a raw fetch wrapper — a single POST call does not need
// Octokit as a dependency.
//
// Env:
//   FEEDBACK_GITHUB_TOKEN : PAT with `repo` scope (or a fine-grained token
//                           with "Issues: write" on the target repo).
//                           If unset, filing silently skips.
//   FEEDBACK_GITHUB_REPO  : owner/repo override. Defaults to
//                           floomhq/floom.

export interface FiledIssue {
  number: number;
  url: string;
}

export class FeedbackGitHubError extends Error {
  code: 'not_configured' | 'bad_repo_env' | 'api_error';
  status: number | null;
  constructor(
    message: string,
    code: FeedbackGitHubError['code'],
    status: number | null = null,
  ) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function parseRepoEnv(): { owner: string; repo: string } {
  const raw = (process.env.FEEDBACK_GITHUB_REPO || 'floomhq/floom').trim();
  const [owner, repo] = raw.split('/');
  if (!owner || !repo) {
    throw new FeedbackGitHubError(
      `FEEDBACK_GITHUB_REPO must be in "owner/repo" form (got: ${raw})`,
      'bad_repo_env',
    );
  }
  return { owner, repo };
}

export function isFeedbackGitHubConfigured(): boolean {
  return Boolean(process.env.FEEDBACK_GITHUB_TOKEN);
}

/**
 * File a GitHub issue for a Feedback button submission.
 *
 * The title is derived from the first meaningful line of the feedback text
 * (truncated to 80 chars). The body includes the raw text, the URL the
 * user was on, and the email if they left one.
 *
 * Labels applied: `source/feedback` (plus `area/frontend` if the URL
 * looks like a web route — purely a triage convenience).
 */
export async function fileFeedbackIssue(args: {
  text: string;
  email?: string | null;
  url?: string | null;
  reporter?: string | null;
}): Promise<FiledIssue> {
  const token = process.env.FEEDBACK_GITHUB_TOKEN;
  if (!token) {
    throw new FeedbackGitHubError(
      'FEEDBACK_GITHUB_TOKEN is not set on this server',
      'not_configured',
    );
  }

  const { owner, repo } = parseRepoEnv();

  const title = deriveTitle(args.text);
  const body = buildBody(args);

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'floom-feedback/1.0',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title,
      body,
      labels: ['source/feedback'],
    }),
  });

  if (!res.ok) {
    const snippet = await res.text().catch(() => '');
    throw new FeedbackGitHubError(
      `GitHub issue create failed (${res.status}): ${snippet.slice(0, 200)}`,
      'api_error',
      res.status,
    );
  }

  const json = (await res.json()) as { number: number; html_url: string };
  return { number: json.number, url: json.html_url };
}

function deriveTitle(text: string): string {
  const firstLine = text
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s.length > 0) || text.trim();
  const cleaned = firstLine.replace(/\s+/g, ' ').slice(0, 80);
  return cleaned || 'Feedback';
}

function buildBody(args: {
  text: string;
  email?: string | null;
  url?: string | null;
  reporter?: string | null;
}): string {
  const lines: string[] = [];
  lines.push('> Filed via the Floom in-app feedback button.');
  lines.push('');
  lines.push(args.text.trim());
  lines.push('');
  lines.push('---');
  if (args.url) lines.push(`Page: ${args.url}`);
  if (args.email) lines.push(`Reply-to: ${args.email}`);
  if (args.reporter) lines.push(`Reporter: ${args.reporter}`);
  lines.push(`Received: ${new Date().toISOString()}`);
  return lines.join('\n');
}
