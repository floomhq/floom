// /studio/build — v23 PR-I 10-state machine.
//
// Stages (chip row): 1. Paste → 2. Detect → 3. Publish → 4. Done.
// Internal state machine (10 named values):
//   detect        — paste step (default)
//   detecting     — cascading live tail (transient)
//   detected      — repo bar + detect-card (operations, inputs preview)
//   recover       — generic recovery (paste-URL / paste-spec / ask-Claude)
//   running       — sample run in flight (substate of detected)
//   previewed     — sample succeeded; sample output panel + visibility
//   publishing    — cascading live tail of publish steps
//   done          — success card + URL row + CTAs + Test gate
//   conflict      — slug collides with workspace apps (warn-amber chip)
//   private-repo  — private GitHub repo (Install Floom GitHub App)
//   pat-fallback  — alt path from private-repo (deferred / coming soon)
//
// Federico locks (override the wireframe):
//   - NO category tints (single neutral palette).
//   - Visibility chooser stays pre-publish (issue #635: A/B chooser
//     after sample run, before publish — NOT on the Done page).
//   - BYOK keys + Agent tokens vocabulary; never "API keys".
//   - Cascading-feed surfaces use `--code` warm-dark (#1b1a17), never
//     pure black.
//   - Auto-navigation on publish removed (Flag #4 default A): user
//     stays on /studio/build at step==='done' until they click a CTA.
//   - Starter examples roster: Competitor Lens / AI Readiness Audit /
//     Pitch Coach (NOT Slack-to-CRM / PDF parser per wireframe).
//
// Why the 10-state expansion? The previous 7-state machine surfaced
// all detect failures as a single generic <RecoverStep>. v23 promotes
// `private` (private-repo) and slug-collision (conflict) to first-class
// states with bespoke UI; the generic recover stays for everything
// else.

import type { CSSProperties } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useSession } from '../hooks/useSession';
import { useMyApps } from '../hooks/useMyApps';
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

// Federico-locked launch roster. Each starter pre-fills the input
// with a known-good detection target. `meta` is purely descriptive
// (shown under the card name); `value` is what we drop into the
// input + auto-submit, mirroring the previous chip behavior.
const STARTER_EXAMPLES: readonly { name: string; meta: string; value: string }[] = [
  { name: 'Competitor Lens', meta: 'python · Gemini · 1 action', value: 'resend/resend-openapi' },
  { name: 'AI Readiness Audit', meta: 'python · Gemini · 1 action', value: 'stripe/openapi' },
  { name: 'Pitch Coach', meta: 'python · Gemini · 1 action', value: 'PostHog/posthog' },
] as const;

type Visibility = 'public' | 'private' | 'auth-required';

type Step =
  | 'detect'
  | 'detecting'
  | 'detected'
  | 'recover'
  | 'running'
  | 'previewed'
  | 'publishing'
  | 'done'
  | 'conflict'
  | 'private-repo'
  | 'pat-fallback';

type ProgressLine = {
  id: string;
  label: string;
  status: 'pending' | 'ok' | 'fail' | 'info';
  ts?: number;
};

type DetectErrorKind =
  | 'private'
  | 'no-openapi'
  | 'unreachable'
  | 'repo-not-found'
  | 'bad-spec';

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
  const { apps: myApps } = useMyApps();

  const heroUrl = searchParams.get('ingest_url') ?? searchParams.get('openapi') ?? '';
  const editSlug = searchParams.get('edit');

  const [step, setStep] = useState<Step>('detect');
  const [url, setUrl] = useState(heroUrl);

  const [detected, setDetected] = useState<DetectedApp | null>(null);
  const [progress, setProgress] = useState<ProgressLine[]>([]);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [detectErrorKind, setDetectErrorKind] = useState<DetectErrorKind | null>(null);
  const [privateRepoUrl, setPrivateRepoUrl] = useState<string | null>(null);

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
  const [publishFeed, setPublishFeed] = useState<ProgressLine[]>([]);
  const [conflictSlug, setConflictSlug] = useState('');
  const [hasTestRun, setHasTestRun] = useState(false);

  // Recovery (paste URL / paste spec / ask Claude) — kept as fallback
  // for non-private-repo failures (unreachable, bad-spec, no-openapi,
  // repo-not-found). Same UI as the previous <RecoverStep>.
  const [recoveryMode, setRecoveryMode] = useState<'none' | 'direct-url' | 'paste' | 'prompt'>('none');
  const [directSpecUrl, setDirectSpecUrl] = useState('');
  const [pastedSpec, setPastedSpec] = useState('');
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const authReturnPath = location.pathname + location.search;

  // PAT fallback (deferred; UI shipped + disabled per Flag #2 default B).
  const [patValue, setPatValue] = useState('');

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
    setPrivateRepoUrl(null);
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
      setStep('recover');
      return;
    }
    appendProgress({ id: 'parse', label: `Parsing ${parsed.owner}/${parsed.repo}`, status: 'ok' });

    const probeId = 'repo-probe';
    appendProgress({ id: probeId, label: `Checking ${parsed.owner}/${parsed.repo} exists`, status: 'pending' });
    const existence = await checkRepoExists(parsed.owner, parsed.repo);
    if (existence.state === 'not-found') {
      updateProgress(probeId, 'fail');
      // 404 from GitHub anonymous API can mean either "doesn't exist"
      // or "private". Treat as private-repo first (better UX recovery
      // path). Federico-locked private-repo gets the dedicated state.
      setPrivateRepoUrl(`github.com/${parsed.owner}/${parsed.repo}`);
      setDetectErrorKind('private');
      setDetectError(null);
      setStep('private-repo');
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
    setStep('recover');
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
      setStep('recover');
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
    // Slug collision check (issue v23: promote 409 to first-class
    // earlier in the flow). Read from the cached useMyApps store so
    // we don't add a network round-trip.
    if (myApps && myApps.some((a) => a.slug === result.slug)) {
      setConflictSlug(suggestNextSlug(result.slug, myApps.map((a) => a.slug)));
      setStep('conflict');
    } else {
      setStep('detected');
    }
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
      // The app must exist in the DB before /api/run can dispatch it.
      // Pre-register as private so the sample run can resolve the slug.
      // ingestApp is idempotent — if the app already exists (e.g. user edited
      // slug after detection), this is a no-op returning created=false.
      // In cloud mode this requires auth — redirect to sign-up if not authed.
      try {
        await api.ingestApp({
          openapi_url: detected.openapi_spec_url,
          name,
          slug,
          description: description || undefined,
          category: category || undefined,
          visibility: 'private',
        });
      } catch (ingestErr) {
        const e = ingestErr as { status?: number; message?: string };
        if (e.status === 401) {
          navigate('/signup?next=' + encodeURIComponent(authReturnPath));
          return;
        }
        // Any other ingest failure (e.g. slug collision): surface as sample error.
        setSampleError(e.message || 'Could not register app for sample run.');
        setStep('detected');
        return;
      }
      const { run_id } = await api.startRun(slug, sampleInputs, undefined, sampleAction.name);
      setSampleRunId(run_id);
      const outcome = await pollRun(run_id);
      if (outcome.status === 'success') {
        setSampleOutput(outcome.outputs ?? null);
        setHasTestRun(true);
        setStep('previewed');
      } else {
        setSampleError(
          outcome.status === 'error'
            ? 'Sample run failed. Check the inputs and try again.'
            : 'Sample run timed out. Try again or simplify the inputs.',
        );
        setStep('detected');
      }
    } catch (err) {
      setSampleError((err as Error).message || 'Sample run failed.');
      setStep('detected');
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

  // Simulated publish stream (Flag #3 default B). We append visual
  // build steps via setTimeouts while the real /api/hub/ingest call
  // is in flight. The final OK/FAIL line is appended from the actual
  // response. Rationale: backend doesn't yet stream build events;
  // visual parity with v23 wireframe wins the launch demo.
  async function handlePublish() {
    if (!detected) return;
    if (!isAuthenticated) {
      navigate('/signup?next=' + encodeURIComponent(authReturnPath));
      return;
    }
    setStep('publishing');
    setPublishError(null);
    setPublishFeed([]);

    const fakeFeed: { delay: number; line: Omit<ProgressLine, 'ts'> }[] = [
      { delay: 60, line: { id: 'queue', label: 'queue accepted · build queued', status: 'ok' } },
      { delay: 220, line: { id: 'clone', label: 'cloning source', status: 'info' } },
      { delay: 480, line: { id: 'spec', label: 'spec valid · OpenAPI 3.x', status: 'ok' } },
      { delay: 720, line: { id: 'runtime', label: 'resolving runtime', status: 'info' } },
      { delay: 980, line: { id: 'deps', label: 'installing dependencies', status: 'info' } },
      { delay: 1500, line: { id: 'image', label: 'building docker image · sending build context', status: 'pending' } },
    ];
    const timers: ReturnType<typeof setTimeout>[] = [];
    const startedAt = performance.now();
    fakeFeed.forEach((entry) => {
      const t = setTimeout(() => {
        setPublishFeed((prev) => [
          ...prev,
          { ...entry.line, ts: Math.round(performance.now() - startedAt) },
        ]);
      }, entry.delay);
      timers.push(t);
    });

    try {
      await api.ingestApp({
        openapi_url: detected.openapi_spec_url,
        name,
        slug,
        description,
        category: category || undefined,
        visibility,
      });
      timers.forEach(clearTimeout);
      setPublishFeed((prev) => [
        ...prev,
        {
          id: 'register',
          label: 'app registered · live',
          status: 'ok',
          ts: Math.round(performance.now() - startedAt),
        },
      ]);
      markJustPublished(slug);
      // Federico-lock (Flag #4 default A): NO auto-navigation. The
      // user clicks Open / Edit / Share themselves on the Done card.
      setStep('done');
    } catch (err) {
      timers.forEach(clearTimeout);
      // 409 collision at publish time: kick to conflict state.
      if (err instanceof api.ApiError && err.status === 409) {
        setConflictSlug(
          suggestNextSlug(
            slug,
            (myApps ?? []).map((a) => a.slug),
          ),
        );
        setStep('conflict');
        return;
      }
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

  function handleConflictContinue(newSlug: string) {
    setSlug(newSlug);
    setConflictSlug('');
    if (detected) {
      setStep('detected');
    } else {
      setStep('detect');
    }
  }

  function resetToPaste() {
    setStep('detect');
    setDetectErrorKind(null);
    setDetectError(null);
    setPrivateRepoUrl(null);
    setRecoveryMode('none');
    setProgress([]);
    setPublishFeed([]);
    setPublishError(null);
    setSampleError(null);
    setSampleOutput(null);
    setSampleRunId(null);
    setHasTestRun(false);
    setDetected(null);
  }

  if (deployEnabled === false) {
    return (
      <Layout title="Join the waitlist | Floom">
        <div style={{ maxWidth: 560, margin: '48px auto', padding: 24 }}>
          <h1 style={legacyH1Style}>Deploy is on the waitlist</h1>
          <p style={{ color: 'var(--muted)', lineHeight: 1.6 }}>
            We&rsquo;re rolling Deploy out slowly for launch week. Drop your
            email on the waitlist and we&rsquo;ll let you know when your slot
            opens.
          </p>
        </div>
      </Layout>
    );
  }

  // 4-stage chip mapping: stage index + status (on/done/warn).
  const stageState = stageStatesFor(step);

  return (
    <Layout title="Publish an app | Floom">
      <div data-testid="build-page" data-step={step} className="build-wrap">
        <BuildHeader step={step} slug={slug} privateRepoUrl={privateRepoUrl} editSlug={editSlug} />
        <BuildStages stages={stageState} />

        {step === 'detect' && (
          <DetectStep
            url={url}
            setUrl={setUrl}
            onSubmit={(next) => submitDetect(next ?? url)}
            sessionLoading={sessionLoading}
            cloudMode={cloudMode}
            isAuthenticated={isAuthenticated}
            onPickStarter={(value) => {
              setUrl(value);
              void submitDetect(value);
            }}
            onUseGithubApp={() => {
              setPrivateRepoUrl(null);
              setStep('private-repo');
            }}
          />
        )}

        {step === 'detecting' && <DetectingStep progress={progress} />}

        {step === 'recover' && detectErrorKind && (
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
            onReset={resetToPaste}
          />
        )}

        {step === 'private-repo' && (
          <PrivateRepoStep
            repoUrl={privateRepoUrl ?? url}
            onUsePublic={resetToPaste}
            onUsePat={() => setStep('pat-fallback')}
            onPasteSpec={() => {
              setStep('recover');
              setRecoveryMode('paste');
              if (!detectErrorKind) setDetectErrorKind('private');
            }}
          />
        )}

        {step === 'pat-fallback' && (
          <PatFallbackStep
            patValue={patValue}
            setPatValue={setPatValue}
            onBack={() => setStep('private-repo')}
            onCancel={resetToPaste}
          />
        )}

        {step === 'conflict' && (
          <ConflictStep
            takenSlug={slug}
            initialNewSlug={conflictSlug}
            existingSlugs={(myApps ?? []).map((a) => a.slug)}
            onBackToPaste={resetToPaste}
            onContinue={handleConflictContinue}
          />
        )}

        {step === 'detected' && detected && (
          <DetectedStep
            detected={detected}
            url={url}
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
            onChangeRepo={resetToPaste}
          />
        )}

        {step === 'running' && <RunningStep sampleRunId={sampleRunId} />}

        {step === 'previewed' && detected && (
          <PreviewedStep
            slug={slug}
            sampleOutput={sampleOutput}
            visibility={visibility}
            setVisibility={setVisibility}
            onPublish={handlePublish}
            error={publishError}
            onEdit={() => setStep('detected')}
          />
        )}

        {step === 'publishing' && (
          <PublishingStep visibility={visibility} feed={publishFeed} slug={slug} />
        )}

        {step === 'done' && (
          <DoneStep
            slug={slug}
            visibility={visibility}
            hasTestRun={hasTestRun}
            postPublishHref={postPublishHref}
          />
        )}
      </div>
    </Layout>
  );
}

/* ---------- header + chip row ---------- */

function BuildHeader({
  step,
  slug,
  privateRepoUrl,
  editSlug,
}: {
  step: Step;
  slug: string;
  privateRepoUrl: string | null;
  editSlug: string | null;
}) {
  if (editSlug) {
    return (
      <div className="build-head">
        <h1>
          Edit <span className="accent">{editSlug}</span>
        </h1>
        <p>Update the source, re-run a sample, then re-publish. Your slug stays the same.</p>
      </div>
    );
  }
  if (step === 'detected' || step === 'running' || step === 'previewed') {
    return (
      <div className="build-head">
        <h1>
          Looks good. <span className="accent">Ready to publish.</span>
        </h1>
        <p>Floom found everything it needs. Review the detection, then ship.</p>
      </div>
    );
  }
  if (step === 'publishing') {
    return (
      <div className="build-head">
        <h1>
          Publishing <span className="accent">{slug || 'your app'}</span>&hellip;
        </h1>
        <p>Hang tight. About 90 seconds. Don&rsquo;t close the tab.</p>
      </div>
    );
  }
  if (step === 'done') {
    return (
      <div className="build-head">
        <h1>
          Published. <span className="accent">Live.</span>
        </h1>
        <p>{slug} is running on Floom. Open it, share it, or tune the details.</p>
      </div>
    );
  }
  if (step === 'conflict') {
    return (
      <div className="build-head">
        <h1>
          Pick a different <span className="warn">slug.</span>
        </h1>
        <p>
          You already have an app with this slug. Rename this one or update the existing app
          instead.
        </p>
      </div>
    );
  }
  if (step === 'private-repo') {
    return (
      <div className="build-head">
        <h1>
          This repo is <span className="accent">private.</span>
        </h1>
        <p>
          Install the Floom GitHub App on the repos you want Floom to deploy. Fine-grained,
          revocable, audit-friendly.
        </p>
      </div>
    );
  }
  if (step === 'pat-fallback') {
    return (
      <div className="build-head">
        <h1>
          Paste a <span className="accent">GitHub PAT.</span>
        </h1>
        <p>
          If you can&rsquo;t install the Floom GitHub App, paste a Personal Access Token. Floom uses
          it once to clone, then stores it encrypted for auto-rebuild.
        </p>
      </div>
    );
  }
  if (step === 'recover') {
    return (
      <div className="build-head">
        <h1>
          We hit a <span className="warn">snag.</span>
        </h1>
        <p>
          Paste the spec directly, point at a different URL, or generate one with your AI tool. We&rsquo;ll
          pick up from there.
        </p>
      </div>
    );
  }
  return (
    <div className="build-head">
      <h1>
        Publish a new app in <span className="accent">one paste.</span>
      </h1>
      <p>Drop a GitHub URL or floom.yaml. Floom detects, builds, deploys. About 90 seconds end-to-end.</p>
      <span style={{ display: 'none' }} data-testid="build-hero-marker" data-accent="true" />
    </div>
  );
  // privateRepoUrl preserved for future header variants; suppress unused.
  void privateRepoUrl;
}

type StageStatus = 'on' | 'done' | 'warn' | 'idle';

function stageStatesFor(step: Step): StageStatus[] {
  // 4 stages: Paste / Detect / Publish / Done.
  switch (step) {
    case 'detect':
      return ['on', 'idle', 'idle', 'idle'];
    case 'detecting':
      return ['done', 'on', 'idle', 'idle'];
    case 'recover':
      return ['done', 'warn', 'idle', 'idle'];
    case 'detected':
    case 'running':
    case 'previewed':
      return ['done', 'on', 'idle', 'idle'];
    case 'conflict':
    case 'private-repo':
    case 'pat-fallback':
      return ['done', 'warn', 'idle', 'idle'];
    case 'publishing':
      return ['done', 'done', 'on', 'idle'];
    case 'done':
      return ['done', 'done', 'done', 'done'];
  }
}

function BuildStages({ stages }: { stages: StageStatus[] }) {
  const labels = ['Paste', 'Detect', 'Publish', 'Done'];
  return (
    <div className="build-stages" data-testid="build-stages" role="list">
      {labels.map((label, i) => {
        const status = stages[i];
        const cls = status === 'idle' ? 'stage' : `stage ${status}`;
        const numChar = status === 'done' ? '✓' : status === 'warn' ? '!' : String(i + 1);
        const display = status === 'done' ? `✓ ${i + 1}. ${label}` : `${i + 1}. ${label}`;
        return (
          <span key={label} role="listitem" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span
              className={cls}
              data-testid={`step-cell-${i}`}
              data-active={status === 'on' ? 'true' : 'false'}
              data-done={status === 'done' ? 'true' : 'false'}
              data-warn={status === 'warn' ? 'true' : 'false'}
              aria-label={display}
            >
              <span className="num">{numChar}</span>
              {label}
            </span>
            {i < labels.length - 1 && (
              <span className="arr" aria-hidden="true">
                →
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

/* ---------- stage 1: paste ---------- */

function DetectStep({
  url,
  setUrl,
  onSubmit,
  sessionLoading,
  cloudMode,
  isAuthenticated,
  onPickStarter,
  onUseGithubApp,
}: {
  url: string;
  setUrl: (v: string) => void;
  onSubmit: (override?: string) => void;
  sessionLoading: boolean;
  cloudMode: boolean;
  isAuthenticated: boolean;
  onPickStarter: (value: string) => void;
  onUseGithubApp: () => void;
}) {
  const authRequired = cloudMode && !isAuthenticated;
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
        className="paste-card"
      >
        <div className="lab">Paste a GitHub URL or floom.yaml</div>
        <div className="big-input">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
          </svg>
          <input
            id="build-url-input"
            data-testid="build-url-input"
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="github.com/your-name/your-app · or paste a floom.yaml URL"
            autoFocus
          />
          <button
            type="submit"
            data-testid="build-detect-submit"
            className="submit"
            disabled={!url || sessionLoading}
          >
            Continue
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </button>
        </div>
        <p className="alt-line">
          Or{' '}
          <button type="button" onClick={() => onSubmit()} data-testid="alt-upload-yaml">
            upload a floom.yaml directly
          </button>{' '}
          · Or{' '}
          <button
            type="button"
            className="accent"
            onClick={onUseGithubApp}
            data-testid="alt-install-gh-app"
          >
            install Floom GitHub App for private repos →
          </button>
        </p>
      </form>

      <div className="examples" data-testid="build-starter-examples">
        <div className="title">Try a starter · pre-filled YAML</div>
        <div className="ex-row">
          {STARTER_EXAMPLES.map((ex) => (
            <button
              key={ex.name}
              type="button"
              className="ex-card"
              data-testid={`ex-card-${slugify(ex.name)}`}
              onClick={() => onPickStarter(ex.value)}
            >
              <div className="ex-nm">{ex.name}</div>
              <div className="ex-meta">{ex.meta}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------- stage 2 in flight: cascading feed ---------- */

function DetectingStep({ progress }: { progress: ProgressLine[] }) {
  return (
    <div
      data-testid="build-step-detecting"
      style={{
        background: 'var(--code)',
        color: 'var(--code-text)',
        border: '1px solid #2b2a24',
        borderRadius: 12,
        padding: '20px 22px',
        fontFamily: 'var(--font-mono)',
        fontSize: 13,
        lineHeight: 1.7,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: 'var(--code-mute)',
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
            <span style={{ color: line.status === 'fail' ? '#f0a5a0' : 'var(--code-text)' }}>
              {line.label}
            </span>
          </li>
        ))}
        {progress.length === 0 && <li style={{ color: 'var(--code-mute)' }}>Starting…</li>}
      </ul>
    </div>
  );
}

function statusColor(s: ProgressLine['status']) {
  if (s === 'ok') return 'var(--accent, #10b981)';
  if (s === 'fail') return '#f0a5a0';
  if (s === 'info') return '#93c5fd';
  return 'var(--code-mute)';
}
function statusGlyph(s: ProgressLine['status']) {
  if (s === 'ok') return '✓';
  if (s === 'fail') return '✗';
  return '·';
}

/* ---------- stage 2 detected ---------- */

function DetectedStep({
  detected,
  url,
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
  onChangeRepo,
}: {
  detected: DetectedApp;
  url: string;
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
  onChangeRepo: () => void;
}) {
  const repoLabel = useMemo(() => shortUrl(url || detected.openapi_spec_url || ''), [url, detected]);
  const ops = (detected.actions as Action[]) ?? [];
  return (
    <div data-testid="build-step-detected" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="repo-bar" data-testid="detected-repo-bar">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.335-1.755-1.335-1.755-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
        </svg>
        <div className="repo">
          <strong data-testid="detected-repo-label">{repoLabel || 'detected app'}</strong>
          <div className="meta">
            slug: <code style={{ fontFamily: 'var(--font-mono)' }}>{slug}</code> · auth:{' '}
            <code style={{ fontFamily: 'var(--font-mono)' }}>{detected.auth_type || 'none'}</code>
          </div>
        </div>
        <button type="button" className="change-link" onClick={onChangeRepo} data-testid="detected-change">
          Change →
        </button>
      </div>

      <section className="detect-card" data-testid="detected-card">
        <h2>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          Detected{' '}
          <code style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 500 }}>
            {detected.openapi_spec_url ? shortUrl(detected.openapi_spec_url) : 'spec'}
          </code>
        </h2>

        <div className="detect-list" data-testid="detected-ops-list">
          <div className="item">
            <svg className="ic" viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span className="lab">App name</span>
            <span className="val">
              <strong>{name || 'Untitled app'}</strong>
            </span>
          </div>
          <div className="item">
            <svg className="ic" viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span className="lab">Operations</span>
            <span className="val">
              {detected.tools_count} {detected.tools_count === 1 ? 'action' : 'actions'}
              {ops.length > 0 && ': '}
              {ops.slice(0, 3).map((a, i) => (
                <span key={a.name}>
                  {i > 0 && ', '}
                  <code>{a.name}</code>
                </span>
              ))}
              {ops.length > 3 && (
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                  {' '}
                  &middot; +{ops.length - 3} more
                </span>
              )}
            </span>
          </div>
          {sampleAction && (
            <div className="item">
              <svg className="ic" viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span className="lab">Sample inputs</span>
              <span className="val">
                <SampleInputs action={sampleAction} values={sampleInputs} setValues={setSampleInputs} />
              </span>
            </div>
          )}
          {description && (
            <div className="item">
              <svg className="ic" viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span className="lab">Description</span>
              <span className="val" style={{ fontSize: 12.5 }}>
                {firstSentence(description)}
              </span>
            </div>
          )}
        </div>

        {ops.length > 1 && (
          <div style={{ marginBottom: 12 }}>
            <label
              style={{
                fontSize: 11,
                color: 'var(--muted)',
                fontWeight: 600,
                display: 'block',
                marginBottom: 6,
                fontFamily: 'var(--font-mono)',
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
              }}
            >
              Sample operation
            </label>
            <select
              data-testid="sample-action-picker"
              value={sampleAction?.name || ''}
              onChange={(e) => {
                const next = ops.find((a) => a.name === e.target.value);
                if (next) setSampleAction(next);
              }}
              style={{
                padding: '8px 10px',
                border: '1px solid var(--line)',
                borderRadius: 8,
                background: 'var(--card)',
                fontSize: 13,
                fontFamily: 'var(--font-mono)',
                color: 'var(--ink)',
                minWidth: 260,
              }}
            >
              {ops.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {sampleError && (
          <div
            data-testid="sample-error"
            style={{
              margin: '12px 0',
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

        <div className="publish-row">
          <button
            type="button"
            data-testid="back-to-paste"
            onClick={onChangeRepo}
            style={legacyGhostButton}
          >
            ← Re-pick repo
          </button>
          <span className="meta">
            <strong>Default visibility:</strong> set after the sample run.
          </span>
          <button
            type="button"
            data-testid="run-sample-btn"
            onClick={onRunSample}
            disabled={!sampleAction}
            style={{
              ...legacyAccentButton,
              opacity: sampleAction ? 1 : 0.55,
              cursor: sampleAction ? 'pointer' : 'not-allowed',
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
    return <span style={{ fontSize: 12, color: 'var(--muted)' }}>no inputs · ready to run</span>;
  }
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 8 }}>
      {fields.slice(0, 3).map(([key, def]) => (
        <code key={key} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {key}
          <input
            data-testid={`sample-input-${key}`}
            value={String(values[key] ?? '')}
            onChange={(e) => setValues({ ...values, [key]: e.target.value })}
            placeholder={def.description || key}
            style={{
              padding: '4px 8px',
              border: '1px solid var(--line)',
              borderRadius: 6,
              fontSize: 11.5,
              fontFamily: 'var(--font-mono)',
              maxWidth: 180,
            }}
          />
        </code>
      ))}
      {fields.length > 3 && <span style={{ fontSize: 11, color: 'var(--muted)' }}>+{fields.length - 3} more</span>}
    </span>
  );
}

/* ---------- stage 2: running (sample) ---------- */

function RunningStep({ sampleRunId }: { sampleRunId: string | null }) {
  const [showTechnical, setShowTechnical] = useState(false);
  // Elapsed timer (Federico-locked: friendly running state, no fake
  // step counters — show elapsed seconds instead). Updates 4x/second.
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAtRef = useRef<number>(performance.now());
  useEffect(() => {
    startedAtRef.current = performance.now();
    setElapsedMs(0);
    const id = setInterval(() => {
      setElapsedMs(performance.now() - startedAtRef.current);
    }, 250);
    return () => clearInterval(id);
  }, []);
  const elapsedLabel = (elapsedMs / 1000).toFixed(1);
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
          background: 'var(--code)',
          color: 'var(--code-text)',
          borderRadius: 10,
          fontFamily: 'var(--font-mono)',
          fontSize: 13,
        }}
      >
        <Spinner />
        <span>Running sample…</span>
        <span data-testid="running-elapsed" style={{ color: 'var(--code-mute)', marginLeft: 4 }}>
          {elapsedLabel}s
        </span>
      </div>
      <p style={{ marginTop: 14, fontSize: 12.5, color: 'var(--muted)' }}>
        This usually takes a few seconds.
      </p>
      <button
        type="button"
        onClick={() => setShowTechnical((v) => !v)}
        style={{
          marginTop: 8,
          background: 'none',
          border: 0,
          color: 'var(--muted)',
          fontSize: 11.5,
          textDecoration: 'underline',
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        {showTechnical ? 'Hide technical details' : 'Show technical details'}
      </button>
      {showTechnical && sampleRunId && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
          run id: {sampleRunId}
        </div>
      )}
    </div>
  );
}

/* ---------- stage 2: previewed (sample succeeded) ---------- */

function PreviewedStep({
  slug,
  sampleOutput,
  visibility,
  setVisibility,
  onPublish,
  error,
  onEdit,
}: {
  slug: string;
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
          border: '1px solid var(--accent-border)',
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
            color: 'var(--accent)',
            fontWeight: 700,
            letterSpacing: '0.02em',
            textTransform: 'uppercase',
            marginBottom: 12,
          }}
        >
          ✓ Sample ran successfully
        </div>
        <div style={{ fontSize: 14, color: 'var(--ink)', fontWeight: 600, marginBottom: 8 }}>Output</div>
        <pre
          data-testid="sample-output-preview"
          style={{
            margin: 0,
            padding: '12px 14px',
            background: 'var(--code)',
            color: 'var(--code-text)',
            borderRadius: 8,
            fontSize: 12.5,
            fontFamily: 'var(--font-mono)',
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
            disabled={!slug}
            style={{
              ...legacyAccentButton,
              opacity: !slug ? 0.55 : 1,
              cursor: !slug ? 'not-allowed' : 'pointer',
            }}
          >
            {publishLabel(visibility, slug)}
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

/* ---------- stage 3: publishing (live tail) ---------- */

function PublishingStep({
  visibility,
  feed,
  slug,
}: {
  visibility: Visibility;
  feed: ProgressLine[];
  slug: string;
}) {
  const elapsedMs = feed.length > 0 ? feed[feed.length - 1].ts ?? 0 : 0;
  const last = feed[feed.length - 1];
  const headline = last?.label ?? 'Queueing build…';
  // Build sub-step state derived from progress feed.
  const subSteps = [
    { id: 'clone', label: 'Cloning', done: feed.some((l) => l.id === 'clone' || l.id === 'spec') },
    { id: 'spec', label: 'Spec valid', done: feed.some((l) => l.id === 'spec') },
    { id: 'image', label: 'Building image', done: feed.some((l) => l.id === 'register') },
    { id: 'register', label: 'Registering app', done: feed.some((l) => l.id === 'register') },
  ];
  const onIndex = subSteps.findIndex((s) => !s.done);
  return (
    <div className="live-card" data-testid="build-step-publishing" role="status" aria-live="polite">
      <div className="live-bar">
        <span className="sp" aria-hidden="true" />
        <span>{headline}</span>
        <span className="elapsed">
          {(elapsedMs / 1000).toFixed(2)}s · publishing {visibility}
        </span>
      </div>
      <div className="build-tail" data-testid="publish-feed">
        {feed.length === 0 ? (
          <div className="l">
            <span className="t">[0.00s]</span>
            <span className="info">[INFO]</span>
            <span>preparing build for {slug}</span>
            <span className="cur" />
          </div>
        ) : (
          feed.map((line) => (
            <div key={line.id} className="l" data-testid={`publish-line-${line.id}`}>
              <span className="t">[{((line.ts ?? 0) / 1000).toFixed(2)}s]</span>
              <span className={tailKind(line.status)}>[{tailLabel(line.status)}]</span>
              <span>{line.label}</span>
              {line === last && line.status !== 'ok' && <span className="cur" />}
            </div>
          ))
        )}
      </div>
      <div className="substeps">
        {subSteps.map((s, i) => (
          <div
            key={s.id}
            className={`step ${s.done ? 'done' : i === onIndex ? 'on' : ''}`}
            data-testid={`substep-${s.id}`}
          >
            <span className="lab">
              {s.done ? `✓ ${i + 1} of ${subSteps.length}` : i === onIndex ? 'In progress' : `Step ${i + 1} of ${subSteps.length}`}
            </span>
            <span className="nm">{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function tailKind(s: ProgressLine['status']): string {
  if (s === 'ok') return 'ok';
  if (s === 'fail') return 'fail';
  if (s === 'pending') return 'pending';
  return 'info';
}
function tailLabel(s: ProgressLine['status']): string {
  if (s === 'ok') return 'OK';
  if (s === 'fail') return 'FAIL';
  if (s === 'pending') return 'BUILD';
  return 'INFO';
}

/* ---------- stage 4: done ---------- */

function DoneStep({
  slug,
  visibility,
  hasTestRun,
  postPublishHref,
}: {
  slug: string;
  visibility: Visibility;
  hasTestRun: boolean;
  postPublishHref?: (slug: string) => string;
}) {
  const editHref = postPublishHref ? postPublishHref(slug) : `/studio/${slug}`;
  const url = `floom.dev/p/${slug}`;
  function handleCopyUrl() {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(`https://${url}`);
    }
  }
  return (
    <div className="success-card" data-testid="build-step-done">
      <div className="badge" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>
      <h2 data-testid="done-headline">
        Published as {visibility.toUpperCase()}. Test it first.
      </h2>
      <div className="meta">
        v0.1.0 · visibility: {visibility.toUpperCase()} · {visibilityDoneCopy(visibility)}
      </div>

      {!hasTestRun && (
        <div className="build-test-gate" data-testid="build-test-gate">
          <div className="glyph" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <div>
            <strong>Run a test before sharing publicly.</strong>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              A successful test run unlocks public-store visibility.
            </div>
          </div>
          <div className="gate-actions">
            <a href={`/p/${slug}`} data-testid="run-test-link">
              Run a test →
            </a>
          </div>
        </div>
      )}

      <div className="url-row" data-testid="done-url-row">
        <span className="l">URL</span>
        <span className="v">{url}</span>
        <button type="button" onClick={handleCopyUrl} data-testid="copy-url">
          Copy
        </button>
        <a
          className="primary"
          href={`/p/${slug}`}
          data-testid="open-app-inline"
          style={{
            background: 'var(--ink)',
            color: '#fff',
            border: '1px solid var(--ink)',
            borderRadius: 6,
            padding: '5px 10px',
            fontSize: 11,
            fontWeight: 600,
            textDecoration: 'none',
            display: 'inline-flex',
            alignItems: 'center',
          }}
        >
          Open →
        </a>
      </div>

      <div className="ctas">
        <a
          href={`/p/${slug}`}
          data-testid="done-open-app"
          style={{
            ...legacyAccentButton,
            textDecoration: 'none',
            display: 'inline-flex',
            alignItems: 'center',
          }}
        >
          Open {slug} →
        </a>
        <a
          href={editHref}
          data-testid="done-edit-details"
          style={{ ...legacyGhostButton, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
        >
          Edit details
        </a>
        <button type="button" data-testid="done-share" onClick={handleCopyUrl} style={legacyGhostButton}>
          Share · copy link
        </button>
      </div>

      <div className="next-up">
        <h3>Now what?</h3>
        <div className="grid">
          <a href={`/studio/${slug}/secrets`} data-testid="next-secrets">
            <strong>Add secrets</strong>
            <span>BYOK keys (e.g. GEMINI_API_KEY) need to be set before the first run.</span>
          </a>
          <a href={`/studio/${slug}/access`} data-testid="next-access">
            <strong>Set visibility</strong>
            <span>Currently {visibility}. Open to a link, invitees, or the store.</span>
          </a>
          <a href={`/studio/${slug}`} data-testid="next-overview">
            <strong>Edit name &amp; slug</strong>
            <span>Tune the title, description, icon. Slug rename keeps redirects.</span>
          </a>
        </div>
      </div>
    </div>
  );
}

/* ---------- conflict ---------- */

function ConflictStep({
  takenSlug,
  initialNewSlug,
  existingSlugs,
  onBackToPaste,
  onContinue,
}: {
  takenSlug: string;
  initialNewSlug: string;
  existingSlugs: string[];
  onBackToPaste: () => void;
  onContinue: (newSlug: string) => void;
}) {
  const [val, setVal] = useState(initialNewSlug || `${takenSlug}-2`);
  const isAvailable = val.trim().length > 0 && !existingSlugs.includes(val.trim());
  const suggestions = useMemo(
    () => buildSuggestSlugs(takenSlug, existingSlugs).slice(0, 5),
    [takenSlug, existingSlugs],
  );
  return (
    <div className="conflict-card" data-testid="build-step-conflict">
      <div className="head">
        <span className="ic" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          </svg>
        </span>
        <div>
          <h2>This slug is taken in your workspace.</h2>
          <p>
            The slug becomes the URL. We can&rsquo;t have two apps at the same address. Pick a new slug
            below or update the existing app.
          </p>
        </div>
      </div>

      <div className="occupied-row" data-testid="conflict-existing">
        <span className="url">floom.dev/p/{takenSlug}</span>
        <span className="by">by you</span>
        <span className="badge">EXISTING</span>
      </div>

      <div className="slug-edit">
        <label htmlFor="conflict-slug">New slug</label>
        <div className="slug-row">
          <span className="pre">floom.dev/p/</span>
          <input
            id="conflict-slug"
            data-testid="conflict-slug-input"
            type="text"
            value={val}
            onChange={(e) => setVal(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
          />
          <span className={`check ${isAvailable ? '' : 'taken'}`} data-testid="conflict-availability">
            {isAvailable ? (
              <>
                <svg viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Available
              </>
            ) : (
              'Taken'
            )}
          </span>
        </div>
        <p className="suggest">
          <strong>Or pick one:</strong>{' '}
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              className="chip"
              data-testid={`conflict-suggest-${s}`}
              onClick={() => setVal(s)}
            >
              {s}
            </button>
          ))}
        </p>
      </div>

      <div className="ctas">
        <button type="button" onClick={onBackToPaste} style={legacyGhostButton} data-testid="conflict-back">
          ← Back to paste
        </button>
        <button
          type="button"
          onClick={() => onContinue(val.trim())}
          disabled={!isAvailable}
          style={{
            ...legacyAccentButton,
            opacity: isAvailable ? 1 : 0.55,
            cursor: isAvailable ? 'pointer' : 'not-allowed',
          }}
          data-testid="conflict-continue"
        >
          Continue with new slug →
        </button>
      </div>
    </div>
  );
}

function buildSuggestSlugs(base: string, existing: string[]): string[] {
  const taken = new Set(existing);
  const out: string[] = [];
  for (let i = 2; i <= 10 && out.length < 8; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) out.push(candidate);
  }
  for (const suffix of ['-v2', '-app', '-new', '-pro']) {
    const candidate = `${base}${suffix}`;
    if (!taken.has(candidate) && !out.includes(candidate)) out.push(candidate);
  }
  return out;
}

function suggestNextSlug(base: string, existing: string[]): string {
  return buildSuggestSlugs(base, existing)[0] ?? `${base}-2`;
}

/* ---------- private repo ---------- */

function PrivateRepoStep({
  repoUrl,
  onUsePublic,
  onUsePat,
  onPasteSpec,
}: {
  repoUrl: string;
  onUsePublic: () => void;
  onUsePat: () => void;
  onPasteSpec: () => void;
}) {
  // Flag #2 default B: the GitHub App install endpoint is gated. If
  // the env doesn't expose VITE_GITHUB_APP_INSTALL_URL we render the
  // CTA disabled with "Coming soon" framing and steer to paste-spec.
  const installUrl =
    typeof import.meta !== 'undefined'
      ? ((import.meta as { env?: { VITE_GITHUB_APP_INSTALL_URL?: string } }).env?.VITE_GITHUB_APP_INSTALL_URL ??
        '')
      : '';
  const installEnabled = !!installUrl;
  return (
    <div className="lock-card" data-testid="build-step-private-repo">
      <div className="lock-head">
        <span className="ic" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </span>
        <div>
          <h2 data-testid="private-repo-url">{shortUrl(repoUrl) || 'this repo'}</h2>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: '4px 0 0', lineHeight: 1.5 }}>
            We can&rsquo;t read this repo without permission. Floom never clones repos it wasn&rsquo;t
            explicitly granted.
          </p>
          <div className="lock-meta">private · not yet authorized for this workspace</div>
        </div>
      </div>

      {installEnabled ? (
        <a className="install-cta" href={installUrl} data-testid="install-gh-app-cta">
          <div className="row">
            <span className="gh">
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 0a12 12 0 0 0-3.79 23.4c.6.11.82-.26.82-.58v-2.04c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.74.08-.73.08-.73 1.21.09 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.66-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.25 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.63-5.49 5.93.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.83.58A12 12 0 0 0 12 0z" />
              </svg>
            </span>
            <div className="label-stack">
              <div className="label-top">RECOMMENDED</div>
              <div className="label-main">Install Floom GitHub App</div>
            </div>
            <span className="arr">→</span>
          </div>
        </a>
      ) : (
        <button
          type="button"
          className="install-cta"
          disabled
          aria-disabled="true"
          data-testid="install-gh-app-disabled"
        >
          <div className="row">
            <span className="gh">
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 0a12 12 0 0 0-3.79 23.4c.6.11.82-.26.82-.58v-2.04c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.74.08-.73.08-.73 1.21.09 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.66-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.25 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.63-5.49 5.93.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.83.58A12 12 0 0 0 12 0z" />
              </svg>
            </span>
            <div className="label-stack">
              <div className="label-top">COMING SOON</div>
              <div className="label-main">Install Floom GitHub App</div>
            </div>
            <span className="arr">→</span>
          </div>
        </button>
      )}

      <div className="perms">
        <h4>What Floom asks for</h4>
        <ul>
          <li>
            <svg viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            Read repository contents <span className="role">· clone source for builds</span>
          </li>
          <li>
            <svg viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            Read commit metadata <span className="role">· show last commit on Source tab</span>
          </li>
          <li>
            <svg viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            Receive webhooks <span className="role">· auto-rebuild on push</span>
          </li>
        </ul>
        <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '10px 0 0', lineHeight: 1.55 }}>
          <strong style={{ color: 'var(--ink)' }}>Floom never asks for:</strong> write access, issue
          access, secrets, account-level permissions. Pick exactly which repos to grant — it&rsquo;s
          not all-or-nothing.
        </p>
      </div>

      <div className="alt-block">
        {!installEnabled && (
          <p style={{ margin: '0 0 10px' }}>
            <strong>Coming soon.</strong> While the Floom GitHub App is being rolled out, the
            fastest path is to{' '}
            <button type="button" onClick={onPasteSpec} data-testid="private-repo-paste-spec">
              paste your floom.yaml directly
            </button>
            .
          </p>
        )}
        <p style={{ margin: 0 }}>
          <button type="button" onClick={onUsePublic} data-testid="private-repo-use-public">
            ← Use a public repo instead
          </button>
          {' · '}
          <button type="button" onClick={onUsePat} data-testid="private-repo-use-pat">
            Use a personal access token instead →
          </button>
        </p>
      </div>
    </div>
  );
}

/* ---------- pat fallback ---------- */

function PatFallbackStep({
  patValue,
  setPatValue,
  onBack,
  onCancel,
}: {
  patValue: string;
  setPatValue: (v: string) => void;
  onBack: () => void;
  onCancel: () => void;
}) {
  // Backend doesn't support PAT clone today (decision-doc Defer #23).
  // Render UI for parity but disable Validate. Federico-locked
  // "Coming soon" framing, not a fake submit.
  return (
    <div className="pat-card" data-testid="build-step-pat-fallback">
      <span className="pat-lab">Personal Access Token</span>
      <div className="pat-input">
        <input
          type="password"
          placeholder="ghp_… (paste fine-grained token)"
          value={patValue}
          onChange={(e) => setPatValue(e.target.value)}
          data-testid="pat-input"
        />
        <button type="button" disabled aria-disabled="true" data-testid="pat-validate">
          Validate →
        </button>
      </div>

      <div className="scope-needs">
        <strong>Scopes required:</strong> <code>repo</code> (private repo read) and{' '}
        <code>read:user</code>.
        <br />
        Floom validates the token, lists the repos it can read, and refuses to use it for anything
        beyond the scopes above.
      </div>

      <div className="warn-strip">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        </svg>
        <div>
          <strong>Coming soon.</strong> PAT-based clone is queued for the next backend ship. While
          we finish wiring it up, the GitHub App install path (when it launches) will be safer
          anyway. For now, paste the spec directly via{' '}
          <button
            type="button"
            onClick={onCancel}
            style={{
              background: 'none',
              border: 0,
              padding: 0,
              color: 'var(--ink)',
              textDecoration: 'underline',
              fontWeight: 600,
              cursor: 'pointer',
              fontSize: 'inherit',
              fontFamily: 'inherit',
            }}
          >
            Start over
          </button>{' '}
          and choose &ldquo;upload a floom.yaml directly&rdquo;.
        </div>
      </div>

      <p className="gen-link">
        Need a token? <a href="https://github.com/settings/tokens/new?scopes=repo,read:user&description=Floom" target="_blank" rel="noreferrer">Generate one on GitHub →</a> · pre-filled with the right scopes.
      </p>

      <div className="ctas">
        <button type="button" onClick={onBack} style={legacyGhostButton} data-testid="pat-back">
          ← Use GitHub App
        </button>
        <button type="button" onClick={onCancel} style={legacyGhostButton} data-testid="pat-cancel">
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ---------- recovery (generic non-private failures) ---------- */

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
              style={{ ...textareaStyle, fontFamily: 'var(--font-mono)', fontSize: 12.5 }}
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
              Copy this prompt into Claude or Cursor. It&rsquo;ll generate an openapi.yaml for your repo.
            </p>
            <pre
              style={{
                padding: '12px 14px',
                background: 'var(--code)',
                color: 'var(--code-text)',
                borderRadius: 8,
                fontSize: 12,
                fontFamily: 'var(--font-mono)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {PROMPT_TEMPLATE}
            </pre>
          </div>
        )}
      </section>

      <button type="button" data-testid="recover-reset" onClick={onReset} style={legacyGhostButton}>
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

/* ---------- shared helpers (kept from previous BuildPage) ---------- */

const legacyH1Style: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontSize: 32,
  fontWeight: 800,
  letterSpacing: '-0.025em',
  lineHeight: 1.1,
  margin: '0 0 8px',
  color: 'var(--ink)',
};

const legacyAccentButton: CSSProperties = {
  padding: '12px 22px',
  background: 'var(--accent, #10b981)',
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 600,
  fontFamily: 'inherit',
  cursor: 'pointer',
};

const legacyGhostButton: CSSProperties = {
  padding: '10px 16px',
  background: 'transparent',
  color: 'var(--ink)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 500,
  fontFamily: 'inherit',
  cursor: 'pointer',
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

function publishLabel(v: Visibility, slug: string): string {
  const target = slug || 'app';
  if (v === 'private') return `Publish ${target} (private) →`;
  if (v === 'auth-required') return `Publish ${target} (signed-in only) →`;
  return `Publish ${target} →`;
}

function visibilityDoneCopy(v: Visibility): string {
  if (v === 'private') return 'Only you can run it while signed in.';
  if (v === 'auth-required') return 'Any signed-in Floom user can run it via the link.';
  return 'Anyone with the link can run it.';
}

function shortUrl(u: string): string {
  return (u || '').replace(/^https?:\/\//, '').replace(/^www\./, '');
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

/**
 * Strip common markdown tokens before rendering a repo description as
 * plain text. UX sweep 2026-04-24 (issue #708): Studio ingest was
 * showing `##` literally in the preview card because repo READMEs
 * frequently start with a Markdown heading. We don't render Markdown
 * here (would need a full renderer + sanitizer for a one-line preview),
 * so stripping is the simplest correct fix.
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstSentence(text: string): string {
  const t = stripMarkdown((text || '').trim());
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
`;
