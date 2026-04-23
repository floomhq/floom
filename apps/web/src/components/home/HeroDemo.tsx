/**
 * HeroDemo (v3 — 2026-04-23 morphing canvas).
 *
 * 2026-04-27 launch-reality refresh (supersedes the earlier 2-state
 * collapse):
 *   - All THREE tabs (Build / Deploy / Use) stay present and selectable
 *     regardless of `DEPLOY_ENABLED`. Gating the public Deploy flow is
 *     agent 9's concern; the hero demo is a visual explainer of the
 *     product, not a live deploy button.
 *   - Background: no more black. The entire canvas, editor surface,
 *     sidebar, terminal, and Deploy chrome run on the cream/paper palette
 *     (`#faf8f3` / `#f8f5ef` / `#ffffff`) — the landing-brand surface, not
 *     the hacker-terminal one. Lineage: Vikas 70b5068.
 *   - Deploy fills the frame: Deploy is no longer a small strip at the
 *     bottom of the shared editor terminal. It gets a dedicated two-pane
 *     layout — a left "publish checklist" column + the completed editor
 *     on the right — so the tab feels as full-bleed as Build and Use.
 *     Lineage: Fede c2703ad WIP snapshot.
 *   - Use tab has room to breathe: card sits in a generous 20/28px padded
 *     surface with a taller result slot, no cramped thumbnail feel.
 *
 * Spec (Federico, 2026-04-23):
 *   Three states, ONE morphing canvas. Not 3 cards. Build and Deploy share
 *   the same Claude-Code-style editor surface on the original spec (Deploy
 *   is a continuation, not a reset — it appends `/floomit` to the prior
 *   Build output). On the 2026-04-27 refresh, Deploy extends the canvas
 *   into a full-frame "publish" layout (still a continuation — code is
 *   kept visible on the right; the left column is the new deploy-timeline
 *   view). Use then flips to a consumer ChatGPT-style surface for the
 *   payoff.
 *
 *   Canvas is a fixed 580px tall container (bumped from 420 on 2026-04-23 —
 *   Cursor-style "demo doesn't have to fit above fold"). No height jumps
 *   between states. Same top alignment, same padding. A tracker at the top
 *   — `01 BUILD ·
 *   02 DEPLOY · 03 USE` — has an animating dot that slides between active
 *   pills.
 *
 *   Motion choreography (the "moment" upgrade):
 *     - 3.0s Build, 3.2s Deploy, 4.0s Use (payoff pause).
 *     - Cursor blink during code typing in Build.
 *     - `/floomit` TYPES at Deploy — don't clear Build output, append.
 *     - Micro tension 280ms after Run button "press" before result reveal.
 *     - Score COUNTS UP 0 -> 87 (requestAnimationFrame) — no fade-in number.
 *     - Tag ("Strong fit") fades in AFTER the score lands.
 *     - 6px vertical shift + 180ms light fade on state transitions.
 *     - Tracker dot animates horizontally between active pills.
 *     - Subtle "just deployed via /floomit" cue inside Use state.
 *
 *   Naming: Federico uses `/floomit` as the canonical slash command. The
 *   skill shipped today registers as `/floom-deploy` (see
 *   skills/claude-code/SKILL.md). That naming drift is flagged in PR body;
 *   we show `/floomit` in the demo to match Federico's spec. When the skill
 *   is renamed, this file doesn't need to change.
 *
 *   `prefers-reduced-motion`: skip all motion, render Use state static with
 *   the final score visible.
 *
 * Structure:
 *   <HeroDemo>
 *     <Tracker />                   — 3 pills + sliding dot
 *     <Canvas>                      — fixed-height morphing surface
 *       <EditorSurface />           — renders for Build + Deploy
 *       <RunSurface />              — renders for Use
 *     </Canvas>
 *   </HeroDemo>
 *
 * Previous implementation (v2, pre-2026-04-23): 3 absolute-positioned cards
 * crossfading inside one container, day-mode palette only. Federico's
 * critique: "feels static" — no moment, no payoff pause, no continuity
 * between Build and Deploy. See git history for the v2 source.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';

// -----------------------------------------------------------------------------
// State machine
// -----------------------------------------------------------------------------
type DemoState = 'build' | 'deploy' | 'use';

/**
 * Always three states. The hero demo is an explainer of the product shape;
 * whether public self-serve deploy is live (preview) or gated on waitlist
 * (prod) is an orthogonal concern handled by agent 9 at the CTA layer.
 * Collapsing to 2 states here was the wrong primitive — the demo stays
 * Build -> Deploy -> Use unconditionally, and the CTAs do the truth-telling.
 */
const STATES: DemoState[] = ['build', 'deploy', 'use'];

/**
 * State durations in milliseconds. Use is intentionally the longest — it's
 * the payoff, so a viewer should actually see the score land and the tag
 * fade in before the loop resets.
 */
const STATE_DURATION: Record<DemoState, number> = {
  build: 3000,
  // Deploy is intentionally the longest non-Use state — viewers should fully
  // register the DEPLOYED moment (label flip + URL line + pulse) before the
  // canvas morphs to Use. Previously 3.2s — too short to feel celebratory.
  deploy: 4400,
  use: 4000,
};

/**
 * The Python handler body typed character-by-character during Build. Kept
 * deliberately sparse: 70% whitespace so a newcomer can read it, 20% the
 * actual model call, 10% chrome. Matches the real lead-scorer app's shape
 * (examples/lead-scorer/main.py) so the demo is truthful.
 */
const HANDLER_CODE = `from floom import App, action
from google import genai

app = App("lead-scorer")
gem = genai.Client()

@app.action("run")
def run(lead: str):
    prompt = f"Score {lead} for our ICP."
    resp = gem.models.generate_content(
        model="gemini-3-pro",
        contents=prompt,
    )
    return {"score": 87, "tier": "Strong fit"}
`;

/** Slash command typed at Deploy. See header comment re: `/floomit` vs
 *  `/floom-deploy` naming drift. */
const SLASH = '/floomit';

// -----------------------------------------------------------------------------
// Syntax highlighter — tiny, just enough for the Python snippet above.
// -----------------------------------------------------------------------------
const PY_KEYWORDS = new Set([
  'from', 'import', 'def', 'return', 'class', 'as', 'if', 'else',
  'for', 'in', 'while', 'True', 'False', 'None',
]);

type Token = { text: string; cls: string };

function tokenizePython(source: string): Token[] {
  const tokens: Token[] = [];
  const re = /(#[^\n]*)|("(?:\\.|[^"\\])*")|('(?:\\.|[^'\\])*')|(f"(?:\\.|[^"\\])*")|(\b[A-Za-z_][A-Za-z0-9_]*\b)|(\s+)|(@[A-Za-z_][A-Za-z0-9_.]*)|([^A-Za-z0-9_\s])/g;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(source)) !== null) {
    if (m.index > last) tokens.push({ text: source.slice(last, m.index), cls: 'pn' });
    const [full, cm, dStr, sStr, fStr, ident, ws, deco, punct] = m;
    if (cm) tokens.push({ text: cm, cls: 'cm' });
    else if (dStr || sStr) tokens.push({ text: (dStr ?? sStr) as string, cls: 'str' });
    else if (fStr) tokens.push({ text: fStr, cls: 'str' });
    else if (deco) tokens.push({ text: deco, cls: 'kw' });
    else if (ident) {
      if (PY_KEYWORDS.has(ident)) tokens.push({ text: ident, cls: 'kw' });
      else if (/^[A-Z]/.test(ident)) tokens.push({ text: ident, cls: 'fn' });
      else tokens.push({ text: ident, cls: 'vr' });
    } else if (ws) tokens.push({ text: ws, cls: 'pn' });
    else if (punct) tokens.push({ text: punct, cls: 'pn' });
    else if (full) tokens.push({ text: full, cls: 'pn' });
    last = re.lastIndex;
  }
  if (last < source.length) tokens.push({ text: source.slice(last), cls: 'pn' });
  return tokens;
}

function renderTokens(tokens: Token[], cap: number): JSX.Element[] {
  const out: JSX.Element[] = [];
  let emitted = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (emitted >= cap) break;
    const remaining = cap - emitted;
    const slice = tok.text.length <= remaining ? tok.text : tok.text.slice(0, remaining);
    out.push(
      <span key={i} className={`tok-${tok.cls}`}>{slice}</span>
    );
    emitted += slice.length;
  }
  return out;
}

function countLines(source: string, cap: number): number {
  let n = 1;
  const end = Math.min(cap, source.length);
  for (let i = 0; i < end; i++) if (source.charCodeAt(i) === 10) n++;
  return n;
}

// -----------------------------------------------------------------------------
// Hooks
// -----------------------------------------------------------------------------
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/**
 * Type a string one char at a time. Returns a progress integer (0..text.length).
 * Starts advancing as soon as `active` becomes true; resets when `cycleKey`
 * changes. `charMs` controls per-char speed.
 */
function useTypewriter(
  text: string,
  active: boolean,
  cycleKey: number,
  charMs: number,
  reducedMotion: boolean,
): number {
  const [n, setN] = useState(reducedMotion ? text.length : 0);
  useEffect(() => {
    if (reducedMotion) {
      setN(text.length);
      return;
    }
    if (!active) {
      setN(0);
      return;
    }
    setN(0);
    let i = 0;
    const iv = window.setInterval(() => {
      i += 1;
      setN(i);
      if (i >= text.length) window.clearInterval(iv);
    }, charMs);
    return () => window.clearInterval(iv);
  }, [text, active, cycleKey, charMs, reducedMotion]);
  return n;
}

/**
 * Count an integer up from 0 to target using rAF. Returns current value.
 * Only runs when `trigger` is truthy (resets to 0 when trigger is false).
 * Ease-out cubic — score lands gently, not at constant speed.
 */
function useCountUp(
  target: number,
  trigger: boolean,
  durationMs: number,
  reducedMotion: boolean,
): number {
  const [value, setValue] = useState(reducedMotion ? target : 0);
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    if (reducedMotion) {
      setValue(target);
      return;
    }
    if (!trigger) {
      setValue(0);
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(target * eased));
      if (t < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [target, trigger, durationMs, reducedMotion]);
  return value;
}

// -----------------------------------------------------------------------------
// Root component
// -----------------------------------------------------------------------------
export function HeroDemo() {
  const reducedMotion = usePrefersReducedMotion();
  const [state, setState] = useState<DemoState>(() => (reducedMotion ? 'use' : 'build'));
  const [cycle, setCycle] = useState(0);
  const [paused, setPaused] = useState(false);
  const timerRef = useRef<number | null>(null);

  // Reset to Use if reduced motion gets enabled mid-cycle.
  useEffect(() => {
    if (reducedMotion) {
      setState('use');
      if (timerRef.current) window.clearTimeout(timerRef.current);
    }
  }, [reducedMotion]);

  // Advance timer. Skipped when reduced-motion or paused (on hover).
  useEffect(() => {
    if (reducedMotion || paused) return;
    timerRef.current = window.setTimeout(() => {
      setState((prev) => {
        const idx = STATES.indexOf(prev);
        return STATES[(idx + 1) % STATES.length];
      });
      setCycle((c) => c + 1);
    }, STATE_DURATION[state]);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [state, cycle, paused, reducedMotion]);

  const jumpTo = useCallback((s: DemoState) => {
    setState(s);
    setCycle((c) => c + 1);
  }, []);

  const onEnter = useCallback(() => setPaused(true), []);
  const onLeave = useCallback(() => setPaused(false), []);

  const ariaLabel = useMemo(() => {
    const step = STATES.indexOf(state) + 1;
    return `Step ${step} of 3: ${state}`;
  }, [state]);

  // 2026-04-27 refresh: each of the 3 surfaces owns the full canvas when
  // active. Previously Build + Deploy shared one editor surface where
  // Deploy content only rendered inside a 170px terminal strip at the
  // bottom — that made Deploy feel half-empty vs Build / Use. Now Deploy
  // gets its own 2-pane full-canvas surface.
  return (
    <div
      data-testid="hero-demo"
      role="region"
      aria-live="polite"
      aria-label={ariaLabel}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={WRAP_STYLE}
    >
      <style>{SCOPED_CSS}</style>

      <Tracker state={state} onJump={jumpTo} reducedMotion={reducedMotion} />

      <div style={CANVAS_STYLE}>
        <EditorSurface
          active={state === 'build'}
          cycle={cycle}
          reducedMotion={reducedMotion}
        />
        <DeploySurface
          active={state === 'deploy'}
          cycle={cycle}
          reducedMotion={reducedMotion}
        />
        <RunSurface
          active={state === 'use'}
          cycle={cycle}
          reducedMotion={reducedMotion}
        />
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Tracker — 01 BUILD · 02 DEPLOY · 03 USE with sliding dot
// -----------------------------------------------------------------------------
function Tracker({
  state,
  onJump,
  reducedMotion,
}: {
  state: DemoState;
  onJump: (s: DemoState) => void;
  reducedMotion: boolean;
}) {
  // Dot sits at the center of the active pill (3 equal columns).
  const idx = STATES.indexOf(state);
  const dotLeft = `calc(${(idx + 0.5) * (100 / 3)}% - 3px)`;

  return (
    <div style={TRACKER_WRAP}>
      <div style={TRACKER_PILLS}>
        {STATES.map((s, i) => {
          const on = s === state;
          return (
            <button
              key={s}
              type="button"
              onClick={() => onJump(s)}
              aria-pressed={on}
              data-testid={`hero-tracker-${s}`}
              style={{
                ...TRACKER_PILL,
                color: on ? 'var(--ink, #0e0e0c)' : 'var(--muted, #8b8680)',
              }}
            >
              <span style={TRACKER_NUM}>{`0${i + 1}`}</span>
              <span style={{ marginLeft: 6 }}>{s === 'use' ? 'USE' : s.toUpperCase()}</span>
            </button>
          );
        })}
        <span
          aria-hidden="true"
          style={{
            ...TRACKER_DOT,
            left: dotLeft,
            transition: reducedMotion
              ? 'none'
              : 'left .5s cubic-bezier(0.22, 0.9, 0.28, 1)',
          }}
        />
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// EditorSurface — Build state only. Cream Claude-Code style.
// -----------------------------------------------------------------------------
interface EditorProps {
  active: boolean;
  cycle: number;
  reducedMotion: boolean;
}

function EditorSurface({ active, cycle, reducedMotion }: EditorProps) {
  const codeCap = useTypewriter(HANDLER_CODE, active, cycle, 14, reducedMotion);

  const tokens = useMemo(() => tokenizePython(HANDLER_CODE), []);
  const lineCount = useMemo(
    () => countLines(HANDLER_CODE, codeCap || HANDLER_CODE.length),
    [codeCap],
  );

  const surfaceStyle: CSSProperties = {
    ...SURFACE_STYLE,
    opacity: active ? 1 : 0,
    pointerEvents: active ? 'auto' : 'none',
    transform: active ? 'translateY(0)' : 'translateY(6px)',
    transition: reducedMotion
      ? 'none'
      : 'opacity .18s ease, transform .25s cubic-bezier(0.22, 0.9, 0.28, 1)',
  };

  return (
    <div style={surfaceStyle} aria-hidden={!active}>
      <div style={EDITOR_GRID} data-hd="editor-grid">
        <aside style={SIDEBAR_STYLE} aria-hidden="true" data-hd="sidebar">
          <div style={SIDEBAR_SECTION}>lead-scorer</div>
          <div style={{ ...SIDEBAR_ITEM, ...SIDEBAR_ITEM_ACTIVE }}>handler.py</div>
          <div style={SIDEBAR_ITEM}>floom.yaml</div>
          <div style={SIDEBAR_ITEM}>README.md</div>
        </aside>

        <div style={MAIN_PANE}>
          <div style={EDITOR_PANE}>
            <div style={TAB_ROW}>
              <div style={{ ...TAB_STYLE, ...TAB_ACTIVE }}>handler.py</div>
            </div>
            <div style={GUTTER_WRAP}>
              <div style={GUTTER}>
                {Array.from({ length: Math.max(lineCount, 1) }).map((_, i) => (
                  <span key={i}>{i + 1}</span>
                ))}
              </div>
              <pre style={CODE_PRE}>
                {renderTokens(tokens, codeCap)}
                {active && !reducedMotion && codeCap < HANDLER_CODE.length && (
                  <span style={CARET_STYLE} aria-hidden="true" />
                )}
              </pre>
            </div>
          </div>

          <div style={TERMINAL_PANE}>
            <div style={TERMINAL_LINE}>
              <span style={PROMPT_SIGN}>&gt;</span>
              <span style={{ color: '#8b8680' }}>claude code &middot; lead-scorer</span>
            </div>
            {active && !reducedMotion && codeCap >= HANDLER_CODE.length && (
              <div style={{ ...TERMINAL_LINE, color: '#8b8680' }}>
                <span style={PROMPT_SIGN}>&gt;</span>
                <span>
                  type <span style={{ color: '#b45309', fontWeight: 600 }}>/floomit</span> to deploy
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// DeploySurface — full-canvas publish view
// -----------------------------------------------------------------------------
/**
 * Owns the entire canvas when Deploy is active. Layout:
 *
 *   ┌────────────────────┬──────────────────────────┐
 *   │ PUBLISHING          │  (right) code preview    │
 *   │   $ /floomit        │  — keeps the Build code  │
 *   │   ✓ build container │    visible as context,   │
 *   │   ✓ upload bundle   │    so Deploy reads as a  │
 *   │   ✓ verify runtime  │    continuation of the   │
 *   │   ✓ register route  │    previous beat.        │
 *   │                     │                          │
 *   │ DEPLOYED ✓          │                          │
 *   │ floom.dev/p/...     │                          │
 *   └────────────────────┴──────────────────────────┘
 *
 * Every element lives on the cream palette — no heavy black strip like the
 * previous implementation.
 */
const DEPLOY_STEPS = [
  'build container',
  'upload bundle',
  'verify runtime',
  'register route',
] as const;

function DeploySurface({
  active,
  cycle,
  reducedMotion,
}: {
  active: boolean;
  cycle: number;
  reducedMotion: boolean;
}) {
  const slashChars = useTypewriter(SLASH, active, cycle, 45, reducedMotion);
  const [stepIndex, setStepIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!active) {
      setStepIndex(0);
      setProgress(0);
      setDone(false);
      return;
    }
    if (reducedMotion) {
      setStepIndex(DEPLOY_STEPS.length);
      setProgress(100);
      setDone(true);
      return;
    }
    setStepIndex(0);
    setProgress(0);
    setDone(false);
    const waitForSlash = SLASH.length * 45 + 180;
    const perStep = 380; // ~4 steps in ~1.5s
    const sweepMs = DEPLOY_STEPS.length * perStep;
    const start = performance.now() + waitForSlash;
    let raf: number | null = null;
    const step = (now: number) => {
      const t = (now - start) / sweepMs;
      if (t < 0) {
        raf = requestAnimationFrame(step);
        return;
      }
      if (t >= 1) {
        setProgress(100);
        setStepIndex(DEPLOY_STEPS.length);
        setDone(true);
        return;
      }
      const eased = 1 - Math.pow(1 - t, 2);
      setProgress(Math.round(eased * 100));
      setStepIndex(Math.min(DEPLOY_STEPS.length, Math.floor(t * DEPLOY_STEPS.length) + 1));
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [active, cycle, reducedMotion]);

  const tokens = useMemo(() => tokenizePython(HANDLER_CODE), []);
  const lineCount = useMemo(() => countLines(HANDLER_CODE, HANDLER_CODE.length), []);

  const surfaceStyle: CSSProperties = {
    ...SURFACE_STYLE,
    opacity: active ? 1 : 0,
    pointerEvents: active ? 'auto' : 'none',
    transform: active ? 'translateY(0)' : 'translateY(6px)',
    transition: reducedMotion
      ? 'none'
      : 'opacity .18s ease, transform .25s cubic-bezier(0.22, 0.9, 0.28, 1)',
  };

  return (
    <div style={surfaceStyle} aria-hidden={!active}>
      <div style={DEPLOY_GRID} data-hd="deploy-grid">
        {/* Left column: the publish timeline, full-height. */}
        <div style={DEPLOY_LEFT}>
          <div style={DEPLOY_HEADER_ROW}>
            <span style={DEPLOY_HEADER_LABEL}>
              {done ? 'DEPLOYED' : 'PUBLISHING'}
            </span>
            <span style={DEPLOY_HEADER_PCT}>{progress}%</span>
          </div>

          <div style={DEPLOY_SLASH_ROW}>
            <span style={DEPLOY_PROMPT}>$</span>
            <span style={DEPLOY_SLASH_TEXT}>
              {SLASH.slice(0, slashChars)}
            </span>
            {active && !reducedMotion && slashChars < SLASH.length && (
              <span style={DEPLOY_CARET} aria-hidden="true" />
            )}
          </div>

          <div style={DEPLOY_BAR_TRACK_WRAP}>
            <div style={DEPLOY_BAR_TRACK}>
              <div style={{ ...DEPLOY_BAR_FILL, width: `${progress}%` }} />
            </div>
          </div>

          <ul style={DEPLOY_STEPS_LIST}>
            {DEPLOY_STEPS.map((label, i) => {
              const isComplete = stepIndex > i;
              const isActive = stepIndex === i + 1 && !isComplete;
              const inFlight = !isComplete && !isActive;
              return (
                <li
                  key={label}
                  style={{
                    ...DEPLOY_STEP_ITEM,
                    opacity: inFlight ? 0.45 : 1,
                    transition: reducedMotion ? 'none' : 'opacity .2s ease',
                  }}
                >
                  <span
                    style={{
                      ...DEPLOY_STEP_MARK,
                      background: isComplete ? '#d1fae5' : isActive ? '#fef3c7' : '#f0ede5',
                      color: isComplete ? '#047857' : isActive ? '#b45309' : '#a8a49b',
                      borderColor: isComplete ? '#a7f3d0' : isActive ? '#fde68a' : '#e8e6e0',
                    }}
                  >
                    {isComplete ? '\u2713' : isActive ? '\u2022' : '\u00a0'}
                  </span>
                  <span style={DEPLOY_STEP_LABEL}>{label}</span>
                </li>
              );
            })}
          </ul>

          <div
            style={{
              ...DEPLOY_URL_CARD,
              opacity: done ? 1 : 0,
              transform: done ? 'translateY(0)' : 'translateY(4px)',
              transition: reducedMotion
                ? 'none'
                : 'opacity .25s ease, transform .3s cubic-bezier(0.22, 0.9, 0.28, 1)',
            }}
            aria-hidden={!done}
          >
            <span style={LIVE_DOT_WRAP} aria-hidden="true">
              <span
                style={{
                  ...LIVE_DOT,
                  animation:
                    reducedMotion || !done
                      ? 'none'
                      : 'hd-live-pulse 1.6s ease-out infinite',
                }}
              />
              <span style={LIVE_DOT_CORE} />
            </span>
            <div style={DEPLOY_URL_TEXT_WRAP}>
              <div style={DEPLOY_URL_MAIN}>floom.dev/p/lead-scorer</div>
              <div style={DEPLOY_URL_META_CARD}>Deployed in 1.2s &middot; HTTPS &middot; edge</div>
            </div>
          </div>
        </div>

        {/* Right column: keep the code visible as context. Dimmed + read-only. */}
        <div style={DEPLOY_RIGHT}>
          <div style={TAB_ROW}>
            <div style={{ ...TAB_STYLE, ...TAB_ACTIVE }}>handler.py</div>
          </div>
          <div style={{ ...GUTTER_WRAP, flex: 1 }}>
            <div style={GUTTER}>
              {Array.from({ length: Math.max(lineCount, 1) }).map((_, i) => (
                <span key={i}>{i + 1}</span>
              ))}
            </div>
            <pre style={{ ...CODE_PRE, opacity: 0.85 }}>
              {renderTokens(tokens, HANDLER_CODE.length)}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// RunSurface — consumer ChatGPT-style payoff
// -----------------------------------------------------------------------------
function RunSurface({
  active,
  cycle,
  reducedMotion,
}: {
  active: boolean;
  cycle: number;
  reducedMotion: boolean;
}) {
  const [pressed, setPressed] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [resultReady, setResultReady] = useState(reducedMotion);
  const [showTag, setShowTag] = useState(reducedMotion);

  // Choreography: enter Use -> 420ms wait -> press Run -> 200ms release ->
  // thinking dots -> 280ms tension -> reveal result -> count-up starts ->
  // 800ms later tag fades in.
  useEffect(() => {
    if (!active) {
      setPressed(false);
      setThinking(false);
      setResultReady(false);
      setShowTag(false);
      return;
    }
    if (reducedMotion) {
      setResultReady(true);
      setShowTag(true);
      return;
    }
    const timers: number[] = [];
    setPressed(false);
    setThinking(false);
    setResultReady(false);
    setShowTag(false);

    timers.push(window.setTimeout(() => setPressed(true), 420) as unknown as number);
    timers.push(window.setTimeout(() => {
      setPressed(false);
      setThinking(true);
    }, 620) as unknown as number);
    timers.push(window.setTimeout(() => {
      setThinking(false);
      setResultReady(true);
    }, 900) as unknown as number);
    // Tag lands ~800ms after count-up starts (count-up is 700ms).
    timers.push(window.setTimeout(() => setShowTag(true), 1700) as unknown as number);

    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [active, cycle, reducedMotion]);

  const score = useCountUp(87, resultReady, 700, reducedMotion);

  const surfaceStyle: CSSProperties = {
    ...SURFACE_STYLE,
    background: '#ffffff',
    opacity: active ? 1 : 0,
    pointerEvents: active ? 'auto' : 'none',
    transform: active ? 'translateY(0)' : 'translateY(6px)',
    transition: reducedMotion
      ? 'none'
      : 'opacity .18s ease, transform .25s cubic-bezier(0.22, 0.9, 0.28, 1)',
  };

  // Reasons fade in staggered after the score lands so the right column
  // fills with content rather than appearing all at once. The same clock
  // as the tag (showTag @ 1700ms) gates these — we reuse it to avoid yet
  // another timer and keep the motion budget predictable.
  const reasonsVisible = showTag;

  return (
    <div style={surfaceStyle} aria-hidden={!active}>
      <div style={RUN_WRAP}>
        {/* Context cue above the payoff card — connects Use back to Deploy
            ("Just deployed via /floomit"). Continuity matters: the demo
            tells a complete 3-beat story and this line is the bridge from
            Deploy's payoff moment into the live app. The live-URL chip on
            the right reinforces "this is actually a real page now". */}
        <div style={RUN_CONTEXT}>
          <span style={RUN_CONTEXT_DOT} aria-hidden="true" />
          <span>
            Just deployed via <code style={RUN_CONTEXT_CODE}>/floomit</code>
          </span>
          <span style={RUN_CONTEXT_SEP} aria-hidden="true">·</span>
          <span style={RUN_CONTEXT_URL}>floom.dev/p/lead-scorer</span>
        </div>

        {/* 2026-04-28: Federico feedback "the use page looks empty and
            doesn't resemble our real design, which has input on the left
            and output on the right". The old design was a single centred
            card with a tiny input pill; that read as a thumbnail, not a
            product. The real RunSurface (/p/:slug) is a 2-column grid —
            input 2fr left, output 3fr right. Mirror it here so the demo
            is honest about the product shape. The left panel carries the
            app chrome + input fields + primary Run button; the right
            panel carries the score card + reasoning bullets. Both panels
            remain mounted across run states so the surface never flashes
            blank. */}
        <div data-hd="use-grid" style={RUN_GRID}>
          {/* LEFT — input column (2fr) ---------------------------------- */}
          <div style={RUN_INPUT_COL}>
            <div style={RUN_APP_HEADER}>
              <div style={RUN_APP_BADGE} aria-hidden="true">LS</div>
              <div>
                <div style={RUN_TITLE}>Lead Scorer</div>
                <div style={RUN_SUB}>Score a lead against your ICP</div>
              </div>
            </div>

            <div style={RUN_FIELDS}>
              <label style={RUN_FIELD}>
                <span style={RUN_FIELD_LABEL}>Lead website</span>
                <div style={RUN_FIELD_INPUT}>
                  <span style={RUN_FIELD_INPUT_TEXT}>stripe.com</span>
                </div>
              </label>
              <label style={RUN_FIELD}>
                <span style={RUN_FIELD_LABEL}>Your ICP</span>
                <div style={RUN_FIELD_INPUT_MULTI}>
                  <span style={RUN_FIELD_INPUT_TEXT}>
                    B2B fintech, Series C+, 1,000+ employees, US &amp; EU
                  </span>
                </div>
              </label>
            </div>

            <button
              type="button"
              aria-label="Run lead scorer"
              style={{
                ...RUN_BUTTON,
                transform: pressed ? 'scale(0.98)' : 'scale(1)',
                transition: 'transform .12s ease',
              }}
            >
              {thinking ? 'Running…' : 'Run'}
            </button>
          </div>

          {/* RIGHT — output column (3fr) -------------------------------- */}
          <div style={RUN_OUTPUT_COL}>
            <div style={RUN_OUTPUT_HEADER}>
              <span style={RUN_OUTPUT_LABEL}>Result</span>
              {resultReady && (
                <span style={RUN_OUTPUT_META}>run_a1f · 1.2s · Gemini 3 Pro</span>
              )}
            </div>

            {/* Result slot — always mounted, swaps between empty / thinking /
                result. Empty state carries ghost lines so the panel reads
                as a real output surface even before the run fires. */}
            <div style={RUN_OUTPUT_BODY}>
              {!resultReady && !thinking && (
                <div style={RUN_EMPTY} aria-hidden="true">
                  <div style={{ ...RUN_GHOST, width: '60%' }} />
                  <div style={{ ...RUN_GHOST, width: '85%' }} />
                  <div style={{ ...RUN_GHOST, width: '70%' }} />
                </div>
              )}
              {thinking && (
                <div style={RUN_THINKING_WRAP}>
                  <div style={RUN_THINKING} aria-label="Thinking">
                    <span style={DOT} />
                    <span style={{ ...DOT, animationDelay: '.15s' }} />
                    <span style={{ ...DOT, animationDelay: '.3s' }} />
                  </div>
                  <div style={RUN_THINKING_LABEL}>Scoring lead against ICP…</div>
                </div>
              )}
              {resultReady && (
                <div style={RUN_RESULT}>
                  <div style={SCORE_ROW}>
                    <span style={SCORE_BIG}>{score}</span>
                    <span style={SCORE_OF}>/ 100</span>
                    <span
                      style={{
                        ...TIER_PILL,
                        opacity: showTag ? 1 : 0,
                        transform: showTag ? 'translateY(0)' : 'translateY(4px)',
                        transition: reducedMotion
                          ? 'none'
                          : 'opacity .25s ease, transform .25s ease',
                      }}
                    >
                      Strong fit
                    </span>
                  </div>

                  <div
                    style={{
                      ...RUN_REASONS,
                      opacity: reasonsVisible ? 1 : 0,
                      transform: reasonsVisible
                        ? 'translateY(0)'
                        : 'translateY(4px)',
                      transition: reducedMotion
                        ? 'none'
                        : 'opacity .3s ease .1s, transform .3s ease .1s',
                    }}
                  >
                    <div style={RUN_REASONS_TITLE}>Why this score</div>
                    <ul style={RUN_REASONS_LIST}>
                      <li style={RUN_REASON_ITEM}>
                        <span style={RUN_REASON_BULLET} aria-hidden="true" />
                        Known B2B fintech buyer — serves ICP directly.
                      </li>
                      <li style={RUN_REASON_ITEM}>
                        <span style={RUN_REASON_BULLET} aria-hidden="true" />
                        9,000+ employees, expansion stage, US + EU.
                      </li>
                      <li style={RUN_REASON_ITEM}>
                        <span style={RUN_REASON_BULLET} aria-hidden="true" />
                        Funded $8.7B — procurement latency ≤ 30 days.
                      </li>
                    </ul>
                  </div>
                </div>
              )}
            </div>

            {/* Secondary line: API / MCP / Analytics — small, NOT equal
                weight. Lives inside the output column so the two columns
                stay balanced in height. */}
            <div style={RUN_SECONDARY}>
              <span>Also available as</span>
              <span style={RUN_SEC_TAG}>API</span>
              <span style={RUN_SEC_SEP}>&middot;</span>
              <span style={RUN_SEC_TAG}>MCP</span>
              <span style={RUN_SEC_SEP}>&middot;</span>
              <span style={RUN_SEC_TAG}>Analytics</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------
const SCOPED_CSS = `
  [data-testid="hero-demo"] .tok-kw{color:#b4481a;font-weight:600}
  [data-testid="hero-demo"] .tok-fn{color:#1561a3;font-weight:600}
  [data-testid="hero-demo"] .tok-str{color:#157a4a}
  [data-testid="hero-demo"] .tok-cm{color:#8b8680;font-style:italic}
  [data-testid="hero-demo"] .tok-pn{color:#2a2825}
  [data-testid="hero-demo"] .tok-vr{color:#2a2825}
  @keyframes hd-blink{50%{opacity:0}}
  @keyframes hd-dot-bounce{0%,80%,100%{opacity:.3;transform:translateY(0)}40%{opacity:1;transform:translateY(-2px)}}
  @keyframes hd-live-pulse{
    0%{transform:scale(1);opacity:.6}
    70%{transform:scale(2.4);opacity:0}
    100%{transform:scale(2.4);opacity:0}
  }
  @media (max-width:860px){
    [data-testid="hero-demo"] [data-hd="editor-grid"]{grid-template-columns:1fr}
    [data-testid="hero-demo"] [data-hd="sidebar"]{display:none}
    [data-testid="hero-demo"] [data-hd="deploy-grid"]{grid-template-columns:1fr}
    [data-testid="hero-demo"] [data-hd="deploy-grid"] > :last-child{display:none}
    [data-testid="hero-demo"] [data-hd="use-grid"]{grid-template-columns:1fr;gap:10px}
  }
  @media (max-width:480px){
    [data-testid="hero-demo"] [data-hd="deploy-grid"] > :first-child{padding:20px 18px;gap:14px}
  }
`;

const WRAP_STYLE: CSSProperties = {
  // Federico 2026-04-23: "wider and bigger" (previously 720px — felt small
  // vs. the hero text). 1080px gives Cursor-style visual weight while still
  // fitting a 1200px content column on desktop. Mobile collapses via CSS.
  maxWidth: 1080,
  margin: '28px auto 0',
  borderRadius: 24,
  background: 'var(--card, #ffffff)',
  border: '1px solid var(--line, #e8e6e0)',
  overflow: 'hidden',
  boxShadow:
    '0 30px 70px -40px rgba(14,14,12,0.25), 0 2px 8px -2px rgba(14,14,12,0.05)',
};

// Tracker lives OUTSIDE the fixed-height canvas so the canvas hits exactly
// its target height without the tracker eating into that budget.
const TRACKER_WRAP: CSSProperties = {
  padding: '14px 18px 6px',
  background: 'var(--studio, #f5f4f0)',
  borderBottom: '1px solid var(--line, #e8e6e0)',
};

const TRACKER_PILLS: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  position: 'relative',
  paddingBottom: 10,
};

const TRACKER_PILL: CSSProperties = {
  background: 'transparent',
  border: 0,
  cursor: 'pointer',
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 10.5,
  letterSpacing: '0.08em',
  fontWeight: 600,
  padding: '4px 0 10px',
  textAlign: 'center',
  transition: 'color .25s ease',
};

const TRACKER_NUM: CSSProperties = {
  color: '#a8a49b',
  marginRight: 2,
};

const TRACKER_DOT: CSSProperties = {
  position: 'absolute',
  bottom: 0,
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: 'var(--accent, #047857)',
};

// Fixed-height canvas — the morphing surface. 580px (PR #427: Federico
// "like cursor, the visual demo doesn't have to fit on the hero in full";
// larger demo = more cinematic, bottom falls below fold on 1440x900).
// Combined with wrap maxWidth 1080 from this PR for proportional weight.
const CANVAS_STYLE: CSSProperties = {
  position: 'relative',
  height: 580,
  overflow: 'hidden',
  // Warm paper tone — the visible background around the panels. Brand rule:
  // never pure black on hero demo surfaces. See feedback_terminal_never_black.md.
  background: '#faf8f3',
};

const SURFACE_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
};

// Cream paper editor — Linear/Raycast/Arc vibe, not a black hacker terminal.
// Federico 2026-04-23 + feedback_terminal_never_black.md.
const EDITOR_GRID: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '160px 1fr',
  height: '100%',
  background: '#faf8f3',
  color: '#2a2825',
  fontFamily: "'JetBrains Mono', 'SFMono-Regular', Menlo, Consolas, monospace",
};

const SIDEBAR_STYLE: CSSProperties = {
  borderRight: '1px solid #ece8de',
  padding: '14px 10px',
  fontSize: 11,
  color: '#8b8680',
  background: '#f0ede5',
};

const SIDEBAR_SECTION: CSSProperties = {
  fontSize: 10,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: '#a8a49b',
  marginBottom: 10,
  paddingLeft: 4,
};

const SIDEBAR_ITEM: CSSProperties = {
  padding: '3px 8px',
  borderRadius: 4,
  lineHeight: 1.8,
  color: '#6a665f',
};

const SIDEBAR_ITEM_ACTIVE: CSSProperties = {
  background: '#ece8de',
  color: '#0e0e0c',
};

const MAIN_PANE: CSSProperties = {
  display: 'grid',
  // Terminal row bumped to 170px so DEPLOYED + URL line breathe inside the
  // taller 500px canvas.
  gridTemplateRows: '1fr 170px',
  minHeight: 0,
};

const EDITOR_PANE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  overflow: 'hidden',
};

const TAB_ROW: CSSProperties = {
  display: 'flex',
  background: '#f0ede5',
  borderBottom: '1px solid #ece8de',
  flexShrink: 0,
};

const TAB_STYLE: CSSProperties = {
  padding: '7px 14px',
  fontSize: 11,
  color: '#6a665f',
  borderRight: '1px solid #ece8de',
};

const TAB_ACTIVE: CSSProperties = {
  background: '#faf8f3',
  color: '#0e0e0c',
};

const GUTTER_WRAP: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '36px 1fr',
  flex: 1,
  minHeight: 0,
  overflow: 'hidden',
};

const GUTTER: CSSProperties = {
  color: '#c4c1b8',
  textAlign: 'right',
  padding: '12px 8px 12px 0',
  fontSize: 11.5,
  userSelect: 'none',
  borderRight: '1px solid #ece8de',
  display: 'flex',
  flexDirection: 'column',
  lineHeight: 1.7,
};

const CODE_PRE: CSSProperties = {
  padding: '12px 16px',
  margin: 0,
  whiteSpace: 'pre',
  overflow: 'hidden',
  fontFamily: 'inherit',
  // Bumped from 11.5 -> 12.5 for the wider canvas; easier to read at the
  // new 1080px hero size.
  fontSize: 12.5,
  lineHeight: 1.7,
  color: '#2a2825',
};

const CARET_STYLE: CSSProperties = {
  display: 'inline-block',
  width: 7,
  height: 14,
  background: '#0e0e0c',
  verticalAlign: -2,
  animation: 'hd-blink 1s steps(2) infinite',
  marginLeft: 2,
};

// Terminal now runs on the cream palette (2026-04-27 refresh): the
// previous warm-dark panel still read as "black" next to the rest of the
// landing. Paper-white surface with a subtle top border separates it from
// the editor without introducing a dark block. feedback_terminal_never_black.md.
const TERMINAL_PANE: CSSProperties = {
  background: '#f8f5ef',
  borderTop: '1px solid #ece8de',
  padding: '12px 16px',
  fontSize: 12.5,
  lineHeight: 1.7,
  color: '#2a2825',
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const TERMINAL_LINE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  whiteSpace: 'pre',
};

const PROMPT_SIGN: CSSProperties = {
  color: '#047857',
  fontWeight: 600,
};

// Deploy surface (full-canvas, 2-column). All styles live on the cream /
// paper palette. Separation from the editor comes from the vertical split,
// not a dark strip.
const DEPLOY_GRID: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1.1fr 1fr',
  height: '100%',
  background: '#faf8f3',
  fontFamily: "'JetBrains Mono', 'SFMono-Regular', Menlo, Consolas, monospace",
  color: '#2a2825',
};

const DEPLOY_LEFT: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  padding: '28px 32px',
  gap: 18,
  borderRight: '1px solid #ece8de',
  background: '#faf8f3',
  minHeight: 0,
};

const DEPLOY_HEADER_ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
};

const DEPLOY_HEADER_LABEL: CSSProperties = {
  fontSize: 11,
  letterSpacing: '0.14em',
  fontWeight: 700,
  color: '#6a665f',
  textTransform: 'uppercase',
};

const DEPLOY_HEADER_PCT: CSSProperties = {
  fontSize: 13,
  color: '#2a2825',
  fontVariantNumeric: 'tabular-nums',
  fontWeight: 600,
};

const DEPLOY_SLASH_ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 14,
  background: '#f0ede5',
  border: '1px solid #e8e6e0',
  borderRadius: 10,
  padding: '10px 14px',
};

const DEPLOY_PROMPT: CSSProperties = {
  color: '#047857',
  fontWeight: 700,
};

const DEPLOY_SLASH_TEXT: CSSProperties = {
  color: '#b45309',
  fontWeight: 600,
};

const DEPLOY_CARET: CSSProperties = {
  display: 'inline-block',
  width: 8,
  height: 16,
  background: '#b45309',
  verticalAlign: -2,
  animation: 'hd-blink 1s steps(2) infinite',
};

const DEPLOY_BAR_TRACK_WRAP: CSSProperties = {
  paddingTop: 2,
};

const DEPLOY_BAR_TRACK: CSSProperties = {
  height: 4,
  background: '#ece8de',
  borderRadius: 2,
  overflow: 'hidden',
};

const DEPLOY_BAR_FILL: CSSProperties = {
  height: '100%',
  background: 'linear-gradient(90deg, #047857 0%, #059669 100%)',
  transition: 'width .05s linear',
};

const DEPLOY_STEPS_LIST: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const DEPLOY_STEP_ITEM: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  fontSize: 13,
  color: '#2a2825',
};

const DEPLOY_STEP_MARK: CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: '50%',
  border: '1px solid #e8e6e0',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 12,
  fontWeight: 700,
  flexShrink: 0,
};

const DEPLOY_STEP_LABEL: CSSProperties = {
  fontSize: 13,
  letterSpacing: '0.01em',
};

const DEPLOY_URL_CARD: CSSProperties = {
  marginTop: 'auto',
  background: '#ffffff',
  border: '1px solid #d1fae5',
  borderRadius: 14,
  padding: '14px 18px',
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  boxShadow: '0 6px 20px -12px rgba(4, 120, 87, 0.25)',
};

const DEPLOY_URL_TEXT_WRAP: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

const DEPLOY_URL_MAIN: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 14,
  fontWeight: 600,
  color: '#047857',
  letterSpacing: '0.01em',
};

const DEPLOY_URL_META_CARD: CSSProperties = {
  fontFamily: "'Inter', system-ui, sans-serif",
  fontSize: 11.5,
  color: '#6a665f',
};

const DEPLOY_RIGHT: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  background: '#faf8f3',
};

const LIVE_DOT_WRAP: CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
  width: 10,
  height: 10,
  flexShrink: 0,
};

// Outer ripple — pulses outward using hd-live-pulse keyframes.
const LIVE_DOT: CSSProperties = {
  position: 'absolute',
  inset: 0,
  borderRadius: '50%',
  background: '#047857',
};

// Solid core that stays put.
const LIVE_DOT_CORE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  borderRadius: '50%',
  background: '#047857',
  boxShadow: '0 0 10px rgba(4, 120, 87, 0.45)',
};

// Run surface ----------------------------------------------------------------
// 2026-04-28: Switched from single centred card (consumer-ChatGPT style) to
// a 2-column input-left / output-right layout that matches the real
// RunSurface on /p/:slug. Federico feedback: the old Use tab "looks empty
// and doesn't resemble our real design, which has input on the left and
// output on the right". The demo is an honest explainer of the product, so
// it has to look like the product. Left column carries the app chrome +
// fields + Run button; right column carries the score + reasoning. Both
// panels remain mounted across run states so the canvas never flashes blank.
const RUN_WRAP: CSSProperties = {
  height: '100%',
  padding: '22px 32px 24px',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  background: '#ffffff',
  color: '#0e0e0c',
  fontFamily: "'Inter', system-ui, sans-serif",
  overflow: 'hidden',
};

const RUN_CONTEXT: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 11,
  color: '#8b8680',
  letterSpacing: '0.02em',
  flexWrap: 'wrap',
};

const RUN_CONTEXT_DOT: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: '#047857',
  display: 'inline-block',
  boxShadow: '0 0 0 3px rgba(4, 120, 87, 0.12)',
};

const RUN_CONTEXT_CODE: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 11,
  color: '#2a2825',
  background: '#f5f4f0',
  padding: '1px 6px',
  borderRadius: 4,
};

const RUN_CONTEXT_SEP: CSSProperties = {
  color: '#d6d2c8',
};

const RUN_CONTEXT_URL: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 11,
  color: '#6a665f',
};

// 2-column grid: input 2fr / output 3fr matches the real RunSurface on
// /p/:slug. Mobile collapses via the [data-hd="use-grid"] media query in
// SCOPED_CSS below (≤860px stacks to a single column).
const RUN_GRID: CSSProperties = {
  flex: 1,
  display: 'grid',
  gridTemplateColumns: '2fr 3fr',
  gap: 14,
  minHeight: 0,
};

const RUN_INPUT_COL: CSSProperties = {
  background: '#fafaf8',
  border: '1px solid #e8e6e0',
  borderRadius: 14,
  padding: '18px 20px 18px',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  minHeight: 0,
};

const RUN_OUTPUT_COL: CSSProperties = {
  background: '#ffffff',
  border: '1px solid #e8e6e0',
  borderRadius: 14,
  padding: '18px 22px 18px',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  minHeight: 0,
  boxShadow:
    '0 1px 0 rgba(14,14,12,0.02), 0 14px 30px -24px rgba(14,14,12,0.18)',
};

const RUN_APP_HEADER: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
};

// Small square badge in place of a real app icon — same language as the
// real RunSurface's <AppIcon /> but deterministic so the demo doesn't
// depend on a network fetch.
const RUN_APP_BADGE: CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: 8,
  background:
    'radial-gradient(circle at 30% 25%, #d1fae5 0%, #ecfdf5 55%, #d1fae5 100%)',
  color: '#047857',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'var(--font-display)',
  fontWeight: 700,
  fontSize: 13,
  letterSpacing: '0.02em',
  boxShadow: 'inset 0 0 0 1px rgba(5,150,105,0.15)',
};

const RUN_TITLE: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontSize: 18,
  fontWeight: 700,
  letterSpacing: '-0.02em',
  color: '#0e0e0c',
  lineHeight: 1.15,
};

const RUN_SUB: CSSProperties = {
  fontSize: 12,
  color: '#8b8680',
  marginTop: 2,
};

const RUN_FIELDS: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  flex: 1,
  minHeight: 0,
};

const RUN_FIELD: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
};

const RUN_FIELD_LABEL: CSSProperties = {
  fontSize: 10.5,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: '#8b8680',
  fontWeight: 600,
};

const RUN_FIELD_INPUT: CSSProperties = {
  background: '#ffffff',
  border: '1px solid #e4e1d8',
  borderRadius: 8,
  padding: '9px 12px',
  display: 'flex',
  alignItems: 'center',
  minHeight: 36,
};

const RUN_FIELD_INPUT_MULTI: CSSProperties = {
  background: '#ffffff',
  border: '1px solid #e4e1d8',
  borderRadius: 8,
  padding: '10px 12px',
  minHeight: 52,
  display: 'flex',
  alignItems: 'flex-start',
};

const RUN_FIELD_INPUT_TEXT: CSSProperties = {
  fontFamily: "'Inter', system-ui, sans-serif",
  fontSize: 13,
  color: '#2a2825',
  lineHeight: 1.45,
};

const RUN_BUTTON: CSSProperties = {
  background: '#0e0e0c',
  color: '#ffffff',
  border: 0,
  borderRadius: 8,
  padding: '10px 16px',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: "'Inter', sans-serif",
  width: '100%',
  letterSpacing: '-0.005em',
};

const RUN_OUTPUT_HEADER: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 8,
};

const RUN_OUTPUT_LABEL: CSSProperties = {
  fontSize: 10.5,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: '#8b8680',
  fontWeight: 600,
};

const RUN_OUTPUT_META: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 10.5,
  color: '#a8a49b',
};

const RUN_OUTPUT_BODY: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'flex-start',
};

// Ghost placeholder lines shown before the run fires so the right column
// reads as an output surface, not an empty box.
const RUN_EMPTY: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  paddingTop: 8,
};

const RUN_GHOST: CSSProperties = {
  height: 10,
  borderRadius: 3,
  background: 'linear-gradient(90deg, #f2eee5 0%, #ece8de 50%, #f2eee5 100%)',
};

const RUN_THINKING_WRAP: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  paddingTop: 8,
};

const RUN_THINKING_LABEL: CSSProperties = {
  fontSize: 12,
  color: '#8b8680',
  fontStyle: 'italic',
};

const RUN_THINKING: CSSProperties = {
  display: 'flex',
  gap: 6,
  padding: '4px 0',
};

const DOT: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: '#0e0e0c',
  display: 'inline-block',
  animation: 'hd-dot-bounce 1.2s ease-in-out infinite',
};

const RUN_RESULT: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  width: '100%',
};

const SCORE_ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 10,
};

const SCORE_BIG: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontSize: 44,
  lineHeight: 1,
  fontWeight: 700,
  color: '#0e0e0c',
  fontVariantNumeric: 'tabular-nums',
  letterSpacing: '-0.02em',
};

const SCORE_OF: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 13,
  color: '#8b8680',
};

const TIER_PILL: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  background: '#ecfdf5',
  color: '#047857',
  border: '1px solid #d1fae5',
  borderRadius: 999,
  padding: '3px 11px',
  fontSize: 11.5,
  fontWeight: 600,
  marginLeft: 4,
};

// Reasoning list shown under the score in the right column. The bullets
// are rendered as inline dots (not default <ul> discs) because the font
// mix + tight spacing needs a custom marker to stay visually quiet.
const RUN_REASONS: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  marginTop: 14,
  paddingTop: 14,
  borderTop: '1px solid #f0ece3',
};

const RUN_REASONS_TITLE: CSSProperties = {
  fontSize: 10.5,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: '#8b8680',
  fontWeight: 600,
};

const RUN_REASONS_LIST: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const RUN_REASON_ITEM: CSSProperties = {
  fontSize: 12.5,
  color: '#2a2825',
  lineHeight: 1.45,
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
};

const RUN_REASON_BULLET: CSSProperties = {
  width: 5,
  height: 5,
  borderRadius: '50%',
  background: '#047857',
  marginTop: 7,
  flexShrink: 0,
};

const RUN_SECONDARY: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 11,
  color: '#a8a49b',
};

const RUN_SEC_TAG: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 10.5,
  color: '#8b8680',
  letterSpacing: '0.04em',
};

const RUN_SEC_SEP: CSSProperties = {
  color: '#c4c1b8',
};
