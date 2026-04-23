/**
 * HeroDemo (v3 — 2026-04-23 morphing canvas).
 *
 * Launch-day state (2026-04-27, waitlist reality):
 *   On production (floom.dev) Deploy is gated behind the waitlist. The hero
 *   cannot visually promise "one slash-command → live app" to every visitor.
 *   So the state machine auto-plays `build → use` only, where Use shows one
 *   of the 3 already-live store apps (Lead Scorer). `DEPLOY_ENABLED` (from
 *   `lib/launchFlags`) flips the machine back to the full `build → deploy →
 *   use` choreography on preview.floom.dev and once the public rollout ships.
 *
 * Original spec (Federico, 2026-04-23):
 *   Three states, ONE morphing canvas. Not 3 cards. Build and Deploy share
 *   the same Claude-Code-style editor surface (Deploy is a continuation, not
 *   a reset — it appends `/floomit` to the prior Build output). Use then
 *   flips to a consumer ChatGPT-style surface for the payoff.
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

import { DEPLOY_ENABLED } from '../../lib/launchFlags';

// -----------------------------------------------------------------------------
// State machine
// -----------------------------------------------------------------------------
type DemoState = 'build' | 'deploy' | 'use';

/**
 * Waitlist-reality default (DEPLOY_ENABLED=false): auto-play `build -> use`.
 * The tracker collapses to 2 pills and the editor jumps directly from the
 * typed handler code into the live Use surface — no slash-command, no
 * progress bar, no "live at floom.dev/p/..." line. Production Deploy is
 * gated on waitlist so we don't animate it. On preview / post-launch
 * (`DEPLOY_ENABLED=true`) the original 3-state loop returns.
 */
const STATES: DemoState[] = DEPLOY_ENABLED
  ? ['build', 'deploy', 'use']
  : ['build', 'use'];

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
    return `Step ${step} of ${STATES.length}: ${state}`;
  }, [state]);

  // Build + Deploy share the editor surface; only Use flips to the run
  // surface. editorActive stays true across the Build->Deploy transition
  // so the typed code stays visible.
  const editorActive = state === 'build' || state === 'deploy';

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
          state={state}
          cycle={cycle}
          active={editorActive}
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
  const count = STATES.length;
  // Dot sits at the center of the active pill (N equal columns — 2 on the
  // waitlist loop, 3 on the full loop).
  const idx = STATES.indexOf(state);
  const dotLeft = `calc(${(idx + 0.5) * (100 / count)}% - 3px)`;

  return (
    <div style={TRACKER_WRAP}>
      <div
        style={{
          ...TRACKER_PILLS,
          gridTemplateColumns: `repeat(${count}, 1fr)`,
        }}
      >
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
// EditorSurface — dark Claude-Code style shared by Build and Deploy
// -----------------------------------------------------------------------------
interface EditorProps {
  state: DemoState;
  cycle: number;
  active: boolean;
  reducedMotion: boolean;
}

function EditorSurface({ state, cycle, active, reducedMotion }: EditorProps) {
  const isBuild = state === 'build';
  const isDeploy = state === 'deploy';

  // Build: type the handler body into the editor pane.
  const codeChars = useTypewriter(HANDLER_CODE, isBuild, cycle, 14, reducedMotion);

  // Deploy: keep the full code visible (don't reset during Deploy state).
  const codeCap = isDeploy ? HANDLER_CODE.length : codeChars;

  // Deploy: type `/floomit` in the terminal once Deploy becomes active.
  const slashChars = useTypewriter(SLASH, isDeploy, cycle, 45, reducedMotion);

  // Deploy: progress bar sweep 0 -> 100 after slash command finishes.
  const [deployProgress, setDeployProgress] = useState(0);
  const [deployUrl, setDeployUrl] = useState(false);
  useEffect(() => {
    if (!isDeploy) {
      setDeployProgress(0);
      setDeployUrl(false);
      return;
    }
    if (reducedMotion) {
      setDeployProgress(100);
      setDeployUrl(true);
      return;
    }
    setDeployProgress(0);
    setDeployUrl(false);
    const waitForSlash = SLASH.length * 45 + 120;
    const sweepMs = 1500;
    const start = performance.now() + waitForSlash;
    let raf: number | null = null;
    const step = (now: number) => {
      const t = (now - start) / sweepMs;
      if (t < 0) {
        raf = requestAnimationFrame(step);
        return;
      }
      if (t >= 1) {
        setDeployProgress(100);
        setDeployUrl(true);
        return;
      }
      const eased = 1 - Math.pow(1 - t, 2);
      setDeployProgress(Math.round(eased * 100));
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [isDeploy, cycle, reducedMotion]);

  const tokens = useMemo(() => tokenizePython(HANDLER_CODE), []);
  const lineCount = useMemo(
    () => countLines(HANDLER_CODE, codeCap || HANDLER_CODE.length),
    [codeCap],
  );

  // Surface transition: 6px translateY + 180ms opacity fade
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
        {/* Slim file tree — 2-level container depth */}
        <aside style={SIDEBAR_STYLE} aria-hidden="true" data-hd="sidebar">
          <div style={SIDEBAR_SECTION}>lead-scorer</div>
          <div style={{ ...SIDEBAR_ITEM, ...SIDEBAR_ITEM_ACTIVE }}>handler.py</div>
          <div style={SIDEBAR_ITEM}>floom.yaml</div>
          <div style={SIDEBAR_ITEM}>README.md</div>
        </aside>

        {/* Main pane: editor on top, terminal on bottom */}
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
                {isBuild && !reducedMotion && codeCap < HANDLER_CODE.length && (
                  <span style={CARET_STYLE} aria-hidden="true" />
                )}
              </pre>
            </div>
          </div>

          <div style={TERMINAL_PANE}>
            <div style={TERMINAL_LINE}>
              <span style={PROMPT_SIGN}>&gt;</span>
              <span style={{ opacity: 0.7 }}>claude code &middot; lead-scorer</span>
            </div>
            {isDeploy && (
              <>
                <div style={TERMINAL_LINE}>
                  <span style={PROMPT_SIGN}>&gt;</span>
                  <span style={{ color: '#e2c48b' }}>
                    {SLASH.slice(0, slashChars)}
                  </span>
                  {!reducedMotion && slashChars < SLASH.length && (
                    <span style={CARET_DARK} aria-hidden="true" />
                  )}
                </div>
                {slashChars >= SLASH.length && (
                  <div style={DEPLOY_BLOCK}>
                    <div style={DEPLOY_PROGRESS_ROW}>
                      {/* Label flips from DEPLOYING to DEPLOYED ✓ on completion
                          — the celebration moment. Green-accent + small scale
                          pulse so the eye lands here. */}
                      <span
                        style={{
                          ...DEPLOY_LABEL,
                          color: deployUrl ? '#7fe3a9' : '#8b8680',
                          transform: deployUrl ? 'scale(1.04)' : 'scale(1)',
                          transition: reducedMotion
                            ? 'none'
                            : 'color .2s ease, transform .35s cubic-bezier(0.22, 1.4, 0.36, 1)',
                        }}
                        data-hd="deploy-label"
                      >
                        {deployUrl ? 'DEPLOYED \u2713' : 'DEPLOYING'}
                      </span>
                      <span style={DEPLOY_PCT}>{deployProgress}%</span>
                    </div>
                    <div style={DEPLOY_BAR_TRACK}>
                      <div style={{ ...DEPLOY_BAR_FILL, width: `${deployProgress}%` }} />
                    </div>
                    {deployUrl && (
                      <div
                        style={{
                          ...DEPLOY_URL_LINE,
                          opacity: deployUrl ? 1 : 0,
                          transform: deployUrl ? 'translateY(0)' : 'translateY(3px)',
                          transition: reducedMotion
                            ? 'none'
                            : 'opacity .28s ease, transform .3s cubic-bezier(0.22, 0.9, 0.28, 1)',
                        }}
                      >
                        {/* Pulsing green live indicator — "the service is live right now" */}
                        <span style={LIVE_DOT_WRAP} aria-hidden="true">
                          <span
                            style={{
                              ...LIVE_DOT,
                              animation: reducedMotion ? 'none' : 'hd-live-pulse 1.6s ease-out infinite',
                            }}
                          />
                          <span style={LIVE_DOT_CORE} />
                        </span>
                        <span style={DEPLOY_URL_META}>Deployed in 1.2s</span>
                        <span style={DEPLOY_URL_SEP}>&middot;</span>
                        <span style={DEPLOY_URL_TEXT}>floom.dev/p/lead-scorer</span>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
            {isBuild && !reducedMotion && codeCap >= HANDLER_CODE.length && (
              <div style={{ ...TERMINAL_LINE, color: '#8b8680' }}>
                <span style={PROMPT_SIGN}>&gt;</span>
                {DEPLOY_ENABLED ? (
                  <span>
                    type <span style={{ color: '#e2c48b' }}>/floomit</span> to deploy
                  </span>
                ) : (
                  // Waitlist reality: don't dangle a verb we can't fulfil on
                  // prod. Show the payoff-facing line instead — the next
                  // state transition flips to the live Lead Scorer app.
                  <span>
                    ready &middot; <span style={{ color: '#7fe3a9' }}>running live</span>
                  </span>
                )}
              </div>
            )}
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

  return (
    <div style={surfaceStyle} aria-hidden={!active}>
      <div style={RUN_WRAP}>
        {/* Context cue above the payoff card. On the full deploy loop this
            connects Use back to Deploy ("Just deployed via /floomit"). On
            the waitlist-reality 2-state loop it instead tells the visitor
            "this app is already live" so the 'try this right now' framing
            lands. */}
        <div style={RUN_CONTEXT}>
          <span style={RUN_CONTEXT_DOT} aria-hidden="true" />
          {DEPLOY_ENABLED ? (
            <span>
              Just deployed via <code style={RUN_CONTEXT_CODE}>/floomit</code>
            </span>
          ) : (
            <span>
              Live at <code style={RUN_CONTEXT_CODE}>floom.dev/p/lead-scorer</code>
            </span>
          )}
        </div>

        {/* ONE primary card, centered; consumer-style */}
        <div style={RUN_CARD}>
          <div style={RUN_HEADER}>
            <div style={RUN_TITLE}>Lead Scorer</div>
            <div style={RUN_SUB}>Score a lead against your ICP</div>
          </div>

          <div style={RUN_INPUT_ZONE}>
            <div style={RUN_INPUT_PILL}>
              <span style={RUN_INPUT_LABEL}>Lead</span>
              <span style={RUN_INPUT_VALUE}>stripe.com</span>
            </div>
            <button
              type="button"
              aria-label="Run lead scorer"
              style={{
                ...RUN_BUTTON,
                transform: pressed ? 'scale(0.96)' : 'scale(1)',
                transition: 'transform .12s ease',
              }}
            >
              Run
            </button>
          </div>

          {/* Result slot — fixed min-height so the card doesn't jump */}
          <div style={RUN_RESULT_SLOT}>
            {thinking && (
              <div style={RUN_THINKING} aria-label="Thinking">
                <span style={DOT} />
                <span style={{ ...DOT, animationDelay: '.15s' }} />
                <span style={{ ...DOT, animationDelay: '.3s' }} />
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
                <div style={RESULT_REASON}>
                  Known B2B fintech buyer. 9,000+ employees, US + EU, expansion stage.
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Secondary line: API / MCP / Analytics — small, NOT equal weight */}
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

const CARET_DARK: CSSProperties = {
  ...CARET_STYLE,
  background: '#e2c48b',
};

// Terminal is the ONE dark panel — Floom warm dark neutral (#1b1a17), NOT
// pure black. Creates visual separation from the cream code editor above
// without being a generic hacker-aesthetic black box. Brand rule:
// feedback_terminal_never_black.md (Federico 2026-04-23).
const TERMINAL_PANE: CSSProperties = {
  background: '#1b1a17',
  borderTop: '1px solid #ece8de',
  padding: '12px 16px',
  fontSize: 12.5,
  lineHeight: 1.7,
  color: '#e8e6e0',
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
  color: '#5a8b6a',
  fontWeight: 600,
};

const DEPLOY_BLOCK: CSSProperties = {
  marginTop: 6,
};

const DEPLOY_PROGRESS_ROW: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 5,
};

const DEPLOY_LABEL: CSSProperties = {
  color: '#8b8680',
  fontSize: 11,
  letterSpacing: '0.1em',
  fontWeight: 700,
  transformOrigin: 'left center',
};

const DEPLOY_PCT: CSSProperties = {
  color: '#e8e6e0',
  fontSize: 11,
  fontVariantNumeric: 'tabular-nums',
};

const DEPLOY_BAR_TRACK: CSSProperties = {
  height: 4,
  background: '#2a2825',
  borderRadius: 2,
  overflow: 'hidden',
};

const DEPLOY_BAR_FILL: CSSProperties = {
  height: '100%',
  background: 'linear-gradient(90deg, #7fe3a9 0%, #5dd39a 100%)',
  transition: 'width .05s linear',
};

// Federico 2026-04-23: "highlight the deployment enough ... clearer that it
// was just deployed". Upgraded URL line hierarchy: pulsing live dot +
// elapsed time meta + URL rendered like a link (stronger color + weight).
const DEPLOY_URL_LINE: CSSProperties = {
  marginTop: 9,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 12.5,
};

const LIVE_DOT_WRAP: CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
  width: 8,
  height: 8,
  flexShrink: 0,
};

// Outer ripple — pulses outward using hd-live-pulse keyframes.
const LIVE_DOT: CSSProperties = {
  position: 'absolute',
  inset: 0,
  borderRadius: '50%',
  background: '#7fe3a9',
};

// Solid core that stays put.
const LIVE_DOT_CORE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  borderRadius: '50%',
  background: '#7fe3a9',
  boxShadow: '0 0 8px rgba(127, 227, 169, 0.6)',
};

const DEPLOY_URL_META: CSSProperties = {
  color: '#a8a49b',
  fontSize: 11.5,
  letterSpacing: '0.01em',
};

const DEPLOY_URL_SEP: CSSProperties = {
  color: '#5a564f',
};

const DEPLOY_URL_TEXT: CSSProperties = {
  color: '#9fcbef',
  fontWeight: 600,
  textDecoration: 'underline',
  textDecorationColor: 'rgba(159, 203, 239, 0.35)',
  textUnderlineOffset: 3,
  letterSpacing: '0.01em',
};

// Run surface ----------------------------------------------------------------
const RUN_WRAP: CSSProperties = {
  height: '100%',
  padding: '20px 28px',
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
};

const RUN_CONTEXT_DOT: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: '#047857',
  display: 'inline-block',
};

const RUN_CONTEXT_CODE: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 11,
  color: '#2a2825',
  background: '#f5f4f0',
  padding: '1px 6px',
  borderRadius: 4,
};

const RUN_CARD: CSSProperties = {
  flex: 1,
  background: '#fafaf8',
  border: '1px solid #e8e6e0',
  borderRadius: 14,
  padding: '18px 20px',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  minHeight: 0,
};

const RUN_HEADER: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

const RUN_TITLE: CSSProperties = {
  fontFamily: "'DM Serif Display', Georgia, serif",
  fontSize: 22,
  fontWeight: 400,
  letterSpacing: '-0.01em',
  color: '#0e0e0c',
  lineHeight: 1.1,
};

const RUN_SUB: CSSProperties = {
  fontSize: 12.5,
  color: '#8b8680',
};

const RUN_INPUT_ZONE: CSSProperties = {
  display: 'flex',
  gap: 10,
  alignItems: 'stretch',
};

const RUN_INPUT_PILL: CSSProperties = {
  flex: 1,
  background: '#ffffff',
  border: '1px solid #e8e6e0',
  borderRadius: 999,
  padding: '10px 16px',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const RUN_INPUT_LABEL: CSSProperties = {
  fontSize: 10.5,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: '#a8a49b',
  fontWeight: 600,
};

const RUN_INPUT_VALUE: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 13,
  color: '#0e0e0c',
};

const RUN_BUTTON: CSSProperties = {
  background: '#0e0e0c',
  color: '#ffffff',
  border: 0,
  borderRadius: 999,
  padding: '0 24px',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: "'Inter', sans-serif",
};

const RUN_RESULT_SLOT: CSSProperties = {
  minHeight: 90,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-start',
};

const RUN_THINKING: CSSProperties = {
  display: 'flex',
  gap: 6,
  padding: '6px 4px',
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
  fontFamily: "'DM Serif Display', Georgia, serif",
  fontSize: 44,
  lineHeight: 1,
  fontWeight: 400,
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

const RESULT_REASON: CSSProperties = {
  fontSize: 12.5,
  color: '#2a2825',
  lineHeight: 1.5,
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
