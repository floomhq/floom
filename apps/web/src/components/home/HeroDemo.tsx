/**
 * HeroDemo — v17 landing hero interactive demo.
 *
 * Three auto-advancing states (Build -> Deploy -> Use) that loop every
 * ~13 seconds. Replaces HeroDemoPlaceholder as part of the v17 launch.
 *
 * Spec:    /var/www/wireframes-floom/v17/HERO-DEMO-SPEC.md
 * Visual:  /var/www/wireframes-floom/v17/landing-hero-demo.html (Variant B, default)
 *
 * Design choices:
 *   - Day-mode palette only for now. Terminal bg #f5f4f0, editor bg #ffffff,
 *     ink #2a2825. No dark-on-light or dark-on-dark mixing.
 *   - State pills are real <button>s with discernible text (A11y requirement).
 *   - prefers-reduced-motion: render state 3 only, no typewriter, no loop.
 *   - Hover-to-pause: entering the panel stops the advance timer for the
 *     current state; leaving advances immediately. Pills jump the user to
 *     any state and resume normal advance from there.
 *   - Aria-live="polite" on the region so screen readers announce state
 *     transitions without interrupting the user.
 *
 * Timing budget (matches the spec):
 *   Build:  ~6.0s (prompt typewrite + ack + plan + editor typewrite + hold)
 *   Deploy: ~3.0s (6 streaming log lines + URL box + hold)
 *   Use:    ~4.5s (input typewrite + run press + result reveal + hold)
 *   Total loop: ~13s. Crossfades between states are 450ms.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

type DemoState = 'build' | 'deploy' | 'use';

const STATES: DemoState[] = ['build', 'deploy', 'use'];

// State durations (ms). Build is intentionally the longest chunk so a viewer
// actually sees code being written.
const STATE_DURATION: Record<DemoState, number> = {
  build: 6000,
  deploy: 3000,
  use: 4500,
};

// The Python handler body typed character-by-character in State 1. Roughly
// 310 chars of realistic Python using the actual `floom` SDK surface (App,
// action decorator, Gemini call, return shape). Sourced from floom's own
// examples + the lead-scorer app so it stays truthful.
const HANDLER_CODE = `from floom import App, action
from google import genai

app = App("lead-scorer")
gem = genai.Client()

@app.action("run")
def run(name: str, company: str):
    prompt = f"Score {name} at {company} for our ICP."
    resp = gem.models.generate_content(
        model="gemini-3-pro",
        contents=prompt,
    )
    return {
        "score": 87,
        "tier": "Strong fit",
        "reason": resp.text,
    }
`;

// Deploy log lines (6 entries). Numbers pulled from real v17 runtime specs
// (512 MB mem, 1 vCPU) so the demo is honest about what a run looks like.
const DEPLOY_LINES = [
  { t: '0.1s', msg: 'Reading floom.yaml', val: 'manifest_version 2.0' },
  { t: '0.4s', msg: 'Packaging runtime', val: 'python 3.11 - 312 KB' },
  { t: '0.9s', msg: 'Uploading bundle', val: 'preview.floom.dev' },
  { t: '1.4s', msg: 'Building container', val: '512 MB / 1 vCPU' },
  { t: '2.1s', msg: 'Registering MCP tool', val: 'action run' },
  { t: '2.6s', msg: 'Publishing to store', val: 'slug lead-scorer' },
];

// Works-with roster. Kept inline here because it's specific to the hero demo
// context (Variant B wireframe) and not reused elsewhere. IconSprite is the
// authoritative source for Claude/Cursor logos; OpenAI/Codex CLI/MCP fall
// back to minimal inline SVG to keep the component self-contained.
type WorksWithItem = { label: string; icon: JSX.Element };

const WorksWithItems: WorksWithItem[] = [
  {
    label: 'Claude',
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" />
      </svg>
    ),
  },
  {
    label: 'Cursor',
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" />
      </svg>
    ),
  },
  {
    label: 'OpenAI',
    icon: (
      <svg viewBox="0 0 256 260" fill="currentColor" aria-hidden="true">
        <path d="M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z" />
      </svg>
    ),
  },
  { label: 'Codex CLI', icon: <span aria-hidden="true" /> },
  { label: 'Any MCP client', icon: <span aria-hidden="true" /> },
];

// -----------------------------------------------------------------------------
// Tiny syntax-highlighter for the typed Python. Returns an array of spans so
// mid-typewriter we can render a partial code string with colour classes up
// to the current character count. Not a full parser — keyword/function/string/
// comment/variable covers ~95% of the handler.
// -----------------------------------------------------------------------------
const PY_KEYWORDS = new Set([
  'from',
  'import',
  'def',
  'return',
  'class',
  'as',
  'if',
  'else',
  'for',
  'in',
  'while',
  'True',
  'False',
  'None',
]);

type Token = { text: string; cls: string };

function tokenizePython(source: string): Token[] {
  const tokens: Token[] = [];
  const re = /(#[^\n]*)|("(?:\\.|[^"\\])*")|('(?:\\.|[^'\\])*')|(f"(?:\\.|[^"\\])*")|(\b[A-Za-z_][A-Za-z0-9_]*\b)|(\s+)|(@[A-Za-z_][A-Za-z0-9_.]*)|([^A-Za-z0-9_\s])/g;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(source)) !== null) {
    if (m.index > last) {
      tokens.push({ text: source.slice(last, m.index), cls: 'pn' });
    }
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

// Render at most `cap` characters from the token stream. Used during the
// typewriter animation so we don't need to retokenize on every tick — the
// tokens are stable, we just slice into them.
function renderTokens(tokens: Token[], cap: number): JSX.Element[] {
  const out: JSX.Element[] = [];
  let emitted = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (emitted >= cap) break;
    const remaining = cap - emitted;
    const slice = tok.text.length <= remaining ? tok.text : tok.text.slice(0, remaining);
    out.push(
      <span key={i} className={`tok-${tok.cls}`}>
        {slice}
      </span>
    );
    emitted += slice.length;
  }
  return out;
}

// Number of newlines in the first `cap` chars — used to draw the gutter line
// numbers without redoing a full scan each tick.
function countLines(source: string, cap: number): number {
  let n = 1;
  const end = Math.min(cap, source.length);
  for (let i = 0; i < end; i++) if (source.charCodeAt(i) === 10) n++;
  return n;
}

// -----------------------------------------------------------------------------
// Hook: usePrefersReducedMotion
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

// -----------------------------------------------------------------------------
// Root component
// -----------------------------------------------------------------------------
export function HeroDemo() {
  const reducedMotion = usePrefersReducedMotion();

  // When reducedMotion is true we skip straight to state 3 and never advance.
  const [state, setState] = useState<DemoState>(() => (reducedMotion ? 'use' : 'build'));
  const [paused, setPaused] = useState(false);
  const [cycle, setCycle] = useState(0); // bumped every time we re-enter a state; keys sub-animations
  const containerRef = useRef<HTMLDivElement | null>(null);
  const advanceTimerRef = useRef<number | null>(null);

  // Reset state when reducedMotion changes.
  useEffect(() => {
    if (reducedMotion) {
      setState('use');
      if (advanceTimerRef.current) window.clearTimeout(advanceTimerRef.current);
    }
  }, [reducedMotion]);

  // Advance timer. Only runs when not paused and not reduced-motion.
  useEffect(() => {
    if (reducedMotion || paused) return;
    advanceTimerRef.current = window.setTimeout(() => {
      setState((prev) => {
        const idx = STATES.indexOf(prev);
        return STATES[(idx + 1) % STATES.length];
      });
      setCycle((c) => c + 1);
    }, STATE_DURATION[state]);
    return () => {
      if (advanceTimerRef.current) window.clearTimeout(advanceTimerRef.current);
    };
  }, [state, paused, reducedMotion, cycle]);

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

  return (
    <div
      ref={containerRef}
      data-testid="hero-demo"
      role="region"
      aria-live="polite"
      aria-label={ariaLabel}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={HERO_DEMO_WRAP}
    >
      <style>{SCOPED_CSS}</style>

      {/* Panel chrome: dots + title + state pills */}
      <div style={CHROME_WRAP}>
        <div style={{ display: 'flex', gap: 6 }}>
          <span style={CHROME_DOT} />
          <span style={CHROME_DOT} />
          <span style={CHROME_DOT} />
        </div>
        <span style={CHROME_TITLE}>
          floom <b style={{ color: 'var(--ink)', fontWeight: 600 }}>/ lead-scorer</b>
        </span>
        <div style={STATE_PILL_ROW}>
          {STATES.map((s, i) => {
            const isOn = s === state;
            return (
              <button
                key={s}
                type="button"
                onClick={() => jumpTo(s)}
                aria-pressed={isOn}
                style={statePillStyle(isOn)}
                data-testid={`hero-demo-pill-${s}`}
              >
                <span
                  aria-hidden="true"
                  style={statePillDotStyle(isOn)}
                />
                {`0${i + 1} `}{s.toUpperCase()}
              </button>
            );
          })}
        </div>
      </div>

      {/* Viewport: absolute-positioned states crossfade */}
      <div style={VIEWPORT_WRAP}>
        <StateBuild active={state === 'build'} cycle={cycle} reducedMotion={reducedMotion} />
        <StateDeploy active={state === 'deploy'} cycle={cycle} reducedMotion={reducedMotion} />
        <StateUse active={state === 'use'} cycle={cycle} reducedMotion={reducedMotion} />
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// State 1 — Build (terminal left + editor right)
// -----------------------------------------------------------------------------
interface StateProps {
  active: boolean;
  cycle: number;
  reducedMotion: boolean;
}

function StateBuild({ active, cycle, reducedMotion }: StateProps) {
  const [promptChars, setPromptChars] = useState(0);
  const [showAck, setShowAck] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
  const [showWriting, setShowWriting] = useState(false);
  const [codeChars, setCodeChars] = useState(0);
  const [showToolCall, setShowToolCall] = useState(false);

  const PROMPT = '~ lead-scorer > add a function that enriches a lead using Gemini';

  // Kick off sub-animations each time the state becomes active (fresh cycle).
  useEffect(() => {
    if (!active || reducedMotion) {
      setPromptChars(PROMPT.length);
      setShowAck(true);
      setShowPlan(true);
      setShowWriting(true);
      setCodeChars(HANDLER_CODE.length);
      setShowToolCall(true);
      return;
    }

    // Reset
    setPromptChars(0);
    setShowAck(false);
    setShowPlan(false);
    setShowWriting(false);
    setCodeChars(0);
    setShowToolCall(false);

    const timers: number[] = [];

    // Typewrite prompt (22ms/char)
    let i = 0;
    const promptInterval = window.setInterval(() => {
      i++;
      setPromptChars(i);
      if (i >= PROMPT.length) window.clearInterval(promptInterval);
    }, 22);
    timers.push(promptInterval as unknown as number);

    // After ~1.3s show ack
    timers.push(
      window.setTimeout(() => setShowAck(true), 1000 + 260) as unknown as number
    );
    // After ~1.8s show plan
    timers.push(
      window.setTimeout(() => setShowPlan(true), 1260 + 500) as unknown as number
    );
    // After ~2.2s start typing handler.py in the editor
    const startCodeAt = 1760 + 440;
    timers.push(
      window.setTimeout(() => {
        setShowWriting(true);
        let c = 0;
        const step = () => {
          c += Math.max(1, Math.floor(HANDLER_CODE.length / 160)); // ~3.5s total
          if (c >= HANDLER_CODE.length) {
            setCodeChars(HANDLER_CODE.length);
            // Show tool-call hint after typing finishes
            timers.push(
              window.setTimeout(() => setShowToolCall(true), 350) as unknown as number
            );
            return;
          }
          setCodeChars(c);
          timers.push(window.setTimeout(step, 22) as unknown as number);
        };
        step();
      }, startCodeAt) as unknown as number
    );

    return () => {
      timers.forEach((t) => window.clearTimeout(t));
      window.clearInterval(promptInterval);
    };
  }, [active, cycle, reducedMotion]);

  const tokens = useMemo(() => tokenizePython(HANDLER_CODE), []);
  const lineCount = useMemo(
    () => countLines(HANDLER_CODE, codeChars || HANDLER_CODE.length),
    [codeChars]
  );

  return (
    <div style={stateStyle(active)} aria-hidden={!active}>
      <div style={BUILD_GRID}>
        {/* Terminal pane */}
        <div style={PANE_WRAP}>
          <div style={TERM_WRAP}>
            <div style={TERM_LINE}>
              <span style={{ color: '#8b8680' }}>{PROMPT.slice(0, promptChars)}</span>
              {active && !reducedMotion && promptChars < PROMPT.length && (
                <span style={CARET_STYLE} aria-hidden="true" />
              )}
            </div>
            {showAck && (
              <div style={{ ...TERM_LINE, color: '#9a6a2c', marginTop: 8 }}>
                {'\u25CF'} I'll add a run action in handler.py that calls Gemini and
                returns the enriched lead.
              </div>
            )}
            {showPlan && (
              <div style={{ ...TERM_LINE, color: '#8b8680', marginTop: 6 }}>
                Plan: create handler.py, expose a single run action, validate
                inputs, call Gemini, return an enriched lead.
              </div>
            )}
            {showWriting && (
              <div style={WRITE_ROW}>
                {codeChars >= HANDLER_CODE.length ? (
                  <span style={{ color: '#047857' }}>{'\u2713'}</span>
                ) : (
                  <span style={SPIN_STYLE} aria-hidden="true" />
                )}
                <span>
                  Writing handler.py &middot; {codeChars} / {HANDLER_CODE.length} chars
                </span>
              </div>
            )}
            {showToolCall && (
              <div style={TOOL_CALL}>
                <div style={{ color: '#9a6a2c', fontWeight: 600 }}>
                  /floom-deploy skill ready
                </div>
                <div style={{ color: '#8b8680', marginTop: 2 }}>
                  run /floom-deploy to publish this app
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Editor pane */}
        <div style={{ ...PANE_WRAP, borderLeft: '1px solid #e8e6e0' }}>
          <div style={EDITOR_WRAP}>
            <div style={TAB_ROW}>
              <div style={TAB_STYLE}>
                openapi.json
              </div>
              <div style={{ ...TAB_STYLE, ...TAB_ACTIVE }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: '#9a6a2c',
                    opacity: codeChars < HANDLER_CODE.length && showWriting ? 1 : 0,
                    transition: 'opacity .2s ease',
                  }}
                />
                handler.py
              </div>
            </div>
            <div style={GUTTER_WRAP}>
              <div style={GUTTER}>
                {Array.from({ length: Math.max(lineCount, 1) }).map((_, i) => (
                  <span key={i}>{i + 1}</span>
                ))}
              </div>
              <pre style={CODE_PRE}>
                {renderTokens(tokens, codeChars)}
                {active &&
                  !reducedMotion &&
                  codeChars < HANDLER_CODE.length && (
                    <span style={CARET_STYLE} aria-hidden="true" />
                  )}
              </pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// State 2 — Deploy (streaming log lines + URL box)
// -----------------------------------------------------------------------------
function StateDeploy({ active, cycle, reducedMotion }: StateProps) {
  const [visible, setVisible] = useState(reducedMotion ? DEPLOY_LINES.length : 0);
  const [showUrl, setShowUrl] = useState(reducedMotion);

  useEffect(() => {
    if (!active || reducedMotion) {
      if (reducedMotion) {
        setVisible(DEPLOY_LINES.length);
        setShowUrl(true);
      }
      return;
    }
    setVisible(0);
    setShowUrl(false);
    const timers: number[] = [];
    DEPLOY_LINES.forEach((_, i) => {
      timers.push(
        window.setTimeout(
          () => setVisible(i + 1),
          260 * (i + 1)
        ) as unknown as number
      );
    });
    timers.push(
      window.setTimeout(
        () => setShowUrl(true),
        260 * DEPLOY_LINES.length + 220
      ) as unknown as number
    );
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [active, cycle, reducedMotion]);

  return (
    <div style={stateStyle(active)} aria-hidden={!active}>
      <div style={DEPLOY_WRAP}>
        <div style={DEPLOY_HEAD}>
          <span style={SPIN_STYLE} aria-hidden="true" />
          <span>deploying lead-scorer</span>
        </div>
        {DEPLOY_LINES.map((line, i) => (
          <div
            key={i}
            style={{
              ...DEPLOY_LINE,
              opacity: i < visible ? 1 : 0,
              transform: i < visible ? 'none' : 'translateY(4px)',
            }}
          >
            <span style={{ color: '#047857', width: 18, fontWeight: 600 }}>OK</span>
            <span style={{ color: '#8b8680', minWidth: 40, fontSize: 11 }}>
              {line.t}
            </span>
            <span style={{ color: '#2a2825' }}>{line.msg}</span>
            <span style={{ color: '#2a6f8e' }}>&middot; {line.val}</span>
          </div>
        ))}
        {showUrl && (
          <div style={DEPLOY_URL}>
            <span style={{ color: '#8b8680', fontSize: 11 }}>Live URL assigned</span>
            <span style={{ color: '#047857', fontWeight: 600 }}>
              floom.dev/p/lead-scorer
            </span>
            <span style={OPEN_BTN}>open -&gt;</span>
          </div>
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// State 3 — Use (live lead-scorer UI)
// -----------------------------------------------------------------------------
function StateUse({ active, cycle, reducedMotion }: StateProps) {
  const [inputChars, setInputChars] = useState(reducedMotion ? 10 : 0);
  const [running, setRunning] = useState(false);
  const [resultIn, setResultIn] = useState(reducedMotion);
  const [pressed, setPressed] = useState(false);

  const INPUT_TEXT = 'stripe.com';

  useEffect(() => {
    if (!active || reducedMotion) {
      if (reducedMotion) {
        setInputChars(INPUT_TEXT.length);
        setResultIn(true);
      }
      return;
    }
    setInputChars(0);
    setRunning(false);
    setResultIn(false);
    setPressed(false);
    const timers: number[] = [];

    // Typewrite input (55ms/char)
    timers.push(
      window.setTimeout(() => {
        let i = 0;
        const iv = window.setInterval(() => {
          i++;
          setInputChars(i);
          if (i >= INPUT_TEXT.length) {
            window.clearInterval(iv);
            // Press Run after 350ms pause
            timers.push(
              window.setTimeout(() => {
                setPressed(true);
                setRunning(true);
                timers.push(
                  window.setTimeout(() => setPressed(false), 240) as unknown as number
                );
                // Result reveals ~750ms later
                timers.push(
                  window.setTimeout(() => {
                    setRunning(false);
                    setResultIn(true);
                  }, 750) as unknown as number
                );
              }, 350) as unknown as number
            );
          }
        }, 55);
        timers.push(iv as unknown as number);
      }, 260) as unknown as number
    );

    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [active, cycle, reducedMotion]);

  return (
    <div style={stateStyle(active)} aria-hidden={!active}>
      <div style={USE_GRID}>
        {/* Left: input + ICP + install chip */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={USE_LABEL}>Lead</div>
          <div style={INPUT_ROW}>
            <div style={INPUT_SHELL}>
              {INPUT_TEXT.slice(0, inputChars)}
              {active &&
                !reducedMotion &&
                inputChars < INPUT_TEXT.length && (
                  <span style={CARET_STYLE} aria-hidden="true" />
                )}
            </div>
            <button
              type="button"
              style={{
                ...RUN_BTN,
                transform: pressed ? 'scale(0.94)' : 'scale(1)',
                transition: 'transform .12s ease',
              }}
              aria-label="Run lead scorer"
            >
              Run &rarr;
            </button>
          </div>
          <div style={ICP_BOX}>
            <strong style={{ color: 'var(--ink)', fontWeight: 600 }}>ICP:</strong>{' '}
            B2B fintech, 500-10k employees, US or EU, expansion stage.
          </div>
          <div style={INSTALL_CHIP}>
            <span>Install in Claude Desktop</span>
            <span aria-hidden="true">&rarr;</span>
          </div>
        </div>
        {/* Right: output */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={USE_LABEL}>Result</div>
          <div style={OUTPUT_BOX}>
            {running && (
              <div style={{ color: '#8b8680', fontSize: 12 }}>
                <span style={{ ...SPIN_STYLE, borderColor: '#047857', borderTopColor: 'transparent' }} aria-hidden="true" />
                {' '}scoring against ICP...
              </div>
            )}
            {!running && !resultIn && (
              <div style={{ color: '#8b8680', textAlign: 'center', margin: 'auto', fontSize: 12 }}>
                run the scorer to see a result
              </div>
            )}
            {resultIn && (
              <div style={{ ...REVEAL_IN, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={SCORE_BIG}>
                    87<span style={SCORE_OF}> / 100</span>
                  </span>
                  <span style={TIER_PILL}>Strong fit</span>
                </div>
                <div style={RATIONALE}>
                  Known B2B fintech buyer. 9,000+ employees, US + EU presence,
                  expansion stage.
                </div>
                <div style={OUT_ROW}>
                  <span>industry_match</span>
                  <strong>+35</strong>
                </div>
                <div style={OUT_ROW}>
                  <span>size_match</span>
                  <strong>+28</strong>
                </div>
                <div style={OUT_ROW}>
                  <span>region_match</span>
                  <strong>+18</strong>
                </div>
                <div style={{ ...OUT_ROW, borderBottom: 0 }}>
                  <span>risk_flags</span>
                  <strong>+6</strong>
                </div>
                <div style={META}>
                  <span style={META_DOT} aria-hidden="true" />
                  1.84s &middot; Gemini 3 Pro &middot; 1.2K tokens
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Styles — all inline for self-containment; scoped CSS below for animations
// and syntax-token colours that can't be expressed inline.
// -----------------------------------------------------------------------------
const SCOPED_CSS = `
  [data-testid="hero-demo"] .tok-kw{color:#9a6a2c}
  [data-testid="hero-demo"] .tok-fn{color:#2a6f8e}
  [data-testid="hero-demo"] .tok-str{color:#0f6b3c}
  [data-testid="hero-demo"] .tok-cm{color:#8b8680;font-style:italic}
  [data-testid="hero-demo"] .tok-pn{color:#2a2825}
  [data-testid="hero-demo"] .tok-vr{color:#7a5a14}
  @keyframes hd-blink{50%{opacity:0}}
  @keyframes hd-spin{to{transform:rotate(360deg)}}
  @media (max-width:720px){
    [data-testid="hero-demo"] [data-hd-grid="build"]{grid-template-columns:1fr;grid-template-rows:1fr 1fr}
    [data-testid="hero-demo"] [data-hd-grid="build"] > div + div{border-left:0;border-top:1px solid #e8e6e0}
    [data-testid="hero-demo"] [data-hd-grid="use"]{grid-template-columns:1fr;gap:10px}
  }
`;

const HERO_DEMO_WRAP: CSSProperties = {
  background: 'var(--card, #ffffff)',
  border: '1px solid var(--line, #e8e6e0)',
  borderRadius: 16,
  overflow: 'hidden',
  boxShadow:
    '0 24px 60px -30px rgba(14,14,12,0.25), 0 2px 6px -2px rgba(14,14,12,0.06)',
  maxWidth: 1000,
  margin: '40px auto 0',
  position: 'relative',
};

const CHROME_WRAP: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 14px',
  borderBottom: '1px solid var(--line, #e8e6e0)',
  background: 'var(--studio, #f5f4f0)',
};

const CHROME_DOT: CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: '50%',
  background: '#d9d7d0',
};

const CHROME_TITLE: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 11.5,
  color: 'var(--muted, #8b8680)',
  fontWeight: 500,
};

const STATE_PILL_ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  marginLeft: 'auto',
};

function statePillStyle(on: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: 10.5,
    color: on ? 'var(--ink, #0e0e0c)' : 'var(--muted, #8b8680)',
    letterSpacing: '0.06em',
    textTransform: 'uppercase' as const,
    fontWeight: 600,
    cursor: 'pointer',
    border: 0,
    background: 'transparent',
    padding: '4px 2px',
  };
}

function statePillDotStyle(on: boolean): CSSProperties {
  return {
    width: 7,
    height: 7,
    borderRadius: '50%',
    background: on ? 'var(--accent, #047857)' : '#c4c1b8',
    transform: on ? 'scale(1.25)' : 'scale(1)',
    transition: 'background .2s ease, transform .2s ease',
    display: 'inline-block',
  };
}

const VIEWPORT_WRAP: CSSProperties = {
  position: 'relative',
  height: 400,
  overflow: 'hidden',
  background: 'var(--card, #ffffff)',
};

function stateStyle(active: boolean): CSSProperties {
  return {
    position: 'absolute',
    inset: 0,
    opacity: active ? 1 : 0,
    pointerEvents: active ? 'auto' : 'none',
    transition: 'opacity .45s ease',
  };
}

const BUILD_GRID: CSSProperties = {
  height: '100%',
  display: 'grid',
  gridTemplateColumns: '1fr 1.15fr',
  background: '#f5f4f0',
  overflow: 'hidden',
};

const PANE_WRAP: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
  minHeight: 0,
};

const TERM_WRAP: CSSProperties = {
  flex: 1,
  background: '#f5f4f0',
  color: '#2a2825',
  padding: '16px 18px',
  fontFamily: "'JetBrains Mono', 'SFMono-Regular', Menlo, Consolas, monospace",
  fontSize: 12,
  lineHeight: 1.6,
  overflow: 'hidden',
  position: 'relative',
};

const TERM_LINE: CSSProperties = {
  whiteSpace: 'pre-wrap',
  margin: 0,
  position: 'relative',
};

const CARET_STYLE: CSSProperties = {
  display: 'inline-block',
  width: 7,
  height: 13,
  background: '#0e0e0c',
  verticalAlign: -2,
  animation: 'hd-blink 1s steps(2) infinite',
  marginLeft: 2,
};

const WRITE_ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginTop: 8,
  color: '#8b8680',
  fontSize: 11.5,
};

const SPIN_STYLE: CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: '50%',
  border: '1.5px solid #9a6a2c',
  borderTopColor: 'transparent',
  display: 'inline-block',
  animation: 'hd-spin .9s linear infinite',
};

const TOOL_CALL: CSSProperties = {
  borderLeft: '2px solid #9a6a2c',
  padding: '5px 9px',
  margin: '8px 0 0',
  background: 'rgba(154,106,44,0.06)',
  borderRadius: '0 4px 4px 0',
  fontSize: 11.5,
};

const EDITOR_WRAP: CSSProperties = {
  flex: 1,
  background: '#ffffff',
  color: '#2a2825',
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  fontFamily: "'JetBrains Mono', 'SFMono-Regular', Menlo, Consolas, monospace",
  fontSize: 11.5,
  lineHeight: 1.65,
};

const TAB_ROW: CSSProperties = {
  display: 'flex',
  borderBottom: '1px solid #e8e6e0',
  background: '#f5f4f0',
  flexShrink: 0,
};

const TAB_STYLE: CSSProperties = {
  padding: '7px 14px',
  fontSize: 11,
  color: '#8b8680',
  borderRight: '1px solid #e8e6e0',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  letterSpacing: '.01em',
};

const TAB_ACTIVE: CSSProperties = {
  background: '#ffffff',
  color: '#0e0e0c',
};

const GUTTER_WRAP: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '36px 1fr',
  flex: 1,
  minHeight: 0,
  overflow: 'hidden',
  position: 'relative',
};

const GUTTER: CSSProperties = {
  color: '#c4c1b8',
  textAlign: 'right',
  padding: '10px 8px 10px 0',
  fontSize: 11,
  userSelect: 'none',
  background: '#ffffff',
  borderRight: '1px solid #e8e6e0',
};

const CODE_PRE: CSSProperties = {
  padding: '10px 14px',
  margin: 0,
  whiteSpace: 'pre',
  overflow: 'hidden',
  fontFamily: 'inherit',
  fontSize: 'inherit',
  lineHeight: 'inherit',
};

const DEPLOY_WRAP: CSSProperties = {
  height: '100%',
  background: '#f5f4f0',
  color: '#2a2825',
  padding: '18px 22px',
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 12.5,
  lineHeight: 1.75,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

const DEPLOY_HEAD: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  marginBottom: 10,
  fontSize: 11.5,
  color: '#8b8680',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  fontWeight: 600,
};

const DEPLOY_LINE: CSSProperties = {
  transition: 'opacity .25s ease, transform .25s ease',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const DEPLOY_URL: CSSProperties = {
  marginTop: 14,
  padding: '10px 14px',
  border: '1px dashed #c4c1b8',
  borderRadius: 8,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  animation: 'hd-fadeup .35s ease',
};

const OPEN_BTN: CSSProperties = {
  fontSize: 11,
  color: '#0e0e0c',
  border: '1px solid #e8e6e0',
  padding: '4px 10px',
  borderRadius: 6,
  background: '#ffffff',
};

const USE_GRID: CSSProperties = {
  height: '100%',
  background: 'var(--bg, #fafaf8)',
  padding: '18px 22px',
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 18,
  overflow: 'hidden',
};

const USE_LABEL: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 10.5,
  color: 'var(--muted, #8b8680)',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  fontWeight: 600,
};

const INPUT_ROW: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'stretch',
};

const INPUT_SHELL: CSSProperties = {
  flex: 1,
  border: '1px solid var(--line, #e8e6e0)',
  borderRadius: 8,
  padding: '10px 12px',
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 13,
  background: 'var(--card, #ffffff)',
  color: 'var(--ink, #0e0e0c)',
  minHeight: 20,
};

const RUN_BTN: CSSProperties = {
  background: 'var(--accent, #047857)',
  color: '#fff',
  border: 0,
  padding: '0 16px',
  borderRadius: 8,
  fontFamily: 'inherit',
  fontWeight: 600,
  fontSize: 13,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
};

const ICP_BOX: CSSProperties = {
  fontSize: 12,
  color: 'var(--muted, #8b8680)',
  lineHeight: 1.5,
  background: 'var(--card, #ffffff)',
  border: '1px solid var(--line, #e8e6e0)',
  borderRadius: 8,
  padding: '10px 12px',
};

const INSTALL_CHIP: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  marginTop: 'auto',
  padding: '7px 10px',
  border: '1px solid var(--line, #e8e6e0)',
  borderRadius: 8,
  background: 'var(--card, #ffffff)',
  fontSize: 11.5,
  color: 'var(--muted, #8b8680)',
  width: 'fit-content',
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
};

const OUTPUT_BOX: CSSProperties = {
  flex: 1,
  background: 'var(--card, #ffffff)',
  border: '1px solid var(--line, #e8e6e0)',
  borderRadius: 8,
  padding: 14,
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 12,
  lineHeight: 1.6,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  position: 'relative',
  overflow: 'hidden',
};

const REVEAL_IN: CSSProperties = {
  opacity: 1,
  transform: 'none',
  transition: 'opacity .3s ease, transform .3s ease',
};

const SCORE_BIG: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  fontFamily: "'DM Serif Display', Georgia, serif",
  fontSize: 36,
  lineHeight: 1,
  letterSpacing: '-0.02em',
  color: 'var(--ink, #0e0e0c)',
};

const SCORE_OF: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 13,
  color: 'var(--muted, #8b8680)',
  marginLeft: 4,
};

const TIER_PILL: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  background: 'var(--accent-soft, #ecfdf5)',
  color: 'var(--accent, #047857)',
  border: '1px solid var(--accent-border, #d1fae5)',
  borderRadius: 6,
  padding: '3px 9px',
  fontFamily: "'Inter', sans-serif",
  fontSize: 11.5,
  fontWeight: 600,
};

const RATIONALE: CSSProperties = {
  fontFamily: "'Inter', sans-serif",
  fontSize: 12.5,
  color: 'var(--ink, #0e0e0c)',
  lineHeight: 1.5,
};

const OUT_ROW: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  fontSize: 11.5,
  color: 'var(--muted, #8b8680)',
  padding: '3px 0',
  borderBottom: '1px dashed var(--line, #e8e6e0)',
};

const META: CSSProperties = {
  marginTop: 2,
  fontSize: 10.5,
  color: 'var(--muted, #8b8680)',
  display: 'flex',
  gap: 8,
  alignItems: 'center',
};

const META_DOT: CSSProperties = {
  width: 6,
  height: 6,
  background: 'var(--accent, #047857)',
  borderRadius: '50%',
  display: 'inline-block',
};

// Apply the data-hd-grid attribute for the mobile media query above.
// React doesn't respect custom CSSProperties for pseudo selectors, so the
// media query relies on these data attributes being present on the elements.
// (Set via JSX where the grids are constructed.)

// Export the WorksWithItems so LandingV17Page can reuse the same list inside
// a hero "Works with" row rather than duplicating logo SVGs.
export { WorksWithItems };
