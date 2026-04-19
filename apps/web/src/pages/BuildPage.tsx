// /build — creator composer. Rebuilt 2026-04-17 to match wireframes.floom.dev
// v11 Screen 5. Multi-ramp entry:
//   1. GitHub import (PRIMARY, full width, functional — transforms repo URL
//      to raw openapi.yaml|json on the fly before calling the detect API).
//   2. OpenAPI URL paste (fallback, functional — the previous behavior).
//   3. Describe it (coming soon — AI generation is deferred per
//      project_floom_positioning.md).
//   4. Connect a tool (coming soon — deferred post-launch).
//   5. Docker image (coming soon — registry pulling ships after v1).
//
// Once a spec is detected the existing review/publish UI runs unchanged.

import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { PageShell } from '../components/PageShell';
import { CustomRendererPanel } from '../components/CustomRendererPanel';
import { useSession } from '../hooks/useSession';
import * as api from '../api/client';
import type { DetectedApp } from '../lib/types';

type Step = 'ramp' | 'review' | 'publishing' | 'done';

type GithubDetect = { attemptedUrls: string[] } | null;

// localStorage key for persisting a pending detection across the
// signup redirect so anonymous visitors don't lose their work. Cleared
// once the publish succeeds or the user manually goes back to ramp.
const PENDING_KEY = 'floom:pending-publish';

type PendingPublish = {
  detected: DetectedApp;
  name: string;
  slug: string;
  description: string;
  category: string;
  /** Who can see / run the app in the directory */
  visibility: 'public' | 'private' | 'auth-required';
  source: 'github' | 'openapi';
};

interface BuildPageProps {
  /** Wrapper component used for the outer layout. Defaults to PageShell
   *  (store surface). Studio wraps with StudioLayout. */
  layout?: React.ComponentType<{ children: React.ReactNode; title?: string }>;
  /** Where the "Back" breadcrumb links to. Defaults to /creator (store).
   *  Studio passes /studio. */
  backHref?: string;
  /** Redirect target after publish — Studio sends to /studio/:slug. */
  postPublishHref?: (slug: string) => string;
}

export function BuildPage({
  layout: Layout = PageShell,
  backHref = '/creator',
  postPublishHref,
}: BuildPageProps = {}) {
  const [searchParams] = useSearchParams();
  const editSlug = searchParams.get('edit');
  // v15 landing hands off the pasted OpenAPI URL via /build?openapi=<url>.
  // Pre-populate the OpenAPI ramp input so the user lands mid-flow.
  const prefilledOpenapi = searchParams.get('openapi') ?? '';
  const navigate = useNavigate();
  const { isAuthenticated } = useSession();
  const [signupPrompt, setSignupPrompt] = useState(false);

  // Inputs shared across ramps
  const [githubUrl, setGithubUrl] = useState('');
  const [openapiUrl, setOpenapiUrl] = useState(prefilledOpenapi);

  // Which ramp submitted last — controls the review heading
  const [source, setSource] = useState<'github' | 'openapi' | null>(null);

  // Detection result
  const [detected, setDetected] = useState<DetectedApp | null>(null);
  const [githubAttempts, setGithubAttempts] = useState<GithubDetect>(null);

  // State machine
  const [step, setStep] = useState<Step>('ramp');
  const [error, setError] = useState<string | null>(null);
  const [githubError, setGithubError] = useState<'private' | 'no-openapi' | 'unreachable' | null>(
    null,
  );

  // Editable metadata (populated after detect)
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  // Issue #129 (2026-04-19): default to Public so the post-publish "share
  // the link" copy matches reality. Creators can still pick Private on the
  // Review step, and can flip it later from /studio/:slug. The old default
  // ('private') contradicted the success banner's "anyone with the link can
  // run this" language.
  const [visibility, setVisibility] = useState<'public' | 'private' | 'auth-required'>(
    'public',
  );

  // Coming-soon state. Round 2 polish: describe/connect ramps removed
  // from the ramp page, so only docker remains as a coming-soon modal
  // target.
  const [comingSoon, setComingSoon] = useState<'docker' | null>(null);

  // Pre-fill if we got here via /build?edit=slug
  useEffect(() => {
    if (!editSlug) return;
    api
      .getApp(editSlug)
      .then((existing) => {
        if (existing) {
          setName(existing.name);
          setSlug(existing.slug);
          setDescription(existing.description);
          setCategory(existing.category || '');
          setStep('ramp');
        }
      })
      .catch(() => {
        /* ignore — show the ramp step */
      });
  }, [editSlug]);

  // Restore a pending detection after signup redirect. Anonymous users can
  // detect + review a spec, then get prompted to sign up when they click
  // Publish — on return, we hydrate the review step from localStorage so
  // they just click Publish again.
  useEffect(() => {
    if (editSlug) return;
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(PENDING_KEY) : null;
    if (!raw) return;
    try {
      const p = JSON.parse(raw) as PendingPublish;
      setDetected(p.detected);
      setName(p.name);
      setSlug(p.slug);
      setDescription(p.description);
      setCategory(p.category || '');
      setVisibility(p.visibility || 'public');
      setSource(p.source);
      setStep('review');
    } catch {
      window.localStorage.removeItem(PENDING_KEY);
    }
  }, [editSlug]);

  /** Transforms a GitHub repo URL into candidate raw OpenAPI URLs. */
  function githubCandidates(raw: string): string[] {
    const m = raw.trim().match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/i);
    if (!m) return [];
    const [, owner, repo] = m;
    const bases = [
      `https://raw.githubusercontent.com/${owner}/${repo}/main`,
      `https://raw.githubusercontent.com/${owner}/${repo}/master`,
    ];
    const paths = ['openapi.yaml', 'openapi.yml', 'openapi.json', 'docs/openapi.yaml', 'api/openapi.yaml'];
    const urls: string[] = [];
    for (const b of bases) for (const p of paths) urls.push(`${b}/${p}`);
    return urls;
  }

  async function handleGithubDetect(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setGithubError(null);
    const candidates = githubCandidates(githubUrl);
    if (candidates.length === 0) {
      setGithubError('unreachable');
      return;
    }
    setGithubAttempts({ attemptedUrls: candidates });
    for (const candidate of candidates) {
      try {
        const result = await api.detectApp(candidate);
        setDetected(result);
        setName(result.name);
        setSlug(result.slug);
        setDescription(result.description);
        setSource('github');
        setStep('review');
        return;
      } catch {
        // try next
      }
    }
    // All failed. Distinguish private-repo (403/404 on all raw urls) from
    // missing OpenAPI. Without a HEAD request we can't tell reliably, so
    // show the no-openapi hint by default.
    setGithubError('no-openapi');
  }

  async function handleOpenapiDetect(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const result = await api.detectApp(openapiUrl, name || undefined, slug || undefined);
      setDetected(result);
      setName(result.name);
      setSlug(result.slug);
      setDescription(result.description);
      setSource('openapi');
      setStep('review');
    } catch (err) {
      setError((err as Error).message || 'Could not fetch that spec.');
    }
  }

  async function handlePublish() {
    if (!detected) return;
    // Anonymous users get prompted to sign up before publishing. We
    // persist the review state so they can resume right after auth.
    if (!isAuthenticated) {
      const pending: PendingPublish = {
        detected,
        name,
        slug,
        description,
        category,
        visibility,
        source: source ?? 'openapi',
      };
      try {
        window.localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
      } catch {
        /* storage can fail in private mode; fall back to redirect without resume */
      }
      setSignupPrompt(true);
      return;
    }
    setStep('publishing');
    setError(null);
    try {
      await api.ingestApp({
        openapi_url: detected.openapi_spec_url,
        name,
        slug,
        description,
        category: category || undefined,
        visibility,
      });
      try {
        window.localStorage.removeItem(PENDING_KEY);
      } catch {
        /* ignore */
      }
      setStep('done');
      // Redirect removed on 2026-04-17: give creators a chance to upload
      // a custom renderer (W2.2) before heading to the permalink. The
      // "Open app" button on the done step handles navigation manually.
    } catch (err) {
      setStep('review');
      setError((err as Error).message || 'Publish failed.');
    }
  }

  return (
    <Layout title="Publish an app | Floom">
      <div data-testid="build-page" style={{ maxWidth: 1040, margin: '0 auto' }}>
        {/* Header */}
        <div style={{ marginBottom: 32 }}>
          <Link
            to={backHref}
            style={{
              fontSize: 13,
              color: 'var(--muted)',
              textDecoration: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              marginBottom: 12,
            }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path
                d="M8 2L4 6l4 4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Creator dashboard
          </Link>
          <h1
            style={{
              fontSize: 32,
              fontWeight: 700,
              margin: '0 0 8px',
              color: 'var(--ink)',
              letterSpacing: '-0.02em',
            }}
          >
            {editSlug ? `Edit ${editSlug}` : 'Publish a Floom app'}
          </h1>
          <p
            style={{
              fontSize: 15,
              color: 'var(--muted)',
              margin: 0,
              maxWidth: 620,
              lineHeight: 1.55,
            }}
          >
            Start from an idea or a tool you already use. Floom wraps it in auth, access control,
            logs, versions, and a store listing from day one.
          </p>
        </div>

        {/* Step indicator (only visible in review/publish flow) */}
        {step !== 'ramp' && (
          <div
            style={{
              display: 'flex',
              gap: 8,
              marginBottom: 28,
              fontSize: 12,
              color: 'var(--muted)',
              flexWrap: 'wrap',
            }}
          >
            <StepBadge active={false} done={true} label="1. Detect spec" />
            <StepBadge
              active={step === 'review'}
              done={step === 'publishing' || step === 'done'}
              label="2. Review"
            />
            <StepBadge active={step === 'publishing'} done={step === 'done'} label="3. Publish" />
          </div>
        )}

        {/* Ramp selection (initial state) */}
        {step === 'ramp' && (
          <div data-testid="build-step-ramp">
            {/* RAMP 1 — GitHub import (PRIMARY) */}
            <form
              onSubmit={handleGithubDetect}
              data-testid="ramp-github"
              style={{
                background: 'var(--card)',
                border: '1px solid var(--accent-border, var(--line))',
                borderRadius: 16,
                padding: 24,
                marginBottom: 20,
                boxShadow: '0 10px 30px rgba(5,150,105,0.08)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  marginBottom: 14,
                  flexWrap: 'wrap',
                }}
              >
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 10,
                    background: 'var(--accent-soft)',
                    color: 'var(--accent)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <GithubIcon size={18} />
                </div>
                <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--ink)' }}>
                  Import from GitHub
                </div>
                <span
                  style={{
                    padding: '3px 10px',
                    borderRadius: 999,
                    background: 'var(--accent-soft)',
                    color: 'var(--accent)',
                    fontSize: 11,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                  }}
                >
                  Recommended
                </span>
                <span
                  style={{
                    marginLeft: 'auto',
                    padding: '3px 10px',
                    borderRadius: 999,
                    background: 'var(--bg)',
                    border: '1px solid var(--line)',
                    color: 'var(--muted)',
                    fontSize: 11,
                    fontWeight: 500,
                  }}
                >
                  30 seconds
                </span>
              </div>
              <p
                style={{
                  fontSize: 13,
                  color: 'var(--muted)',
                  margin: '0 0 18px',
                  lineHeight: 1.55,
                  maxWidth: 620,
                }}
              >
                Paste your repo URL. Floom looks for an OpenAPI spec at the root, wraps it with
                auth and logs, and ships a live MCP server.
              </p>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '4px 6px 4px 12px',
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                  background: 'var(--bg)',
                  marginBottom: 14,
                  flexWrap: 'nowrap',
                }}
              >
                <GithubIcon size={14} />
                <input
                  type="url"
                  value={githubUrl}
                  onChange={(e) => setGithubUrl(e.target.value)}
                  required
                  placeholder="https://github.com/you/your-repo"
                  data-testid="build-github-url"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: '10px 4px',
                    border: 'none',
                    background: 'transparent',
                    fontSize: 14,
                    fontFamily: 'JetBrains Mono, monospace',
                    color: 'var(--ink)',
                    outline: 'none',
                  }}
                />
                <button
                  type="submit"
                  data-testid="build-github-detect"
                  disabled={!githubUrl}
                  style={{
                    padding: '8px 14px',
                    background: 'var(--accent)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 8,
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: githubUrl ? 'pointer' : 'not-allowed',
                    opacity: githubUrl ? 1 : 0.55,
                    fontFamily: 'inherit',
                    flexShrink: 0,
                  }}
                >
                  Detect
                </button>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                Works with public repos out of the box. Private repo support ships with the GitHub
                App.
              </div>

              {/* Error states */}
              {githubError && (
                <div
                  data-testid={`github-error-${githubError}`}
                  style={{
                    marginTop: 16,
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                    gap: 12,
                  }}
                >
                  {githubError === 'no-openapi' && (
                    <ErrorCard
                      severity="red"
                      title="We couldn't find an OpenAPI spec"
                      copy="Floom v1 supports OpenAPI apps. Add openapi.yaml (or .json) to your repo root, or use the OpenAPI URL ramp below. Docker images and agent wrappers are on the roadmap."
                    />
                  )}
                  {githubError === 'private' && (
                    <ErrorCard
                      severity="amber"
                      title="This repo looks private"
                      copy="We can't reach it without authorization. Make the repo public, or paste the raw OpenAPI URL below."
                    />
                  )}
                  {githubError === 'unreachable' && (
                    <ErrorCard
                      severity="amber"
                      title="That doesn't look like a GitHub URL"
                      copy="Paste a full URL like https://github.com/owner/repo."
                    />
                  )}
                  {githubAttempts && githubAttempts.attemptedUrls.length > 0 && (
                    <details
                      style={{
                        background: 'var(--bg)',
                        border: '1px solid var(--line)',
                        borderRadius: 10,
                        padding: '10px 12px',
                        fontSize: 12,
                      }}
                    >
                      <summary style={{ cursor: 'pointer', color: 'var(--muted)', fontWeight: 500 }}>
                        Paths we tried ({githubAttempts.attemptedUrls.length})
                      </summary>
                      <ul
                        style={{
                          margin: '8px 0 0',
                          padding: '0 0 0 16px',
                          color: 'var(--muted)',
                          fontSize: 11,
                          fontFamily: 'JetBrains Mono, monospace',
                          lineHeight: 1.7,
                        }}
                      >
                        {githubAttempts.attemptedUrls.map((u) => (
                          <li key={u}>{u.replace('https://raw.githubusercontent.com/', '')}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              )}
            </form>

            {/* RAMP 2 — OpenAPI URL paste (FUNCTIONAL). Round 2 polish
                (UI audit v2): previously hidden behind a "More ways to
                add an app (coming soon)" accordion that made the
                functional OpenAPI ramp invisible above the fold. Promote
                it directly under the primary GitHub card so both working
                ramps are side-by-side and no "coming soon" copy appears
                above the first real input. */}
            <form
              onSubmit={handleOpenapiDetect}
              data-testid="ramp-openapi"
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 14,
                padding: 22,
                marginTop: 16,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    background: 'var(--bg)',
                    border: '1px solid var(--line)',
                    color: 'var(--muted)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <FileIcon />
                </div>
                <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)' }}>
                  Paste an OpenAPI URL
                </div>
              </div>
              <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 12px', lineHeight: 1.55 }}>
                Direct link to openapi.json or openapi.yaml. 3.0 and 3.1 supported.
              </p>
              <input
                type="url"
                value={openapiUrl}
                onChange={(e) => setOpenapiUrl(e.target.value)}
                required
                placeholder="https://api.example.com/openapi.json"
                data-testid="build-url-input"
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  background: 'var(--bg)',
                  fontSize: 14,
                  color: 'var(--ink)',
                  fontFamily: 'JetBrains Mono, monospace',
                  marginBottom: 12,
                  boxSizing: 'border-box',
                }}
              />
              {error && (
                <p
                  data-testid="build-error"
                  style={{
                    margin: '0 0 12px',
                    padding: '10px 14px',
                    background: '#fdecea',
                    border: '1px solid #f4b7b1',
                    color: '#c2321f',
                    borderRadius: 8,
                    fontSize: 13,
                  }}
                >
                  {error}
                </p>
              )}
              <button
                type="submit"
                data-testid="build-detect"
                disabled={!openapiUrl}
                style={primaryButton(!openapiUrl)}
              >
                Detect spec
              </button>
            </form>

            {/* More-ways footer — single collapsed disclosure after the
                functional ramps. Round 2 polish (UI audit v2): Docker
                + other non-shipping ramps must not be visible above the
                fold at 1440x900, so they live inside a closed <details>
                the creator can expand. This keeps "coming soon" copy
                off the initial view while leaving the Docker ramp
                discoverable. */}
            <details
              data-testid="build-more-ways-footer"
              style={{
                marginTop: 24,
                border: '1px solid var(--line)',
                borderRadius: 12,
                background: 'var(--bg)',
                padding: '0 4px',
              }}
            >
              <summary
                data-testid="build-more-ways-summary"
                style={{
                  cursor: 'pointer',
                  padding: '12px 14px',
                  fontSize: 13,
                  fontWeight: 500,
                  color: 'var(--muted)',
                  userSelect: 'none',
                }}
              >
                More ways to add an app
              </summary>
              <div style={{ padding: '4px 12px 16px' }}>
                <RampCard
                  icon={<DockerIcon />}
                  title="Import from a Docker image"
                  badge="Coming soon"
                  desc="Paste an image and the OpenAPI path. Floom pulls, scans, and deploys behind the production layer."
                  testId="ramp-docker"
                  onClick={() => setComingSoon('docker')}
                  compact
                >
                  <div
                    style={{
                      display: 'flex',
                      gap: 8,
                      opacity: 0.85,
                      flexWrap: 'wrap',
                    }}
                  >
                    <input
                      disabled
                      placeholder="ghcr.io/you/app:latest"
                      style={{
                        flex: '2 1 220px',
                        padding: '10px 12px',
                        border: '1px solid var(--line)',
                        borderRadius: 8,
                        background: 'var(--bg)',
                        fontSize: 13,
                        color: 'var(--muted)',
                        fontFamily: 'JetBrains Mono, monospace',
                        boxSizing: 'border-box',
                      }}
                    />
                    <input
                      disabled
                      placeholder="/openapi.yaml"
                      style={{
                        flex: '1 1 140px',
                        padding: '10px 12px',
                        border: '1px solid var(--line)',
                        borderRadius: 8,
                        background: 'var(--bg)',
                        fontSize: 13,
                        color: 'var(--muted)',
                        fontFamily: 'JetBrains Mono, monospace',
                        boxSizing: 'border-box',
                      }}
                    />
                  </div>
                </RampCard>
                <p
                  style={{
                    marginTop: 12,
                    marginBottom: 0,
                    fontSize: 12.5,
                    color: 'var(--muted)',
                    lineHeight: 1.55,
                  }}
                >
                  Describe-it and tool connectors ship with v1.1.{' '}
                  <a
                    href="/protocol"
                    style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 500 }}
                  >
                    Post to the roadmap &rarr;
                  </a>
                </p>
              </div>
            </details>
          </div>
        )}

        {/* Review step */}
        {step === 'review' && detected && (
          <div data-testid="build-step-review">
            <div
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 12,
                padding: 20,
                marginBottom: 16,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  marginBottom: 12,
                  fontSize: 12,
                  color: 'var(--muted)',
                  flexWrap: 'wrap',
                }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M3 8l3 3 7-7"
                    stroke="#1a7f37"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                {source === 'github' && <span>Imported from GitHub.</span>}
                Detected {detected.tools_count} tool{detected.tools_count === 1 ? '' : 's'} · auth:{' '}
                <code style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  {detected.auth_type || 'none'}
                </code>
              </div>
              <ul
                style={{
                  margin: 0,
                  padding: 0,
                  listStyle: 'none',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  maxHeight: 180,
                  overflowY: 'auto',
                }}
                data-testid="detected-actions"
              >
                {detected.actions.slice(0, 20).map((a) => (
                  <li
                    key={a.name}
                    style={{
                      fontSize: 13,
                      color: 'var(--ink)',
                      fontFamily: 'JetBrains Mono, monospace',
                    }}
                  >
                    <strong>{a.name}</strong>
                    {a.description && (
                      <span style={{ color: 'var(--muted)', fontFamily: 'Inter, sans-serif' }}>
                        {' '}
                        : {a.description}
                      </span>
                    )}
                  </li>
                ))}
                {detected.actions.length > 20 && (
                  <li style={{ fontSize: 12, color: 'var(--muted)' }}>
                    …and {detected.actions.length - 20} more
                  </li>
                )}
              </ul>
            </div>

            <Label>App name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="build-name" />

            <Label>Slug (URL path)</Label>
            <Input
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
              data-testid="build-slug"
            />

            <Label>Description</Label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              data-testid="build-description"
              style={{
                width: '100%',
                padding: '10px 12px',
                border: '1px solid var(--line)',
                borderRadius: 8,
                background: 'var(--card)',
                fontSize: 14,
                color: 'var(--ink)',
                fontFamily: 'inherit',
                resize: 'vertical',
                minHeight: 80,
                boxSizing: 'border-box',
              }}
            />

            <Label>Category (optional)</Label>
            <Input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="e.g. travel, coding, productivity"
              data-testid="build-category"
            />

            <Label>Visibility</Label>
            <VisibilityChooser
              value={visibility === 'auth-required' ? 'public' : visibility}
              onChange={(next) => setVisibility(next)}
            />
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '10px 0 0' }}>
              You can flip this later from{' '}
              <span style={{ fontFamily: 'JetBrains Mono, monospace' }}>/studio/{slug || '…'}</span>.
            </p>

            {error && (
              <p
                data-testid="build-error"
                style={{
                  margin: '16px 0 0',
                  padding: '10px 14px',
                  background: '#fdecea',
                  border: '1px solid #f4b7b1',
                  color: '#c2321f',
                  borderRadius: 8,
                  fontSize: 13,
                }}
              >
                {error}
              </p>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 24, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => {
                  try {
                    window.localStorage.removeItem(PENDING_KEY);
                  } catch {
                    /* ignore */
                  }
                  setStep('ramp');
                }}
                style={{
                  padding: '11px 18px',
                  background: 'transparent',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  fontSize: 13,
                  color: 'var(--muted)',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Back
              </button>
              <button
                type="button"
                onClick={handlePublish}
                data-testid="build-publish"
                disabled={!name || !slug}
                style={primaryButton(!name || !slug)}
              >
                Publish
              </button>
            </div>
          </div>
        )}

        {step === 'publishing' && (
          <div data-testid="build-step-publishing" style={{ padding: 40, textAlign: 'center' }}>
            <p style={{ fontSize: 14, color: 'var(--muted)' }}>Publishing...</p>
          </div>
        )}

        {step === 'done' && (
          <div data-testid="build-step-done">
            <div
              style={{
                padding: 24,
                textAlign: 'center',
                background: '#e6f4ea',
                border: '1px solid #b5dcc4',
                borderRadius: 12,
                marginBottom: 20,
              }}
            >
              <div style={{ color: '#1a7f37', fontSize: 20, fontWeight: 700, marginBottom: 8 }}>
                Published
              </div>
              <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 14px' }}>
                {visibility === 'private'
                  ? 'Your app is live. Only your signed-in sessions can run it — flip visibility to Public later if you want to share.'
                  : 'Your app is live. Share the link or install it into Claude Desktop to start running it.'}
              </p>
              {/* Shareable full URL + copy button. Before this fix the
                  banner only showed "/p/slug" relative path, which is not
                  shareable outside the current tab. */}
              <ShareableUrl slug={slug} />
              <div style={{ display: 'flex', justifyContent: 'center', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
                <button
                  type="button"
                  onClick={() => navigate(`/p/${slug}`)}
                  className="btn-primary"
                  data-testid="build-open-app"
                  style={{ padding: '9px 16px', fontSize: 13 }}
                >
                  Open app
                </button>
                <Link
                  to={postPublishHref ? postPublishHref(slug) : `/me/apps/${slug}`}
                  className="btn-ghost"
                  data-testid="build-install-claude"
                  style={{
                    padding: '9px 14px',
                    fontSize: 13,
                    border: '1px solid var(--line)',
                    borderRadius: 8,
                    textDecoration: 'none',
                  }}
                >
                  {postPublishHref ? 'Manage in Studio' : 'Install in Claude'}
                </Link>
                {!postPublishHref && (
                  <Link
                    to={`/creator/${slug}`}
                    className="btn-ghost"
                    style={{
                      padding: '9px 14px',
                      fontSize: 13,
                      border: '1px solid var(--line)',
                      borderRadius: 8,
                      textDecoration: 'none',
                    }}
                  >
                    View in creator dashboard
                  </Link>
                )}
              </div>
            </div>

            <div
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 12,
                padding: 20,
              }}
            >
              <CustomRendererPanel slug={slug} />
            </div>
          </div>
        )}
      </div>

      {comingSoon && (
        <ComingSoonRampModal target={comingSoon} onClose={() => setComingSoon(null)} />
      )}

      {signupPrompt && (
        <SignupToPublishModal
          onClose={() => setSignupPrompt(false)}
          onContinue={() => navigate('/signup?next=' + encodeURIComponent('/build'))}
          onSignIn={() => navigate('/login?next=' + encodeURIComponent('/build'))}
        />
      )}
    </Layout>
  );
}

/* -------------------------- subcomponents -------------------------- */

function RampCard({
  icon,
  title,
  badge,
  desc,
  onClick,
  testId,
  children,
  compact,
}: {
  icon: React.ReactNode;
  title: string;
  badge: string;
  desc: string;
  onClick: () => void;
  testId: string;
  children?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      style={{
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 14,
        padding: compact ? 18 : 22,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        color: 'var(--ink)',
        textAlign: 'left',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: 'var(--bg)',
            border: '1px solid var(--line)',
            color: 'var(--muted)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          {icon}
        </div>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
        <span
          style={{
            marginLeft: 'auto',
            padding: '3px 10px',
            borderRadius: 999,
            background: 'var(--accent-soft)',
            color: 'var(--accent)',
            fontSize: 10,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          {badge}
        </span>
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: 0, lineHeight: 1.55 }}>{desc}</p>
      {children}
    </button>
  );
}

function ErrorCard({
  severity,
  title,
  copy,
}: {
  severity: 'amber' | 'red';
  title: string;
  copy: string;
}) {
  const color = severity === 'amber' ? '#b45309' : '#991b1b';
  const bg = severity === 'amber' ? '#fef3c7' : '#fee2e2';
  return (
    <div
      style={{
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderLeft: `3px solid ${color}`,
        borderRadius: 10,
        padding: 14,
      }}
    >
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
          borderRadius: 6,
          background: bg,
          color,
          marginBottom: 8,
        }}
      >
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>
        {title}
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 }}>{copy}</div>
    </div>
  );
}

function ComingSoonRampModal({
  target,
  onClose,
}: {
  target: 'docker';
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const config = {
    docker: {
      title: 'Docker import (coming soon)',
      copy:
        'Pulling apps from Docker registries is on the v1.1 roadmap. For now, host your OpenAPI spec somewhere reachable and use the URL ramp.',
    },
  }[target];

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid={`coming-soon-ramp-${target}`}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(14, 14, 12, 0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--card)',
          border: '1px solid var(--line)',
          borderRadius: 14,
          padding: '28px 28px 24px',
          maxWidth: 460,
          width: '100%',
          boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
        }}
      >
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 10px',
            borderRadius: 999,
            background: 'var(--accent-soft)',
            color: 'var(--accent)',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            marginBottom: 14,
          }}
        >
          Coming soon
        </div>
        <h2 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 10px', color: 'var(--ink)' }}>
          {config.title}
        </h2>
        <p style={{ fontSize: 14, color: 'var(--muted)', margin: '0 0 20px', lineHeight: 1.55 }}>
          {config.copy}
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '8px 18px',
              background: 'var(--accent)',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

function SignupToPublishModal({
  onClose,
  onContinue,
  onSignIn,
}: {
  onClose: () => void;
  onContinue: () => void;
  onSignIn: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid="signup-to-publish-modal"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(14, 14, 12, 0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--card)',
          border: '1px solid var(--line)',
          borderRadius: 14,
          padding: '28px 28px 24px',
          maxWidth: 460,
          width: '100%',
          boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
        }}
      >
        <h2 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 10px', color: 'var(--ink)' }}>
          Sign up to publish this app
        </h2>
        <p style={{ fontSize: 14, color: 'var(--muted)', margin: '0 0 20px', lineHeight: 1.55 }}>
          Your detected spec is saved. Create a free account to publish it to the store, get a live
          MCP endpoint, and see run logs.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={onSignIn}
            data-testid="signup-to-publish-signin"
            style={{
              padding: '10px 18px',
              background: 'transparent',
              color: 'var(--ink)',
              border: '1px solid var(--line)',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            I already have an account
          </button>
          <button
            type="button"
            onClick={onContinue}
            data-testid="signup-to-publish-continue"
            style={{
              padding: '10px 18px',
              background: 'var(--accent)',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Create account
          </button>
        </div>
      </div>
    </div>
  );
}

function ShareableUrl({ slug }: { slug: string }) {
  // Publish-success shareable URL with one-click copy. Uses the live
  // origin so the copied value is a full https:// URL, not the relative
  // /p/slug that the old banner displayed.
  const [copied, setCopied] = useState(false);
  const origin =
    typeof window !== 'undefined' ? window.location.origin : 'https://preview.floom.dev';
  const fullUrl = `${origin}/p/${slug}`;
  async function copy() {
    try {
      await navigator.clipboard.writeText(fullUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked in some browsers; noop */
    }
  }
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        background: '#fff',
        border: '1px solid #b5dcc4',
        borderRadius: 8,
        padding: '8px 10px',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 12.5,
        color: 'var(--ink)',
      }}
    >
      <span data-testid="build-done-url" style={{ userSelect: 'all' }}>{fullUrl}</span>
      <button
        type="button"
        onClick={copy}
        data-testid="build-done-copy"
        style={{
          padding: '4px 10px',
          background: 'var(--accent)',
          color: '#fff',
          border: 'none',
          borderRadius: 6,
          fontSize: 11,
          fontWeight: 600,
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function StepBadge({ active, done, label }: { active: boolean; done: boolean; label: string }) {
  // The CSS fallback on --accent-soft used to be #e9e6ff (purple), which
  // violates Floom's "green accent only" brand rule. Fall back to a green
  // tint so the active step reads clearly, and outline the active pill so
  // it stands out against completed ones.
  return (
    <span
      style={{
        padding: '6px 12px',
        borderRadius: 999,
        fontWeight: 600,
        background: done ? '#e6f4ea' : active ? 'var(--accent-soft, #d7f1e0)' : 'var(--bg)',
        color: done ? '#1a7f37' : active ? 'var(--accent)' : 'var(--muted)',
        border: active ? '1px solid var(--accent)' : '1px solid var(--line)',
      }}
    >
      {label}
    </span>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label
      style={{
        display: 'block',
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--muted)',
        marginBottom: 6,
        marginTop: 14,
      }}
    >
      {children}
    </label>
  );
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{
        width: '100%',
        padding: '10px 12px',
        border: '1px solid var(--line)',
        borderRadius: 8,
        background: 'var(--card)',
        fontSize: 14,
        color: 'var(--ink)',
        fontFamily: 'inherit',
        boxSizing: 'border-box',
        ...(props.style || {}),
      }}
    />
  );
}

/**
 * Segmented Public / Private control with one-line explainers.
 * Issue #129: replaces the old <select> that silently defaulted to Private
 * and had no inline copy explaining what each option meant. Keeps
 * `auth-required` out of the visible surface — it's an advanced mode; when
 * a creator wants it, they set it in the manifest. Exposing it here would
 * confuse the 95% case.
 */
function VisibilityChooser({
  value,
  onChange,
}: {
  value: 'public' | 'private';
  onChange: (next: 'public' | 'private') => void;
}) {
  const options: Array<{
    id: 'public' | 'private';
    label: string;
    explainer: string;
  }> = [
    {
      id: 'public',
      label: 'Public',
      explainer: 'Appears in the Store. Anyone can run this app.',
    },
    {
      id: 'private',
      label: 'Private',
      explainer: 'Hidden from the Store. Only your signed-in sessions can run it.',
    },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Visibility"
      data-testid="build-visibility"
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 10,
        marginTop: 4,
      }}
    >
      {options.map((opt) => {
        const selected = value === opt.id;
        return (
          <label
            key={opt.id}
            data-testid={`build-visibility-${opt.id}`}
            data-selected={selected ? 'true' : 'false'}
            style={{
              border: selected ? '1.5px solid var(--accent)' : '1px solid var(--line)',
              background: selected ? 'var(--accent-soft, #e6f4ea)' : 'var(--card)',
              borderRadius: 10,
              padding: '12px 14px',
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              transition: 'border-color 0.12s ease, background 0.12s ease',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="radio"
                name="build-visibility"
                value={opt.id}
                checked={selected}
                onChange={() => onChange(opt.id)}
                data-testid={`build-visibility-${opt.id}-input`}
                style={{ accentColor: 'var(--accent)', margin: 0 }}
              />
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: selected ? 'var(--accent)' : 'var(--ink)',
                }}
              >
                {opt.label}
              </span>
            </div>
            <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
              {opt.explainer}
            </p>
          </label>
        );
      })}
    </div>
  );
}

function primaryButton(disabled: boolean): React.CSSProperties {
  return {
    padding: '11px 20px',
    background: 'var(--ink)',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: 'inherit',
    opacity: disabled ? 0.5 : 1,
  };
}

/* -------------------------- icons -------------------------- */

function GithubIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <use href="#icon-github" />
    </svg>
  );
}

function DockerIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 14h16M6 14V9h2v5M10 14V9h2v5M14 14V9h2v5M8 14V5h2v4M18 14c0 4-3 6-7 6-4 0-6-2-7-4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M10 13h6M10 17h6M10 9h2"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
