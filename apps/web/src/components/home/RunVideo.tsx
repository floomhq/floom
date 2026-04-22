/**
 * RunVideo — autoplay silent loop showing a real Floom run.
 *
 * Full-bleed, mid-page. 720p, ~7s loop. MP4 + WebM so Safari + Chrome
 * both pick the cheapest codec. Autoplay + muted + loop + playsInline
 * are required to satisfy mobile browser policies.
 *
 * A11y: `prefers-reduced-motion` users see the poster frame only (the
 * autoplay is paused at mount via `useRef`).
 *
 * Assets: apps/web/public/landing-video/floom-run.{mp4,webm}
 * Poster : apps/web/public/landing-shots/step-3-run.png (last frame
 * matches, so it reads as a freeze-frame rather than a different scene).
 */
import { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { SectionEyebrow } from './SectionEyebrow';

export function RunVideo() {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mql.matches) {
      el.pause();
      setIsPlaying(false);
    }
  }, []);

  function toggle() {
    const el = ref.current;
    if (!el) return;
    if (el.paused) {
      void el.play();
      setIsPlaying(true);
    } else {
      el.pause();
      setIsPlaying(false);
    }
  }

  return (
    <section
      data-testid="home-run-video"
      data-section="run-video"
      style={{
        background: 'var(--bg)',
        padding: '88px 0 88px',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          maxWidth: 1080,
          margin: '0 auto',
          padding: '0 24px 28px',
          textAlign: 'center',
        }}
      >
        <SectionEyebrow testid="run-video-eyebrow">
          A real run, in real time
        </SectionEyebrow>
        <h2
          style={{
            fontFamily: "'DM Serif Display', Georgia, serif",
            fontWeight: 400,
            fontSize: 44,
            lineHeight: 1.05,
            letterSpacing: '-0.02em',
            color: 'var(--ink)',
            margin: 0,
            textWrap: 'balance' as unknown as 'balance',
          }}
        >
          Type. Click Run. Get an answer.
        </h2>
      </div>

      <div
        style={{
          maxWidth: 1280,
          margin: '0 auto',
          padding: '0 24px',
          position: 'relative',
        }}
      >
        <div
          style={{
            position: 'relative',
            borderRadius: 18,
            overflow: 'hidden',
            border: '1px solid var(--line)',
            boxShadow:
              '0 1px 0 rgba(0,0,0,0.02), 0 30px 60px rgba(5,150,105,0.14)',
            background: '#0f172a',
            aspectRatio: '16 / 9',
          }}
        >
          <video
            ref={ref}
            data-testid="run-video-el"
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
            poster="/landing-shots/step-3-run.png"
            style={{
              width: '100%',
              height: '100%',
              display: 'block',
              objectFit: 'cover',
            }}
          >
            <source src="/landing-video/floom-run.webm" type="video/webm" />
            <source src="/landing-video/floom-run.mp4" type="video/mp4" />
          </video>

          <button
            type="button"
            onClick={toggle}
            aria-label={isPlaying ? 'Pause demo video' : 'Play demo video'}
            data-testid="run-video-toggle"
            style={{
              position: 'absolute',
              right: 16,
              bottom: 16,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '8px 12px',
              borderRadius: 999,
              border: '1px solid rgba(255,255,255,0.28)',
              background: 'rgba(15,23,42,0.62)',
              backdropFilter: 'blur(6px)',
              color: '#f8fafc',
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: '-0.005em',
              cursor: 'pointer',
            }}
          >
            {isPlaying ? (
              <>
                <Pause size={13} strokeWidth={2} /> Pause
              </>
            ) : (
              <>
                <Play size={13} strokeWidth={2} /> Play
              </>
            )}
          </button>
        </div>
      </div>
    </section>
  );
}
