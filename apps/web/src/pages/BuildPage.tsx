// /studio/build — 2-click deploy (issue #551).
//
// Flow:
//   1. detect    — one input ("Paste a GitHub repo or OpenAPI URL") +
//                  starter chips that auto-fill + auto-submit
//   2. detecting — live cascading feed of paths tried (Vercel-style),
//                  each line renders with a ·/✓/✗ glyph as it resolves
//   3. preview   — operations, inputs, sample input with a big "Run
//                  sample" button; no visibility picker yet
//   4. running   — sample run is in flight
//   5. previewed — sample output is on screen, visibility picker +
//                  Publish CTA are revealed
//   3b. recover  — on detect fail, positive framing with 3 alts (paste
//                  spec URL / paste spec text / ask Claude). No leaked
//                  /api/hub/detect/inline endpoints — those live in a
//                  collapsed Developer disclosure.
//
// Replaces the prior multi-card ramp page (GitHub / Paste URL / Upload /
// Ask Claude / Docker). It worked but broke the "2-click" promise — too
// many choices above the fold. The single input auto-detects whether
// it's a GitHub ref (owner/repo, github.com/...) and runs the matching
// probe path.
//
// Why visibility-after-sample-run (#635)? Picking public/private/signed-in
// before the thing even works is the wrong order. Users don't know how
// the app behaves yet, and asking about sharing before the first
// successful run makes the flow feel heavy. Flip it: prove the app
// works, then ask who gets access.

import type { CSSProperties } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useSession } from '../hooks/useSession';
import { useDeployEnabled } from '../lib/flags';
import { PageShell } from '../components/PageShell';
import * as api from '../api/client';
import type { DetectedApp } from '../lib/types';
import {
  buildGithubSpecCandidates,
  formatGithubCandidate,
  looksLikeGithubRef,
  parseGithubRepoRef,
} from '../lib/githubUrl';
import { markJustPublished } from '../lib/onboarding';

// Starter chips: each links to a repo whose OpenAPI we know works.
// Clicking one populates the input and auto-submits. Safer than generic
// "examples" copy — the user sees a real repo name they recognise AND
// the implicit promise "this one detects cleanly right now".
const STARTER_CHIPS: readonly { label: string; value: string }[] = [
  { label: 'resend/resend-openapi', value: 'resend/resend-openapi' },
  { label: 'stripe/openapi', value: 'stripe/openapi' },
] as const;

type Visibility = 'public' | 'private' | 'auth-required';

type Step =
  | 'detect'
  | 'detecting'
  | 'preview'
  | 'running'
  | 'previewed'
  | 'publishing'
  | 'done';

type ProgressLine = {
  id: string;
  label: string;
  status: 'pending' | 'ok' | 'fail';
};

type DetectErrorKind =
  | 'private'
  | 'no-openapi'
  | 'unreachable'
  | 'repo-not-found'
  | 'bad-spec';

// `ActionDef` isn't exported from lib/types; use a local structural type
// that matches what DetectedApp.actions entries look like in practice.
type Action = {
  name: string;
  description?: string;
  input_schema?: {
    properties?: Record<string, { type?: string; description?: string; example?: unknown; default?: unknown }>;
    example?: unknown;
  };
};

interface BuildPageProps {
  postPublishHref?: (slug: string) => string;
  layout?: React.ComponentType<{ children: React.ReactNode; title?: string }>;
}

export function BuildPage({ postPublishHref, layout: Layout = PageShell }: BuildPageProps = {}) {
  const deployEnabled = useDeployEnabled();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { isAuthenticated, loading: sessionLoading, data: sessionData } = useSession();
  const cloudMode = sessionData?.cloud_mode === true;

  // Pre-populated from the landing hero (?ingest_url=). Legacy ?openapi=
  // is still accepted — both land in the single input.
  const heroUrl = searchParams.get('ingest_url') ?? searchParams.get('openapi') ?? '';
  const editSlug = searchParams.get('edit');

  const [step, setStep] = useState<Step>('detect');
  const [url, setUrl] = useState(heroUrl);

  const [detected, setDetected] = useState<DetectedApp | null>(null);
  const [progress, setProgress] = useState<ProgressLine[]>([]);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [detectErrorKind, setDetectErrorKind] = useState<DetectErrorKind | null>(null);

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');

  const [sampleAction, setSampleAction] = useState<Action | null>(null);
  const [sampleInputs, setSampleInputs] = useState<Record<string, unknown>>({});
  const [sampleRunId, setSampleRunId] = useState<string | null>(null);
  const [sampleOutput, setSampleOutput] = useState<unknown>(null);
  const [sampleError, setSampleError] = useState<string | null>(null);

  const [visibility, setVisibility] = useState<Visibility>('public');
  const [publishError, setPublishError] = useState<string | null>(null);

  // Recovery (paste URL / paste spec / ask Claude)
  const [recoveryMode, setRecoveryMode] = useState<'none' | 'direct-url' | 'paste' | 'prompt'>('none');
  const [directSpecUrl, setDirectSpecUrl] = useState('');
  const [pastedSpec, setPastedSpec] = useState('');
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [devDisclosureOpen, setDevDisclosureOpen] = useState(false);
  const authReturnPath = location.pathname + location.search;

  // Auto-detect once when the landing hero hands off a URL. Ref guard so
  // the effect never retriggers on subsequent renders.
  const autoDetectedRef = useRef(false);
  useEffect(() => {
    if (editSlug) return;
    if (autoDetectedRef.current) return;
    if (!heroUrl) return;
    if (sessionLoading) return;
    if (cloudMode && !isAuthenticated) return;
    autoDetectedRef.current = true;
    void submitDetect(heroUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heroUrl, sessionLoading, cloudMode, isAuthenticated, editSlug]);

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
        }
      })
      .catch(() => {
        /* ignore */
      });
  }, [editSlug]);

  async function submitDetect(raw: string) {
    const input = raw.trim();
    if (!input) return;
    setStep('detecting');
    setDetected(null);
    setDetectError(null);
    setDetectErrorKind(null);
    setProgress([]);
    setSampleRunId(null);
    setSampleOutput(null);
    setSampleError(null);

    if (looksLikeGithubRef(input)) {
      await detectFromGithub(input);
    } else {
      await detectFromOpenapi(input);
    }
  }

  async function detectFromGithub(raw: string) {
    const parsed = parseGithubRepoRef(raw);
    if (!parsed) {
      appendProgress({ id: 'parse', label: 'Parse GitHub URL', status: 'fail' });
      setDetectErrorKind('unreachable');
      setDetectError('That did not look like a GitHub repo reference.');
      setStep('preview');
      return;
    }
    appendProgress({ id: 'parse', label: `Parsing ${parsed.owner}/${parsed.repo}`, status: 'ok' });

    const probeId = 'repo-probe';
    appendProgress({ id: probeId, label: `Checking ${parsed.owner}/${parsed.repo} exists`, status: 'pending' });
    const existence = await checkRepoExists(parsed.owner, parsed.repo);
    if (existence.state === 'not-found') {
      updateProgress(probeId, 'fail');
      setDetectErrorKind('repo-not-found');
      setDetectError('That repo does not exist or is private.');
      setStep('preview');
      return;
    }
    updateProgress(probeId, 'ok');

    const candidates = buildGithubSpecCandidates(raw, {
      defaultBranch: existence.defaultBranch,
    });

    for (const candidate of candidates) {
      const lineId = `probe-${candidate}`;
      appendProgress({ id: lineId, label: `Trying ${formatGithubCandidate(candidate)}`, status: 'pending' });
      try {
        const result = await api.detectApp(candidate);
        updateProgress(lineId, 'ok');
        applyDetected(result);
        return;
      } catch {
        updateProgress(lineId, 'fail');
      }
    }

    setDetectErrorKind('no-openapi');
    setDetectError('No spec detected in that repo.');
    setStep('preview');
  }

  async function detectFromOpenapi(inputUrl: string) {
    const lineId = 'fetch-openapi';
    appendProgress({ id: lineId, label: `Fetching ${shortUrl(inputUrl)}`, status: 'pending' });
    try {
      const result = await api.detectApp(inputUrl);
      updateProgress(lineId, 'ok');
      applyDetected(result);
    } catch (err) {
      updateProgress(lineId, 'fail');
      const apiErr = err instanceof api.ApiError ? err : null;
      if (apiErr?.status === 404) {
        setDetectErrorKind('unreachable');
        setDetectError("We couldn't find that spec. Double-check the URL.");
      } else if (!apiErr || apiErr.status === 0) {
        setDetectErrorKind('unreachable');
        setDetectError("We couldn't reach that URL.");
      } else if (apiErr.status >= 400 && apiErr.status < 500) {
        setDetectErrorKind('bad-spec');
        setDetectError(apiErr.message || "That URL didn't return a valid OpenAPI spec.");
      } else {
        setDetectErrorKind('unreachable');
        setDetectError('The server returned an error. Try again in a moment.');
      }
      setStep('preview');
    }
  }

  function applyDetected(result: DetectedApp) {
    setDetected(result);
    setName(result.name);
    setSlug(result.slug);
    setDescription(result.description);
    const first = (result.actions[0] as Action | undefined) ?? null;
    setSampleAction(first);
    setSampleInputs(seedInputs(first));
    setStep('preview');
  }

  function appendProgress(line: ProgressLine) {
    setProgress((prev) => [...prev, line]);
  }

  function updateProgress(id: string, status: ProgressLine['status']) {
    setProgress((prev) => prev.map((l) => (l.id === id ? { ...l, status } : l)));
  }

  async function handleRunSample() {
    if (!detected || !sampleAction) return;
    setStep('running');
    setSampleError(null);
    setSampleOutput(null);
    try {
      const { run_id } = await api.startRun(slug, sampleInputs, undefined, sampleAction.name);
      setSampleRunId(run_id);
      const outcome = await pollRun(run_id);
      if (outcome.status === 'success') {
        setSampleOutput(outcome.outputs ?? null);
        setStep('previewed');
      } else {
        setSampleError(
          outcome.status === 'error'
            ? 'Sample run failed. Check the inputs and try again.'
            : 'Sample run timed out. Try again or simplify the inputs.',
        );
        setStep('preview');
      }
    } catch (err) {
      setSampleError((err as Error).message || 'Sample run failed.');
      setStep('preview');
    }
  }

  async function pollRun(
    runId: string,
  ): Promise<{ status: 'success' | 'error' | 'timeout'; outputs?: unknown }> {
    for (let i = 0; i < 30; i++) {
      try {
        const rec = await api.getRun(runId);
        if (rec.status === 'success' || rec.status === 'error' || rec.status === 'timeout') {
          return { status: rec.status, outputs: rec.outputs };
        }
      } catch {
        // transient, keep polling
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return { status: 'timeout' };
  }

  async function handlePublish() {
    if (!detected) return;
    if (!isAuthenticated) {
      navigate('/signup?next=' + encodeURIComponent(authReturnPath));
      return;
    }
    setStep('publishing');
    setPublishError(null);
    try {
      await api.ingestApp({
        openapi_url: detected.openapi_spec_url,
        name,
        slug,
        description,
        category: category || undefined,
        visibility,
      });
      markJustPublished(slug);
      setStep('done');
      if (postPublishHref) navigate(postPublishHref(slug));
    } catch (err) {
      setStep('previewed');
      setPublishError(humanizePublishError(err));
    }
  }

  async function handleDirectUrl() {
    if (!directSpecUrl.trim()) return;
    setRecoveryBusy(true);
    setRecoveryError(null);
    try {
      const result = await api.detectApp(directSpecUrl.trim());
      applyDetected(result);
      setRecoveryMode('none');
      setDetectErrorKind(null);
      setDetectError(null);
    } catch (e) {
      setRecoveryError(
        (e as Error).message ||
          "We couldn't fetch that URL. Make sure it is a public openapi.yaml or openapi.json.",
      );
    } finally {
      setRecoveryBusy(false);
    }
  }

  async function handlePasteSpec() {
    if (!pastedSpec.trim()) return;
    setRecoveryBusy(true);
    setRecoveryError(null);
    try {
      const result = await api.detectAppInline(pastedSpec.trim());
      applyDetected(result);
      setRecoveryMode('none');
      setDetectErrorKind(null);
      setDetectError(null);
    } catch (e) {
      setRecoveryError(
        (e as Error).message ||
          "That doesn't look like a valid OpenAPI spec. It needs openapi: 3.x and at least one path.",
      );
    } finally {
      setRecoveryBusy(false);
    }
  }

  if (deployEnabled === false) {
    return (
      <Layout title="Join the waitlist | Floom">
        <div style={{ maxWidth: 560, margin: '48px auto', padding: 24 }}>
          <h1 style={h1Style}>Deploy is on the waitlist</h1>
          <p style={{ color: 'var(--muted)', lineHeight: 1.6 }}>
            We&rsquo;re rolling Deploy out slowly for launch week. Drop your
            email on the waitlist and we&rsquo;ll let you know when your slot
            opens.
          </p>
        </div>
      </Layout>
    );
  }

  return (
    <Layout title="Publish an app | Floom">
      <div data-testid="build-page" style={{ maxWidth: 860, margin: '0 auto' }}>
        <header style={{ marginBottom: 24 }}>
          <h1 style={h1Style}>{editSlug ? `Edit ${editSlug}` : 'Publish a Floom app'}</h1>
          <p style={{ fontSize: 15, color: 'var(--muted)', margin: 0, maxWidth: 620, lineHeight: 1.55 }}>
            Paste a GitHub repo or OpenAPI URL. Floom reads it, shows you the
            operations, runs one for real, then asks who can use it. Two
            clicks to live.
          </p>
        </header>

        <StepIndicator step={step} />

        {step === 'detect' && (
          <DetectStep
            url={url}
            setUrl={setUrl}
            onSubmit={(next) => submitDetect(next ?? url)}
            sessionLoading={sessionLoading}
            cloudMode={cloudMode}
            isAuthenticated={isAuthenticated}
          />
        )}

        {step === 'detecting' && <DetectingStep progress={progress} />}

        {step === 'preview' && detectErrorKind && (
          <RecoverStep
            kind={detectErrorKind}
            message={detectError}
            recoveryMode={recoveryMode}
            setRecoveryMode={setRecoveryMode}
            directSpecUrl={directSpecUrl}
            setDirectSpecUrl={setDirectSpecUrl}
            pastedSpec={pastedSpec}
            setPastedSpec={setPastedSpec}
            onDirectSubmit={handleDirectUrl}
            onPasteSubmit={handlePasteSpec}
            busy={recoveryBusy}
            error={recoveryError}
            devDisclosureOpen={devDisclosureOpen}
            setDevDisclosureOpen={setDevDisclosureOpen}
            onReset={() => {
              setStep('detect');
              setDetectErrorKind(null);
              setDetectError(null);
              setRecoveryMode('none');
              setProgress([]);
            }}
          />
        )}

        {step === 'preview' && detected && !detectErrorKind && (
          <PreviewStep
            detected={detected}
            name={name}
            setName={setName}
            slug={slug}
            setSlug={setSlug}
            description={description}
            setDescription={setDescription}
            category={category}
            setCategory={setCategory}
            sampleAction={sampleAction}
            setSampleAction={(a) => {
              setSampleAction(a);
              setSampleInputs(seedInputs(a));
            }}
            sampleInputs={sampleInputs}
            setSampleInputs={setSampleInputs}
            sampleError={sampleError}
            onRunSample={handleRunSample}
          />
        )}

        {step === 'running' && <RunningStep sampleRunId={sampleRunId} />}

        {step === 'previewed' && detected && (
          <PublishStep
            slug={slug}
            name={name}
            sampleOutput={sampleOutput}
            visibility={visibility}
            setVisibility={setVisibility}
            onPublish={handlePublish}
            error={publishError}
            onEdit={() => setStep('preview')}
          />
        )}

        {step === 'publishing' && <PublishingStep visibility={visibility} />}

        {step === 'done' && <DoneStep slug={slug} visibility={visibility} />}
      </div>
    </Layout>
  );
}

/* ---------- steps ---------- */

function StepIndicator({ step }: { step: Step }) {
  const cells: { label: string; active: boolean; done: boolean }[] = [
    {
      label: '1. Paste',
      active: step === 'detect' || step === 'detecting',
      done: step !== 'detect' && step !== 'detecting',
    },
    {
      label: '2. Preview',
      active: step === 'preview',
      done: step === 'running' || step === 'previewed' || step === 'publishing' || step === 'done',
    },
    {
      label: '3. Run sample',
      active: step === 'running',
      done: step === 'previewed' || step === 'publishing' || step === 'done',
    },
    {
      label: '4. Publish',
      active: step === 'previewed' || step === 'publishing',
      done: step === 'done',
    },
  ];
  return (
    <div
      data-testid="build-step-indicator"
      style={{
        display: 'flex',
        gap: 8,
        marginBottom: 24,
        fontSize: 12,
        flexWrap: 'wrap',
      }}
    >
      {cells.map((c, i) => (
        <span
          key={i}
          data-testid={`step-cell-${i}`}
          data-active={c.active ? 'true' : 'false'}
          data-done={c.done ? 'true' : 'false'}
          style={{
            padding: '4px 10px',
            borderRadius: 999,
            border: `1px solid ${c.active ? 'var(--accent)' : 'var(--line)'}`,
            background: c.done
              ? 'rgba(16,185,129,0.08)'
              : c.active
                ? 'var(--card)'
                : 'transparent',
            color: c.done || c.active ? 'var(--ink)' : 'var(--muted)',
            fontWeight: c.active ? 600 : 500,
          }}
        >
          {c.done ? '✓ ' : ''}
          {c.label}
        </span>
      ))}
    </div>
  );
}

function DetectStep({
  url,
  setUrl,
  onSubmit,
  sessionLoading,
  cloudMode,
  isAuthenticated,
}: {
  url: string;
  setUrl: (v: string) => void;
  onSubmit: (override?: string) => void;
  sessionLoading: boolean;
  cloudMode: boolean;
  isAuthenticated: boolean;
}) {
  const authRequired = cloudMode && !isAuthenticated;
  function pickChip(value: string) {
    setUrl(value);
    // Pass the chip value directly to submit so we don't race with the
    // setUrl state commit.
    onSubmit(value);
  }
  return (
    <div data-testid="build-step-detect">
      {authRequired && (
        <div
          data-testid="build-auth-required"
          style={{
            background: '#fff8e6',
            border: '1px solid #f4e0a5',
            color: '#755a00',
            borderRadius: 12,
            padding: '12px 16px',
            marginBottom: 16,
            fontSize: 13,
            lineHeight: 1.55,
          }}
        >
          Sign in to publish. Your pasted URL stays here after you come back.
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!sessionLoading) onSubmit();
        }}
        style={{
          background: 'var(--card)',
          border: '1px solid var(--line)',
          borderRadius: 16,
          padding: 24,
        }}
      >
        <label
          htmlFor="build-url-input"
          style={{
            display: 'block',
            fontSize: 14,
            fontWeight: 600,
            color: 'var(--ink)',
            marginBottom: 10,
          }}
        >
          Paste a GitHub repo or OpenAPI URL
        </label>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '4px 6px 4px 14px',
            border: '1px solid var(--line)',
            borderRadius: 10,
            background: 'var(--bg)',
            marginBottom: 14,
          }}
        >
          <input
            id="build-url-input"
            data-testid="build-url-input"
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="owner/repo or https://api.example.com/openapi.json"
            autoFocus
            style={{
              flex: 1,
              minWidth: 0,
              padding: '12px 4px',
              border: 'none',
              background: 'transparent',
              fontSize: 15,
              fontFamily: 'JetBrains Mono, monospace',
              color: 'var(--ink)',
              outline: 'none',
            }}
          />
          <button
            type="submit"
            data-testid="build-detect-submit"
            disabled={!url || sessionLoading}
            style={{
              padding: '10px 18px',
              background: 'var(--accent, #10b981)',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              cursor: !url || sessionLoading ? 'not-allowed' : 'pointer',
              opacity: !url || sessionLoading ? 0.55 : 1,
              fontFamily: 'inherit',
              flexShrink: 0,
            }}
          >
            Detect
          </button>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
            fontSize: 12,
            color: 'var(--muted)',
          }}
        >
          <span>Try a repo that works:</span>
          {STARTER_CHIPS.map((chip) => (
            <button
              key={chip.value}
              type="button"
              data-testid={`starter-chip-${chip.value.replace(/\W+/g, '-')}`}
              onClick={() => pickChip(chip.value)}
              style={{
                padding: '4px 10px',
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 999,
                fontSize: 12,
                fontFamily: 'JetBrains Mono, monospace',
                color: 'var(--ink)',
                cursor: 'pointer',
              }}
            >
              {chip.label}
            </button>
          ))}
        </div>
      </form>
    </div>
  );
}

function DetectingStep({ progress }: { progress: ProgressLine[] }) {
  return (
    <div
      data-testid="build-step-detecting"
      style={{
        background: '#1b1a17',
        color: '#e7e5dd',
        border: '1px solid #2b2a24',
        borderRadius: 12,
        padding: '20px 22px',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 13,
        lineHeight: 1.7,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: '#a19d8e',
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          marginBottom: 14,
        }}
      >
        Detecting
      </div>
      <ul data-testid="build-progress-feed" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {progress.map((line) => (
          <li
            key={line.id}
            data-testid={`progress-${line.id}`}
            data-status={line.status}
            style={{ display: 'flex', alignItems: 'center', gap: 10 }}
          >
            <span style={{ width: 14, display: 'inline-block', color: statusColor(line.status) }}>
              {statusGlyph(line.status)}
            </span>
            <span style={{ color: line.status === 'fail' ? '#f0a5a0' : '#e7e5dd' }}>
              {line.label}
            </span>
          </li>
        ))}
        {progress.length === 0 && <li style={{ color: '#a19d8e' }}>Starting…</li>}
      </ul>
    </div>
  );
}

function statusColor(s: ProgressLine['status']) {
  if (s === 'ok') return 'var(--accent, #10b981)';
  if (s === 'fail') return '#f0a5a0';
  return '#a19d8e';
}
function statusGlyph(s: ProgressLine['status']) {
  if (s === 'ok') return '✓';
  if (s === 'fail') return '✗';
  return '·';
}

function PreviewStep({
  detected,
  name,
  setName,
  slug,
  setSlug,
  description,
  setDescription,
  category,
  setCategory,
  sampleAction,
  setSampleAction,
  sampleInputs,
  setSampleInputs,
  sampleError,
  onRunSample,
}: {
  detected: DetectedApp;
  name: string;
  setName: (v: string) => void;
  slug: string;
  setSlug: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  category: string;
  setCategory: (v: string) => void;
  sampleAction: Action | null;
  setSampleAction: (a: Action) => void;
  sampleInputs: Record<string, unknown>;
  setSampleInputs: (v: Record<string, unknown>) => void;
  sampleError: string | null;
  onRunSample: () => void;
}) {
  return (
    <div data-testid="build-step-preview" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <section
        data-testid="preview-detected-card"
        style={{
          background: 'var(--card)',
          border: '1px solid var(--line)',
          borderRadius: 14,
          padding: '22px 24px',
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: 'var(--accent, #10b981)',
            marginBottom: 10,
            letterSpacing: '0.02em',
            textTransform: 'uppercase',
          }}
        >
          Detected
        </div>
        <h2
          data-testid="preview-name"
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 24,
            fontWeight: 800,
            letterSpacing: '-0.025em',
            margin: '0 0 6px',
            color: 'var(--ink)',
          }}
        >
          {name || 'Untitled app'}
        </h2>
        <p
          data-testid="preview-description"
          style={{ margin: 0, fontSize: 14, color: 'var(--muted)', lineHeight: 1.55 }}
        >
          {firstSentence(description) || 'No description yet.'}
        </p>
        <div
          style={{
            display: 'flex',
            gap: 14,
            flexWrap: 'wrap',
            marginTop: 14,
            fontSize: 12,
            color: 'var(--muted)',
          }}
        >
          <span>
            <strong style={{ color: 'var(--ink)' }}>{detected.tools_count}</strong>{' '}
            operation{detected.tools_count === 1 ? '' : 's'}
          </span>
          <span>·</span>
          <span>
            auth:{' '}
            <code style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {detected.auth_type || 'none'}
            </code>
          </span>
        </div>
      </section>

      <section
        data-testid="preview-sample-card"
        style={{
          background: 'var(--card)',
          border: '1px solid var(--line)',
          borderRadius: 14,
          padding: '22px 24px',
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink)', marginBottom: 4 }}>
          Run one to see it work
        </div>
        <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.55, margin: '0 0 14px' }}>
          Floom will call this operation with sample inputs so you know it
          wires up before you publish.
        </p>

        {detected.actions.length > 1 && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 500, display: 'block', marginBottom: 6 }}>
              Operation
            </label>
            <select
              data-testid="sample-action-picker"
              value={sampleAction?.name || ''}
              onChange={(e) => {
                const next = detected.actions.find((a) => (a as Action).name === e.target.value) as Action | undefined;
                if (next) setSampleAction(next);
              }}
              style={{
                padding: '8px 10px',
                border: '1px solid var(--line)',
                borderRadius: 8,
                background: 'var(--bg)',
                fontSize: 13,
                fontFamily: 'JetBrains Mono, monospace',
                color: 'var(--ink)',
                minWidth: 260,
              }}
            >
              {detected.actions.map((a) => {
                const action = a as Action;
                return (
                  <option key={action.name} value={action.name}>
                    {action.name}
                  </option>
                );
              })}
            </select>
          </div>
        )}

        {sampleAction && <SampleInputs action={sampleAction} values={sampleInputs} setValues={setSampleInputs} />}

        {sampleError && (
          <div
            data-testid="sample-error"
            style={{
              margin: '12px 0 0',
              padding: '10px 14px',
              background: '#fdecea',
              border: '1px solid #f4b7b1',
              color: '#c2321f',
              borderRadius: 8,
              fontSize: 13,
            }}
          >
            {sampleError}
          </div>
        )}

        <div style={{ marginTop: 16 }}>
          <button
            type="button"
            data-testid="run-sample-btn"
            onClick={onRunSample}
            disabled={!sampleAction}
            style={{
              padding: '12px 22px',
              background: 'var(--accent, #10b981)',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 600,
              cursor: sampleAction ? 'pointer' : 'not-allowed',
              opacity: sampleAction ? 1 : 0.55,
              fontFamily: 'inherit',
            }}
          >
            Run sample →
          </button>
        </div>
      </section>

      <details
        data-testid="preview-edit-details"
        style={{
          background: 'var(--card)',
          border: '1px solid var(--line)',
          borderRadius: 12,
          padding: '0 4px',
        }}
      >
        <summary
          style={{
            cursor: 'pointer',
            listStyle: 'none',
            padding: '14px 18px',
            fontSize: 13,
            color: 'var(--ink)',
            fontWeight: 500,
          }}
        >
          Edit details (name, slug, description, category)
        </summary>
        <div style={{ padding: '4px 18px 20px' }}>
          <FieldLabel>App name</FieldLabel>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} data-testid="build-name" />
          <FieldLabel>Slug</FieldLabel>
          <TextInput
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
            data-testid="build-slug"
          />
          <FieldLabel>Description</FieldLabel>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={5}
            data-testid="build-description"
            style={textareaStyle}
          />
          <FieldLabel>Category (optional)</FieldLabel>
          <TextInput
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="e.g. travel, coding, productivity"
            data-testid="build-category"
          />
        </div>
      </details>
    </div>
  );
}

function seedInputs(action: Action | null): Record<string, unknown> {
  if (!action) return {};
  const schema = action.input_schema ?? {};
  if (schema.example && typeof schema.example === 'object') {
    return { ...(schema.example as Record<string, unknown>) };
  }
  const props = schema.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [key, rawDef] of Object.entries(props)) {
    const def = rawDef;
    if (def.example !== undefined) out[key] = def.example;
    else if (def.default !== undefined) out[key] = def.default;
    else if (def.type === 'number' || def.type === 'integer') out[key] = 0;
    else if (def.type === 'boolean') out[key] = false;
    else out[key] = '';
  }
  return out;
}

function SampleInputs({
  action,
  values,
  setValues,
}: {
  action: Action;
  values: Record<string, unknown>;
  setValues: (v: Record<string, unknown>) => void;
}) {
  const props = (action.input_schema ?? {}).properties ?? {};
  const fields = Object.entries(props);
  if (fields.length === 0) {
    return <div style={{ fontSize: 13, color: 'var(--muted)' }}>This action takes no inputs. Hit Run sample.</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {fields.slice(0, 4).map(([key, def]) => (
        <div key={key}>
          <FieldLabel>{key}</FieldLabel>
          <TextInput
            data-testid={`sample-input-${key}`}
            value={String(values[key] ?? '')}
            onChange={(e) => setValues({ ...values, [key]: e.target.value })}
            placeholder={def.description || key}
          />
        </div>
      ))}
    </div>
  );
}

function RunningStep({ sampleRunId }: { sampleRunId: string | null }) {
  return (
    <div
      data-testid="build-step-running"
      style={{
        padding: 40,
        textAlign: 'center',
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 12,
      }}
    >
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 18px',
          background: '#1b1a17',
          color: '#e7e5dd',
          borderRadius: 10,
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 13,
        }}
      >
        <Spinner />
        <span>Running sample{sampleRunId ? ` · ${sampleRunId.slice(0, 8)}` : ''}…</span>
      </div>
      <p style={{ marginTop: 14, fontSize: 12.5, color: 'var(--muted)' }}>
        This usually takes a few seconds.
      </p>
    </div>
  );
}

function PublishStep({
  slug,
  name,
  sampleOutput,
  visibility,
  setVisibility,
  onPublish,
  error,
  onEdit,
}: {
  slug: string;
  name: string;
  sampleOutput: unknown;
  visibility: Visibility;
  setVisibility: (v: Visibility) => void;
  onPublish: () => void;
  error: string | null;
  onEdit: () => void;
}) {
  return (
    <div data-testid="build-step-previewed" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <section
        data-testid="sample-result-card"
        style={{
          background: 'var(--card)',
          border: '1px solid var(--accent, #10b981)',
          borderRadius: 14,
          padding: '22px 24px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 12,
            color: 'var(--accent, #10b981)',
            fontWeight: 700,
            letterSpacing: '0.02em',
            textTransform: 'uppercase',
            marginBottom: 12,
          }}
        >
          ✓ Sample ran successfully
        </div>
        <div style={{ fontSize: 14, color: 'var(--ink)', fontWeight: 600, marginBottom: 8 }}>
          Output
        </div>
        <pre
          data-testid="sample-output-preview"
          style={{
            margin: 0,
            padding: '12px 14px',
            background: '#1b1a17',
            color: '#e7e5dd',
            borderRadius: 8,
            fontSize: 12.5,
            fontFamily: 'JetBrains Mono, monospace',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 260,
            overflowY: 'auto',
          }}
        >
          {formatOutput(sampleOutput)}
        </pre>
      </section>

      <section
        data-testid="publish-card"
        style={{
          background: 'var(--card)',
          border: '1px solid var(--line)',
          borderRadius: 14,
          padding: '22px 24px',
        }}
      >
        <h3
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 18,
            fontWeight: 800,
            letterSpacing: '-0.025em',
            margin: '0 0 6px',
            color: 'var(--ink)',
          }}
        >
          Who can use it?
        </h3>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 14px', lineHeight: 1.55 }}>
          You can change this later from /studio/{slug || '…'}.
        </p>

        <VisibilityChooser value={visibility} onChange={setVisibility} />

        {error && (
          <div
            data-testid="publish-error"
            style={{
              margin: '14px 0',
              padding: '10px 14px',
              background: '#fdecea',
              border: '1px solid #f4b7b1',
              color: '#c2321f',
              borderRadius: 8,
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
          <button
            type="button"
            data-testid="build-publish"
            onClick={onPublish}
            disabled={!name || !slug}
            style={{
              padding: '12px 22px',
              background: 'var(--accent, #10b981)',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 600,
              cursor: !name || !slug ? 'not-allowed' : 'pointer',
              opacity: !name || !slug ? 0.55 : 1,
              fontFamily: 'inherit',
            }}
          >
            {publishLabel(visibility)}
          </button>
          <button
            type="button"
            data-testid="back-to-preview"
            onClick={onEdit}
            style={{
              padding: '10px 16px',
              background: 'transparent',
              color: 'var(--muted)',
              border: 'none',
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'inherit',
              textDecoration: 'underline',
            }}
          >
            Edit details
          </button>
        </div>
      </section>
    </div>
  );
}

function PublishingStep({ visibility }: { visibility: Visibility }) {
  return (
    <div
      data-testid="build-step-publishing"
      role="status"
      aria-live="polite"
      style={{
        padding: 40,
        textAlign: 'center',
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 12,
      }}
    >
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 18px',
          background: '#1b1a17',
          color: '#e7e5dd',
          borderRadius: 10,
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 13,
        }}
      >
        <Spinner />
        <span>Publishing {visibility}…</span>
      </div>
    </div>
  );
}

function DoneStep({ slug, visibility }: { slug: string; visibility: Visibility }) {
  return (
    <div
      data-testid="build-step-done"
      style={{
        padding: 28,
        textAlign: 'center',
        background: '#e6f4ea',
        border: '1px solid #b5dcc4',
        borderRadius: 14,
      }}
    >
      <div
        style={{
          color: '#1a7f37',
          fontSize: 22,
          fontWeight: 800,
          marginBottom: 8,
          fontFamily: 'var(--font-display)',
          letterSpacing: '-0.025em',
        }}
      >
        Published
      </div>
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 16px', lineHeight: 1.55 }}>
        {visibilityDoneCopy(visibility)}
      </p>
      <a
        href={`/p/${slug}`}
        data-testid="done-open-app"
        style={{
          display: 'inline-block',
          padding: '10px 18px',
          background: 'var(--accent, #10b981)',
          color: '#fff',
          borderRadius: 8,
          fontSize: 14,
          fontWeight: 600,
          textDecoration: 'none',
        }}
      >
        Open app →
      </a>
    </div>
  );
}

/* ---------- recovery ---------- */

function RecoverStep({
  kind,
  message,
  recoveryMode,
  setRecoveryMode,
  directSpecUrl,
  setDirectSpecUrl,
  pastedSpec,
  setPastedSpec,
  onDirectSubmit,
  onPasteSubmit,
  busy,
  error,
  onReset,
  devDisclosureOpen,
  setDevDisclosureOpen,
}: {
  kind: DetectErrorKind;
  message: string | null;
  recoveryMode: 'none' | 'direct-url' | 'paste' | 'prompt';
  setRecoveryMode: (m: 'none' | 'direct-url' | 'paste' | 'prompt') => void;
  directSpecUrl: string;
  setDirectSpecUrl: (v: string) => void;
  pastedSpec: string;
  setPastedSpec: (v: string) => void;
  onDirectSubmit: () => void;
  onPasteSubmit: () => void;
  busy: boolean;
  error: string | null;
  onReset: () => void;
  devDisclosureOpen: boolean;
  setDevDisclosureOpen: (b: boolean) => void;
}) {
  return (
    <div data-testid="build-step-recover">
      <section
        style={{
          background: 'var(--card)',
          border: '1px solid var(--line)',
          borderRadius: 14,
          padding: '22px 24px',
          marginBottom: 14,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)', marginBottom: 6 }}>
          {titleForKind(kind)}
        </div>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 16px', lineHeight: 1.55 }}>
          {message || messageForKind(kind)}
        </p>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 10,
          }}
        >
          <RecoveryCard
            active={recoveryMode === 'direct-url'}
            label="Paste a spec URL"
            sub="Direct link to your openapi.yaml"
            onClick={() => setRecoveryMode(recoveryMode === 'direct-url' ? 'none' : 'direct-url')}
          />
          <RecoveryCard
            active={recoveryMode === 'paste'}
            label="Paste the spec"
            sub="OpenAPI JSON or YAML text"
            onClick={() => setRecoveryMode(recoveryMode === 'paste' ? 'none' : 'paste')}
          />
          <RecoveryCard
            active={recoveryMode === 'prompt'}
            label="Ask Claude"
            sub="Copy a prompt to generate one"
            onClick={() => setRecoveryMode(recoveryMode === 'prompt' ? 'none' : 'prompt')}
          />
        </div>

        {recoveryMode === 'direct-url' && (
          <div style={{ marginTop: 14 }}>
            <TextInput
              data-testid="recovery-direct-url"
              value={directSpecUrl}
              onChange={(e) => setDirectSpecUrl(e.target.value)}
              placeholder="https://example.com/openapi.json"
            />
            {error && <InlineError>{error}</InlineError>}
            <PrimaryButton
              data-testid="recovery-direct-submit"
              disabled={!directSpecUrl.trim() || busy}
              onClick={onDirectSubmit}
            >
              {busy ? 'Checking…' : 'Try this URL'}
            </PrimaryButton>
          </div>
        )}

        {recoveryMode === 'paste' && (
          <div style={{ marginTop: 14 }}>
            <textarea
              data-testid="recovery-paste"
              value={pastedSpec}
              onChange={(e) => setPastedSpec(e.target.value)}
              rows={8}
              placeholder={'openapi: 3.1.0\ninfo:\n  title: My App\n  version: 1.0.0'}
              style={{ ...textareaStyle, fontFamily: 'JetBrains Mono, monospace', fontSize: 12.5 }}
            />
            {error && <InlineError>{error}</InlineError>}
            <PrimaryButton
              data-testid="recovery-paste-submit"
              disabled={!pastedSpec.trim() || busy}
              onClick={onPasteSubmit}
            >
              {busy ? 'Checking…' : 'Use this spec'}
            </PrimaryButton>
          </div>
        )}

        {recoveryMode === 'prompt' && (
          <div style={{ marginTop: 14 }}>
            <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.55, marginBottom: 10 }}>
              Copy this prompt into Claude or Cursor. It&rsquo;ll generate an
              openapi.yaml for your repo.
            </p>
            <pre
              style={{
                padding: '12px 14px',
                background: '#1b1a17',
                color: '#e7e5dd',
                borderRadius: 8,
                fontSize: 12,
                fontFamily: 'JetBrains Mono, monospace',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {PROMPT_TEMPLATE}
            </pre>
          </div>
        )}
      </section>

      <details
        data-testid="build-developer-disclosure"
        open={devDisclosureOpen}
        onToggle={(e) => setDevDisclosureOpen((e.target as HTMLDetailsElement).open)}
        style={{
          background: 'var(--card)',
          border: '1px solid var(--line)',
          borderRadius: 10,
          padding: '0 4px',
          marginBottom: 14,
        }}
      >
        <summary
          style={{
            cursor: 'pointer',
            listStyle: 'none',
            padding: '10px 14px',
            fontSize: 12.5,
            color: 'var(--muted)',
            fontWeight: 500,
          }}
        >
          Developer: curl the API directly
        </summary>
        <div style={{ padding: '0 14px 14px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
          <code style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            POST /api/hub/detect &middot; POST /api/hub/detect/inline &middot;
            POST /api/hub/detect/hint
          </code>
          <br />
          Payloads + examples in{' '}
          <a href="/docs/api" style={{ color: 'var(--accent)' }}>/docs/api</a>.
        </div>
      </details>

      <button
        type="button"
        data-testid="recover-reset"
        onClick={onReset}
        style={{
          padding: '8px 14px',
          background: 'transparent',
          color: 'var(--muted)',
          border: 'none',
          fontSize: 13,
          fontFamily: 'inherit',
          textDecoration: 'underline',
          cursor: 'pointer',
        }}
      >
        Start over
      </button>
    </div>
  );
}

function RecoveryCard({
  label,
  sub,
  active,
  onClick,
}: {
  label: string;
  sub: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={`recovery-card-${label.replace(/\s+/g, '-').toLowerCase()}`}
      onClick={onClick}
      style={{
        textAlign: 'left',
        padding: '14px 16px',
        border: `1px solid ${active ? 'var(--accent, #10b981)' : 'var(--line)'}`,
        borderRadius: 12,
        background: active ? 'rgba(16, 185, 129, 0.05)' : 'var(--bg)',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>{sub}</div>
    </button>
  );
}

/* ---------- tiny helpers ---------- */

const h1Style: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontSize: 32,
  fontWeight: 800,
  letterSpacing: '-0.025em',
  lineHeight: 1.1,
  margin: '0 0 8px',
  color: 'var(--ink)',
};

const textareaStyle: CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  border: '1px solid var(--line)',
  borderRadius: 8,
  background: 'var(--card)',
  fontSize: 14,
  color: 'var(--ink)',
  fontFamily: 'inherit',
  resize: 'vertical',
  minHeight: 120,
  boxSizing: 'border-box',
};

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label
      style={{
        display: 'block',
        fontSize: 12,
        color: 'var(--muted)',
        fontWeight: 500,
        margin: '12px 0 4px',
      }}
    >
      {children}
    </label>
  );
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      type={props.type || 'text'}
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
        ...props.style,
      }}
    />
  );
}

function PrimaryButton({
  children,
  disabled,
  onClick,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        marginTop: 12,
        padding: '10px 18px',
        background: 'var(--accent, #10b981)',
        color: '#fff',
        border: 'none',
        borderRadius: 8,
        fontSize: 13,
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        fontFamily: 'inherit',
      }}
    >
      {children}
    </button>
  );
}

function InlineError({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        marginTop: 10,
        padding: '8px 12px',
        background: '#fdecea',
        border: '1px solid #f4b7b1',
        color: '#c2321f',
        borderRadius: 8,
        fontSize: 12.5,
      }}
    >
      {children}
    </div>
  );
}

function Spinner() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="4" strokeLinecap="round">
        <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
      </path>
    </svg>
  );
}

function VisibilityChooser({
  value,
  onChange,
}: {
  value: Visibility;
  onChange: (v: Visibility) => void;
}) {
  const options: { v: Visibility; label: string; sub: string }[] = [
    { v: 'public', label: 'Public', sub: 'Anyone with the link, listed in the directory' },
    { v: 'auth-required', label: 'Signed-in only', sub: 'Any Floom user can run it via the link' },
    { v: 'private', label: 'Private', sub: 'Only you (while signed in)' },
  ];
  return (
    <div data-testid="visibility-chooser" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {options.map((o) => {
        const active = value === o.v;
        return (
          <label
            key={o.v}
            data-testid={`visibility-${o.v}`}
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'flex-start',
              padding: '10px 12px',
              border: `1px solid ${active ? 'var(--accent, #10b981)' : 'var(--line)'}`,
              borderRadius: 10,
              background: active ? 'rgba(16, 185, 129, 0.05)' : 'var(--bg)',
              cursor: 'pointer',
            }}
          >
            <input
              type="radio"
              name="visibility"
              value={o.v}
              checked={active}
              onChange={() => onChange(o.v)}
              style={{ marginTop: 3 }}
            />
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{o.label}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.4 }}>{o.sub}</div>
            </div>
          </label>
        );
      })}
    </div>
  );
}

function publishLabel(v: Visibility): string {
  if (v === 'private') return 'Publish (private)';
  if (v === 'auth-required') return 'Publish (signed-in only)';
  return 'Publish (public)';
}

function visibilityDoneCopy(v: Visibility): string {
  if (v === 'private') return 'Your app is live. Only you can run it while signed in.';
  if (v === 'auth-required') return 'Your app is live. Any signed-in Floom user can run it via the link.';
  return 'Your app is live. Share the link or add it to Claude Desktop to start running it.';
}

function shortUrl(u: string): string {
  return u.replace(/^https?:\/\//, '').replace(/^www\./, '');
}

function firstSentence(text: string): string {
  const t = (text || '').trim();
  if (!t) return '';
  const dot = t.indexOf('. ');
  if (dot === -1) return t.length > 180 ? t.slice(0, 177) + '…' : t;
  return t.slice(0, dot + 1);
}

function formatOutput(o: unknown): string {
  if (o == null) return '(no output)';
  if (typeof o === 'string') return o;
  try {
    return JSON.stringify(o, null, 2);
  } catch {
    return String(o);
  }
}

function titleForKind(kind: DetectErrorKind): string {
  if (kind === 'no-openapi') return 'No spec detected';
  if (kind === 'repo-not-found') return 'Repo not found';
  if (kind === 'private') return 'Repo looks private';
  if (kind === 'bad-spec') return 'Spec could not be parsed';
  return 'URL not reachable';
}

function messageForKind(kind: DetectErrorKind): string {
  if (kind === 'no-openapi') return 'Try one of these paths instead.';
  if (kind === 'repo-not-found') return 'Double-check the URL or paste the spec directly below.';
  if (kind === 'private') return "We can't reach private repos yet. Make it public or paste the spec directly.";
  if (kind === 'bad-spec') return 'The URL loaded, but the content did not look like OpenAPI 3.x. Try one of these.';
  return 'Paste a GitHub repo URL or openapi.yaml link, or use one of the paths below.';
}

function humanizePublishError(err: unknown): string {
  if (err instanceof api.ApiError) {
    if (err.status === 409) return 'That slug is already taken. Edit it in the details panel and try again.';
    if (err.status === 401) return 'You need to sign in to publish.';
    if (err.status >= 500) return 'The server had a hiccup. Try again in a moment.';
    return err.message || 'Publish failed.';
  }
  return 'Publish failed. Try again in a moment.';
}

async function checkRepoExists(
  owner: string,
  repo: string,
): Promise<{ state: 'exists' | 'not-found' | 'unknown'; defaultBranch: string | null }> {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      method: 'GET',
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (res.status === 404) return { state: 'not-found', defaultBranch: null };
    if (res.ok) {
      const body = (await res.json()) as { default_branch?: string };
      return { state: 'exists', defaultBranch: body.default_branch || null };
    }
    return { state: 'unknown', defaultBranch: null };
  } catch {
    return { state: 'unknown', defaultBranch: null };
  }
}

const PROMPT_TEMPLATE = `I have a web API in this repo. Generate an openapi.yaml at the repo root
that describes every operation.

Follow these rules:
  - openapi: 3.1.0
  - One operationId per endpoint, camelCase
  - Input / output schemas with examples
  - info.title = the repo name, info.version = 1.0.0
  - servers: the public URL where my API runs

Drop the file, commit it, and I'll point Floom at the repo again.`;
