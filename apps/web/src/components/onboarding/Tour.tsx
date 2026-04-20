// Tour — 4-step first-run onboarding. Published, skippable, timed.
//
// Flow:
//   Step 1 "paste"    anchored to #build-url-input on /studio/build.
//                     Picks from one of three sample URLs (auto-fills +
//                     submits). Advances when detection succeeds
//                     (detected-actions appears).
//   Step 2 "publish"  anchored to #build-publish. One-click defaults
//                     (public, auto-slug). Advances when the app page
//                     renders (URL matches /p/:slug).
//   Step 3 "run"      anchored to the Run button on /p/:slug. Sample
//                     input is already pre-filled. Advances once a
//                     successful run renders output.
//   Step 4 "share"    a small overlay with Copy-share-link + Make-another.
//                     Completes the tour and fires onboarding_completed.
//
// Skippable via top-right "Skip" on every CoachMark + ESC. On skip or
// complete, localStorage.floom_onboarded = true.
//
// Why not a library: the entire flow is ~200 LOC, bundle-sensitive,
// and the tour is a one-shot. Shepherd/driver.js would 3x our shipped
// JS for one UX moment.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { CoachMark } from './CoachMark';
import {
  ONBOARDING_STEPS,
  SAMPLES,
  TOTAL_STEPS,
  markOnboarded,
  markTourStart,
  readTourElapsedMs,
  track,
} from '../../lib/onboarding';

interface TourProps {
  /** Force the tour to start even if the user has already onboarded. */
  forceStart?: boolean;
  onClose: () => void;
}

type StepIdx = 0 | 1 | 2 | 3;

export function Tour({ onClose }: TourProps) {
  const nav = useNavigate();
  const loc = useLocation();
  const [stepIdx, setStepIdx] = useState<StepIdx>(0);
  const [stepStartedAt, setStepStartedAt] = useState<number>(Date.now());

  // Mark start (once) + fire onboarding_started. We stash the time on
  // sessionStorage so a refresh mid-tour still reports total time.
  useEffect(() => {
    markTourStart();
    track({ name: 'onboarding_started' });
    // Send the user to /studio/build if they're not already there — the
    // first step is anchored to the paste input.
    if (!loc.pathname.startsWith('/studio/build') && !loc.pathname.startsWith('/p/')) {
      nav('/studio/build');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const advance = useCallback(
    (reason: 'next' | 'skip' = 'next') => {
      const now = Date.now();
      const stepName = ONBOARDING_STEPS[stepIdx];
      if (reason === 'next') {
        track({
          name: 'onboarding_step_completed',
          step: stepIdx + 1,
          stepName,
          timeSpentMs: now - stepStartedAt,
        });
      } else {
        track({ name: 'onboarding_skipped', step: stepIdx + 1, stepName });
      }
      if (reason === 'skip' || stepIdx === 3) {
        markOnboarded();
        if (stepIdx === 3 && reason === 'next') {
          track({ name: 'onboarding_completed', totalMs: readTourElapsedMs() });
        }
        onClose();
        return;
      }
      setStepIdx((i) => Math.min(3, i + 1) as StepIdx);
      setStepStartedAt(now);
    },
    [stepIdx, stepStartedAt, onClose],
  );

  const onSkip = useCallback(() => advance('skip'), [advance]);
  const onBack = useCallback(() => {
    setStepIdx((i) => (i > 0 ? ((i - 1) as StepIdx) : i));
    setStepStartedAt(Date.now());
  }, []);

  // Pick the first sample URL for the auto-fill affordance. The user
  // can also pick a different one via the chips rendered alongside the
  // CoachMark body.
  const [pickedSample, setPickedSample] = useState<string | null>(null);

  // Auto-advance watchers — each step looks for a specific DOM signal
  // and advances when it fires.
  useEffect(() => {
    if (stepIdx === 0) {
      // Advance when detected-actions appears (a successful detect).
      const id = window.setInterval(() => {
        const detected = document.querySelector('[data-testid="detected-actions"]');
        if (detected) {
          advance('next');
        }
      }, 400);
      return () => window.clearInterval(id);
    }
    if (stepIdx === 1) {
      // Advance when we land on /p/:slug (published).
      const id = window.setInterval(() => {
        if (window.location.pathname.startsWith('/p/')) {
          advance('next');
        }
      }, 400);
      return () => window.clearInterval(id);
    }
    if (stepIdx === 2) {
      // Advance to the share/celebrate step when output renders.
      const id = window.setInterval(() => {
        const out = document.querySelector('[data-testid="run-surface-output"]');
        if (out) {
          advance('next');
        }
      }, 400);
      return () => window.clearInterval(id);
    }
    return undefined;
  }, [stepIdx, advance]);

  // Auto-fill + submit for a sample URL.
  const applySample = useCallback((url: string) => {
    setPickedSample(url);
    const input = document.querySelector<HTMLInputElement>('[data-testid="build-url-input"]');
    if (input) {
      // Set via the native setter so React picks up the change.
      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      desc?.set?.call(input, url);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    // Click the detect button after a short beat so React can re-render.
    window.setTimeout(() => {
      const btn = document.querySelector<HTMLButtonElement>('[data-testid="build-detect"]');
      btn?.click();
    }, 60);
  }, []);

  // Step definitions.
  const step = useMemo(() => {
    const idx = stepIdx;
    if (idx === 0) {
      return {
        anchorTestId: 'build-url-input',
        title: 'Paste something',
        placement: 'bottom' as const,
        pulse: !pickedSample,
        primaryLabel: pickedSample ? 'Detecting…' : 'Use sample',
        primaryDisabled: !!pickedSample,
        onPrimary: () => applySample(SAMPLES[0].url),
        body: (
          <>
            <p style={{ margin: '0 0 8px' }}>
              Paste an OpenAPI URL or a GitHub repo. Or click one below — we&rsquo;ll auto-fill
              and detect it for you.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {SAMPLES.map((s) => (
                <button
                  type="button"
                  key={s.url}
                  onClick={() => applySample(s.url)}
                  data-testid={`onboarding-sample-${SAMPLES.indexOf(s)}`}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    gap: 2,
                    padding: '8px 10px',
                    border: '1px solid var(--line, #e5e7eb)',
                    borderRadius: 8,
                    background: 'var(--card, #fff)',
                    color: 'var(--ink, #0f172a)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontSize: 12,
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{s.label}</span>
                  <span style={{ color: 'var(--muted, #64748b)', fontSize: 11 }}>
                    {s.caption}
                  </span>
                </button>
              ))}
            </div>
          </>
        ),
      };
    }
    if (idx === 1) {
      return {
        anchorTestId: 'build-publish',
        title: 'Publish',
        placement: 'top' as const,
        pulse: true,
        primaryLabel: 'Publish it',
        onPrimary: () => {
          const btn = document.querySelector<HTMLButtonElement>('[data-testid="build-publish"]');
          btn?.click();
        },
        body: (
          <p style={{ margin: 0 }}>
            Defaults are fine: public, auto-slug. One click and your app is live at{' '}
            <code style={{ background: 'var(--line, #f1f5f9)', padding: '0 4px', borderRadius: 4 }}>
              floom.dev/p/&#123;slug&#125;
            </code>
            .
          </p>
        ),
      };
    }
    if (idx === 2) {
      // Find the Run button on /p/:slug — RunSurface renders it with
      // data-testid="run-surface-run-btn". We pulse it.
      return {
        anchorTestId: 'run-surface-run-btn',
        title: 'Try running it',
        placement: 'top' as const,
        pulse: true,
        primaryLabel: 'Got it',
        onPrimary: () => advance('next'),
        body: (
          <p style={{ margin: 0 }}>
            This is your live app. We pre-filled a sample value — just click{' '}
            <strong>Run</strong> to see it work. The URL is public; send it to anyone.
          </p>
        ),
      };
    }
    // Step 4: share
    return {
      anchorTestId: 'run-surface-output',
      title: 'Your app is live',
      placement: 'top' as const,
      pulse: false,
      primaryLabel: 'Copy share link',
      onPrimary: () => {
        try {
          navigator.clipboard.writeText(window.location.href);
        } catch {
          /* ignore */
        }
        advance('next');
      },
      body: (
        <p style={{ margin: 0 }}>
          Nicely done. This URL works for anyone — coworkers, Twitter, a Loom. Share it,
          then publish another.
        </p>
      ),
    };
  }, [stepIdx, applySample, pickedSample, advance]);

  return (
    <CoachMark
      anchorTestId={step.anchorTestId}
      title={step.title}
      body={step.body}
      step={stepIdx + 1}
      totalSteps={TOTAL_STEPS}
      primaryLabel={step.primaryLabel}
      primaryDisabled={step.primaryDisabled}
      onPrimary={step.onPrimary}
      onSkip={onSkip}
      onBack={stepIdx > 0 ? onBack : undefined}
      placement={step.placement}
      pulse={step.pulse}
    />
  );
}
