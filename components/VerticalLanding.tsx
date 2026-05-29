"use client";
import "../app/landing.css";
import "../app/vertical.css";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ThemeModeButton } from "./ThemeModeButton";
import { VERTICALS } from "@/lib/verticals";
import type { Vertical } from "@/lib/verticals";
import {
  ChatGPTSVG,
  CheckIcon,
  ClaudeSVG,
  ClockIcon,
  CodexSVG,
  CopySVG,
  CursorSVG,
  FileTextIcon,
  GitHubSVG,
  LockSVG,
  SparkIcon,
  WindsurfSVG,
} from "./landing-icons";

const SIGN_IN_HREF = "/login";

/* Nav scroll docking, same behavior as the main landing. */
function useNavScroll() {
  useEffect(() => {
    const navEl = document.getElementById("lnNav");
    if (!navEl) return;
    const nav = navEl;
    let lastY = window.scrollY || 0;
    let ticking = false;
    const TOP = 10,
      DELTA = 6;
    function apply() {
      ticking = false;
      const y = window.scrollY || 0;
      const docked = y > TOP;
      nav.classList.toggle("docked", docked);
      if (!docked) {
        nav.classList.remove("ln-hide");
      } else if (Math.abs(y - lastY) > DELTA) {
        if (y > lastY) nav.classList.add("ln-hide");
        else nav.classList.remove("ln-hide");
      }
      lastY = y;
    }
    function onScroll() {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(apply);
      }
    }
    apply();
    window.addEventListener("scroll", onScroll, { passive: true });
    nav.addEventListener("focusin", () => nav.classList.remove("ln-hide"));
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
}

/* ── Hero "agent-in-tool" mock ────────────────────────────────────
   Evokes the vertical's primary tool (tinted chrome + a task panel),
   with the worker doing one real task: reads, acts, produces an
   artifact. Staged reveal mirrors the main landing's new-worker flow. */
function HeroAgentInTool({ v }: { v: Vertical }) {
  const { hero } = v;
  const [step, setStep] = useState(0);
  const [done, setDone] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const startedRef = useRef(false);

  const run = useCallback(() => {
    const timers: number[] = [];
    const rm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (rm) {
      setStep(hero.steps.length);
      setDone(true);
      return () => {};
    }
    setStep(0);
    setDone(false);
    hero.steps.forEach((_, i) => {
      timers.push(window.setTimeout(() => setStep(i + 1), 620 + i * 720));
    });
    timers.push(
      window.setTimeout(() => setDone(true), 620 + hero.steps.length * 720 + 320),
    );
    return () => timers.forEach(clearTimeout);
  }, [hero.steps]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    function start() {
      if (startedRef.current) return;
      startedRef.current = true;
      cleanup = run();
    }
    if ("IntersectionObserver" in window && rootRef.current) {
      const io = new IntersectionObserver(
        (es) => {
          if (es.some((e) => e.isIntersecting)) {
            start();
            io.disconnect();
          }
        },
        { threshold: 0.3 },
      );
      io.observe(rootRef.current);
      return () => {
        io.disconnect();
        cleanup?.();
      };
    }
    start();
    return () => cleanup?.();
  }, [run]);

  const AppIcon = hero.appIcon;

  return (
    <div
      className="lv-mock"
      ref={rootRef}
      style={{ ["--tool" as string]: hero.accent }}
    >
      <div className="ln-nw-chrome">
        <div className="ln-nw-chrome-tl">
          <i />
          <i />
          <i />
        </div>
        <div className="ln-nw-chrome-url">
          <LockSVG />
          {hero.url}
        </div>
        <span className="lv-mock-by">
          <SparkIcon />
          worker
        </span>
      </div>

      <div className="lv-mock-body">
        {/* The tool surface header, tinted to read as the real app. */}
        <div className="lv-app-head">
          <span className="lv-app-ic">
            <AppIcon />
          </span>
          <div className="lv-app-id">
            <div className="lv-app-nm">{hero.app}</div>
            <div className="lv-app-trig">
              <ClockIcon />
              {hero.taskKicker}
            </div>
          </div>
          <span className="lv-app-badge">
            <i />
            {done ? "Done" : "Running"}
          </span>
        </div>

        {/* The worker's task. */}
        <div className="lv-task">
          <span className="lv-task-k">Task</span>
          <p>{hero.task}</p>
        </div>

        {/* The run, concrete steps it took inside the tool. */}
        <div className="lv-steps">
          {hero.steps.map((s, i) => (
            <div key={s} className={"lv-step" + (i < step ? " on" : "")}>
              <span className="lv-step-dot">
                {i < step ? <CheckIcon /> : <i />}
              </span>
              {s}
            </div>
          ))}
        </div>

        {/* The artifact it produced. */}
        <div className={"lv-artifact" + (done ? " on" : "")}>
          <span className="lv-art-ic">
            <FileTextIcon />
          </span>
          <div className="lv-art-id">
            <div className="lv-art-nm">{hero.artifactName}</div>
            <div className="lv-art-mt">{hero.artifactMeta}</div>
          </div>
          <span className="lv-art-cta">{hero.artifactCta}</span>
        </div>
      </div>
    </div>
  );
}

export function VerticalLanding({ slug }: { slug: string }) {
  const v: Vertical = VERTICALS[slug];
  useNavScroll();

  const [copied, setCopied] = useState(false);
  const CMD = "npx -y @floomhq/workeros";
  async function copyCmd() {
    try {
      await navigator.clipboard.writeText(CMD);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* ignore */
    }
  }

  return (
    <>
      <nav className="ln-nav" id="lnNav" aria-label="Main navigation">
        <Link href="/" className="ln-brand">
          <span className="ln-mark" aria-hidden="true" />
          Floom{" "}
          <span
            style={{ color: "var(--ink-mute)", fontWeight: 450, marginLeft: 4 }}
          >
            / workeros
          </span>
        </Link>
        <div className="ln-right">
          <a
            href="https://github.com/floomhq/workeros"
            target="_blank"
            rel="noopener noreferrer"
            className="ln-link"
          >
            Docs
          </a>
          <a
            href="https://github.com/floomhq/workeros"
            target="_blank"
            rel="noopener noreferrer"
            className="ln-gh-link"
            aria-label="GitHub"
          >
            <GitHubSVG />
          </a>
          <ThemeModeButton />
          <a href={SIGN_IN_HREF} className="ln-cta">
            Sign in
          </a>
        </div>
      </nav>

      <main id="flm-main">
        <section className="lp1 ln-hero-section">
          <div className="ln-hero ln-rise ln-rise-1">
            <div className="ln-badge">
              <span className="ln-badge-k">Workeros</span>
              <span className="ln-badge-v">{v.eyebrow}</span>
            </div>

            <h1 className="ln-h1">
              {renderH1(v.h1, v.h1Accent)}
            </h1>

            <p className="ln-sub">{v.sub}</p>

            <div className="ln-ctas">
              <a href={SIGN_IN_HREF} className="ln-btn-primary">
                {v.primaryCtaLabel}
              </a>
              <button
                type="button"
                className={"ln-cmd" + (copied ? " copied" : "")}
                onClick={copyCmd}
                aria-label="Copy the MCP install command"
              >
                <span className="ln-cmd-pr">$</span>
                <code>{CMD}</code>
                <CopySVG />
                <span className="ln-cmd-ok" aria-hidden="true">
                  Copied
                </span>
              </button>
            </div>

            <div className="ln-hero-trust" aria-label="Works with">
              <span>Works in</span>
              <span className="flogo">
                <ClaudeSVG />
                Claude
              </span>
              <span className="flogo">
                <CodexSVG />
                Codex
              </span>
              <span className="flogo">
                <CursorSVG />
                Cursor
              </span>
              <span>or any agent that speaks MCP</span>
            </div>
          </div>

          <div
            className="ln-hero-visual ln-rise ln-rise-2"
            style={{ ["--tool" as string]: v.hero.accent }}
          >
            <HeroAgentInTool v={v} />
          </div>
        </section>

        {/* Tools strip, what this vertical's worker connects to. */}
        <section className="ln-trust lp1">
          <div className="ln-trust-label">{v.toolsLabel}</div>
          <div className="ln-logos">
            {v.tools.map((t) => {
              const Logo = t.logo;
              return (
                <span key={t.label} className="ln-logo-cell">
                  <Logo />
                  {t.label}
                </span>
              );
            })}
          </div>
        </section>

        {/* Capabilities, 4 jobs it does on day one. */}
        <section className="ln-team lp1" aria-label="What it does">
          <div className="ln-sec-head">
            <div className="ln-ft-eye">Capabilities</div>
            <h2>{v.capabilitiesHead}</h2>
            <p>{v.capabilitiesSub}</p>
          </div>

          <div className="lv-caps">
            {v.capabilities.map((c) => {
              const Icon = c.icon;
              return (
                <div key={c.title} className="lv-cap">
                  <span className="lv-cap-ic">
                    <Icon />
                  </span>
                  <h3 className="lv-cap-nm">{c.title}</h3>
                  <p className="lv-cap-body">{c.body}</p>
                  <div className="lv-cap-tools" aria-label="Tools used">
                    {c.tools.map((Tool, i) => (
                      <span key={i} className="lv-cap-tool">
                        <Tool />
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* MCP trust strip, drive it from any agent (shared idea). */}
        <section className="ln-trust lp1">
          <div className="ln-trust-label">
            Drive Workeros from any MCP-capable agent
          </div>
          <div className="ln-logos">
            <span className="ln-logo-cell">
              <ClaudeSVG />
              Claude
            </span>
            <span className="ln-logo-cell">
              <ChatGPTSVG />
              ChatGPT
            </span>
            <span className="ln-logo-cell">
              <CursorSVG />
              Cursor
            </span>
            <span className="ln-logo-cell">
              <CodexSVG />
              Codex
            </span>
            <span className="ln-logo-cell">
              <WindsurfSVG />
              Windsurf
            </span>
          </div>
        </section>

        {/* Three shared pillars, what makes a Workeros worker different. */}
        <section className="ln-pillars lp1" aria-label="Why Workeros">
          <div className="ln-pillar">
            <span className="ln-pillar-ic" aria-hidden="true">
              <FileTextIcon />
            </span>
            <h3>Never starts from scratch</h3>
            <p>
              Drop your brand voice, playbooks, or help docs into a Context. It
              mounts read-only into every run, so your worker carries the same
              knowledge across days, triggers, and tools.
            </p>
            <span className="ln-pillar-tag">Contexts, mounted per run</span>
          </div>
          <div className="ln-pillar">
            <span className="ln-pillar-ic" aria-hidden="true">
              <SparkIcon />
            </span>
            <h3>Approval on your terms</h3>
            <p>
              You set the policy per worker: auto-post the low-stakes work, hold
              anything that leaves the building for your sign-off. Nothing goes
              out you didn&apos;t allow.
            </p>
            <span className="ln-pillar-tag">Approval gates, per worker</span>
          </div>
          <div className="ln-pillar">
            <span className="ln-pillar-ic" aria-hidden="true">
              <ClockIcon />
            </span>
            <h3>Glass box, not black box</h3>
            <p>
              Open any run and see the inputs, every step, each tool call, the
              output, the errors, and the cost. Replay it. Nothing your worker
              did is hidden behind a spinner.
            </p>
            <span className="ln-pillar-tag">Artifact-native runs</span>
          </div>
        </section>

        <section className="ln-cta-section lp1">
          <h2>{v.closingHead}</h2>
          <p className="ln-cta-sub">{v.closingSub}</p>
          <div className="ln-ctas" style={{ marginTop: 34 }}>
            <a href={SIGN_IN_HREF} className="ln-btn-primary">
              {v.primaryCtaLabel}
            </a>
            <button
              type="button"
              className={"ln-cmd" + (copied ? " copied" : "")}
              onClick={copyCmd}
              aria-label="Copy the MCP install command"
            >
              <span className="ln-cmd-pr">$</span>
              <code>{CMD}</code>
              <CopySVG />
              <span className="ln-cmd-ok" aria-hidden="true">
                Copied
              </span>
            </button>
          </div>
        </section>
      </main>

      <footer className="ln-footer">
        <div className="ln-footer-in">
          <div className="ln-footer-brand">
            Workeros
            <span className="cp">© 2026 · Built with care in San Francisco</span>
          </div>
          <div className="ln-footer-col">
            <h3>Product</h3>
            <a href={SIGN_IN_HREF}>Sign in</a>
            <a
              href="https://github.com/floomhq/workeros"
              target="_blank"
              rel="noopener noreferrer"
            >
              Docs
            </a>
            <a
              href="https://github.com/floomhq/workeros"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </a>
          </div>
          <div className="ln-footer-col">
            <h3>For your team</h3>
            <Link href="/marketing">Marketing</Link>
            <Link href="/sales">Sales</Link>
            <Link href="/recruiting">Recruiting</Link>
            <Link href="/support">Support</Link>
          </div>
          <div className="ln-footer-col">
            <h3>Legal</h3>
            <Link href="/terms">Terms</Link>
            <Link href="/privacy">Privacy</Link>
          </div>
          <div className="ln-footer-col">
            <h3>Connect</h3>
            <a
              href="https://www.linkedin.com/company/floomhq/"
              target="_blank"
              rel="noopener noreferrer"
            >
              LinkedIn
            </a>
            <a href="https://x.com/floomhq" target="_blank" rel="noopener noreferrer">
              X
            </a>
          </div>
        </div>
      </footer>
    </>
  );
}

/* Render the h1 with the accent word emphasized (matches .ln-h1 em). */
function renderH1(h1: string, accent: string) {
  const idx = h1.toLowerCase().indexOf(accent.toLowerCase());
  if (idx === -1) return h1;
  return (
    <>
      {h1.slice(0, idx)}
      <em>{h1.slice(idx, idx + accent.length)}</em>
      {h1.slice(idx + accent.length)}
    </>
  );
}
