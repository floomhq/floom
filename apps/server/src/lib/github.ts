// Smart-feedback: GitHub issue filing.
//
// Owns the one-shot "file an issue against floomhq/floom with source/feedback
// + type/<bucket> labels" call. Wrapped in a helper so the feedback route
// stays free of octokit + repo-slug + env plumbing.
//
// Env:
//   - FEEDBACK_GITHUB_TOKEN : PAT with `repo` scope on floomhq/floom.
//   - FEEDBACK_GITHUB_REPO  : optional override in the form `owner/repo`.
//                             Defaults to `floomhq/floom`. Exposed so preview
//                             / staging deployments can file into a scratch
//                             repo instead of polluting prod triage.
//
// Intentionally uses @octokit/rest rather than raw fetch: the SDK handles
// retries, 429 back-off, and the error shape is typed for the route layer.

import { Octokit } from '@octokit/rest';
import type { FeedbackBucket } from './gemini.js';

export class GitHubIssueError extends Error {
  code:
    | 'github_config_missing'
    | 'github_repo_invalid'
    | 'github_api_error'
    | 'github_unknown';
  status: number | null;
  constructor(
    message: string,
    code: GitHubIssueError['code'],
    status: number | null = null,
  ) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

interface FileIssueArgs {
  title: string;
  body: string;
  bucket: FeedbackBucket;
}

interface FileIssueResult {
  url: string;
  number: number;
}

function parseRepo(): { owner: string; repo: string } {
  const raw = (process.env.FEEDBACK_GITHUB_REPO || 'floomhq/floom').trim();
  const [owner, repo] = raw.split('/');
  if (!owner || !repo) {
    throw new GitHubIssueError(
      `FEEDBACK_GITHUB_REPO must be in "owner/repo" form (got: ${raw})`,
      'github_repo_invalid',
    );
  }
  return { owner, repo };
}

/**
 * File a GitHub issue on the configured feedback repo. Labels are always
 * `source/feedback` + `type/<bucket>`; the caller picks the bucket.
 *
 * Throws `GitHubIssueError` with a `.code` the route can map to a clean
 * JSON response. Never logs the token.
 */
export async function fileGitHubIssue(args: FileIssueArgs): Promise<FileIssueResult> {
  const token = process.env.FEEDBACK_GITHUB_TOKEN;
  if (!token) {
    throw new GitHubIssueError(
      'FEEDBACK_GITHUB_TOKEN is not set on this server',
      'github_config_missing',
    );
  }

  const { owner, repo } = parseRepo();
  const octokit = new Octokit({ auth: token, userAgent: 'floom-feedback/1.0' });

  try {
    const res = await octokit.rest.issues.create({
      owner,
      repo,
      title: args.title,
      body: args.body,
      labels: ['source/feedback', `type/${args.bucket}`],
    });
    return { url: res.data.html_url, number: res.data.number };
  } catch (err) {
    const e = err as { status?: number; message?: string };
    const status = typeof e.status === 'number' ? e.status : null;
    const msg = e.message || 'GitHub issue creation failed';
    // Surface the upstream status so the route can decide (401/403 -> log
    // misconfig loudly; 5xx -> tell user to try again later). Intentionally
    // don't include the token or headers in the message.
    throw new GitHubIssueError(msg, 'github_api_error', status);
  }
}
