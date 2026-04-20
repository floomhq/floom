// Confetti — tiny self-contained canvas burst. No external dep.
//
// Rationale: canvas-confetti is ~3 KB gzipped, which is fine, but we
// need maybe 60 lines of actual burst logic — easier to own it than to
// pull a package and then configure it. The burst lasts ~1.8 seconds
// then the component removes itself.
//
// Trigger model: controlled via a `fire` prop. Set to true → confetti
// plays once. Parent is responsible for ensuring this only fires once
// per session (see hasConfettiShown / markConfettiShown in lib/onboarding).

import { useEffect, useRef } from 'react';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  rot: number;
  vr: number;
  life: number;
}

const COLORS = ['#10b981', '#22c55e', '#fbbf24', '#3b82f6', '#ec4899', '#a855f7'];
const COUNT = 120;
const DURATION_MS = 1800;

export interface ConfettiProps {
  fire: boolean;
  /** Called once the burst animation ends. */
  onDone?: () => void;
}

export function Confetti({ fire, onDone }: ConfettiProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    if (!fire) return;
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    doneRef.current = false;
    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    // Two burst origins (left-ish and right-ish) for a wider spread.
    const originX = [window.innerWidth * 0.3, window.innerWidth * 0.7];
    const originY = window.innerHeight * 0.45;
    const particles: Particle[] = [];
    for (let i = 0; i < COUNT; i += 1) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * (Math.PI * 0.9);
      const speed = 6 + Math.random() * 7;
      particles.push({
        x: originX[i % 2],
        y: originY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: 5 + Math.random() * 5,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.3,
        life: 1,
      });
    }

    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const elapsed = now - start;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const p of particles) {
        p.vy += 0.18; // gravity
        p.vx *= 0.995;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        p.life = Math.max(0, 1 - elapsed / DURATION_MS);
        ctx.save();
        ctx.globalAlpha = p.life;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66);
        ctx.restore();
      }
      if (elapsed < DURATION_MS) {
        raf = requestAnimationFrame(step);
      } else if (!doneRef.current) {
        doneRef.current = true;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        onDone?.();
      }
    };
    raf = requestAnimationFrame(step);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, [fire, onDone]);

  if (!fire) return null;
  return (
    <canvas
      ref={ref}
      data-testid="onboarding-confetti"
      aria-hidden
      style={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        pointerEvents: 'none',
        zIndex: 10005,
      }}
    />
  );
}
