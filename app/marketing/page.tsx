"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

/* ═══════════════════════════════════════════════════════════════
   floom Landing Page
   Adapted from floomhq/floom-deprecated (light mode, no waitlist)
   ═══════════════════════════════════════════════════════════════ */

const PLACEHOLDER_CODE = `# app.py — paste AI-generated code here
from floom import app

@app.action
def summarize_url(url: str, style: str = "bullets"):
    return {"summary": "...", "points": [...]}`;

export default function MarketingPage() {
  const revealRef = useRef<boolean>(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [stars, setStars] = useState<number | null>(null);
  const [lastPush, setLastPush] = useState<string | null>(null);
  const [showPowerPrompt, setShowPowerPrompt] = useState(false);

  useEffect(() => {
    fetch("https://api.github.com/repos/floomhq/floom")
      .then((r) => r.json())
      .then((d) => {
        if (d.stargazers_count) setStars(d.stargazers_count);
        if (d.pushed_at) {
          const days = Math.floor(
            (Date.now() - new Date(d.pushed_at).getTime()) / 86400000
          );
          setLastPush(
            days === 0 ? "today" : days === 1 ? "yesterday" : `${days}d ago`
          );
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (revealRef.current) return;
    revealRef.current = true;

    const els = document.querySelectorAll("[data-reveal], .fade-section");
    const obs = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.setAttribute("data-reveal", "visible");
            e.target.classList.add("visible");
          }
        }),
      { threshold: 0.05, rootMargin: "0px 0px -20px 0px" }
    );
    els.forEach((el) => obs.observe(el));

    return () => obs.disconnect();
  }, []);

  return (
    <div className="min-h-screen overflow-x-hidden pb-[68px] sm:pb-0">
      {/* Skip to content */}
      <a
        href="#hero"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[60] focus:px-4 focus:py-2 focus:rounded-lg focus:text-white focus:text-sm focus:font-medium"
        style={{ background: "#047857" }}
      >
        Skip to content
      </a>

      {/* Background gradient blob */}
      <div
        className="fixed top-[-100px] right-[100px] w-[700px] h-[700px] pointer-events-none rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(52,211,153,0.08) 0%, rgba(251,191,36,0.04) 50%, transparent 70%)",
          opacity: "var(--floom-blob-opacity)",
        }}
      />

      {/* ══════════ NAV ══════════ */}
      <nav
        className="fixed top-0 inset-x-0 z-50 backdrop-blur-xl"
        style={{
          background: "var(--floom-nav-bg)",
          borderBottom: "1px solid var(--floom-border)",
        }}
      >
        <div className="max-w-[1100px] mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <svg
              className="w-[20px] h-[20px]"
              viewBox="0 0 48 48"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M10 6 Q4 6 4 12 L4 36 Q4 42 10 42 L28 42 L44 24 L28 6 Z"
                fill="#059669"
              />
            </svg>
            <span
              className="text-[16px] font-bold"
              style={{
                color: "var(--floom-text)",
                fontFamily: "var(--font-brand), system-ui, sans-serif",
                letterSpacing: "-0.02em",
              }}
            >
              floom
            </span>
          </Link>
          <div className="flex items-center gap-5">
            <a
              href="https://github.com/floomhq/floom#quick-start"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden sm:block text-[13px] floom-link"
            >
              Docs
            </a>
            <a
              href="https://github.com/floomhq/floom"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden sm:block text-[13px] floom-link"
            >
              GitHub
            </a>
            <a
              href="https://dashboard.floom.dev/gallery"
              className="hidden sm:block text-[13px] floom-link"
            >
              Dashboard
            </a>

            <a
              href="https://dashboard.floom.dev/sign-up"
              className="hidden sm:inline-flex px-4 py-1.5 text-[12px] font-semibold text-white rounded-lg transition-all hover:opacity-90"
              style={{ background: "#047857" }}
            >
              Paste code
            </a>
            {/* Mobile hamburger */}
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="sm:hidden flex flex-col justify-center items-center w-8 h-8 gap-[5px]"
              aria-label="Toggle menu"
            >
              <span
                className="block w-4 h-[1.5px] rounded-full transition-all"
                style={{
                  background: "var(--floom-text)",
                  transform: menuOpen
                    ? "rotate(45deg) translate(2.3px, 2.3px)"
                    : "none",
                }}
              />
              <span
                className="block w-4 h-[1.5px] rounded-full transition-all"
                style={{
                  background: "var(--floom-text)",
                  opacity: menuOpen ? 0 : 1,
                }}
              />
              <span
                className="block w-4 h-[1.5px] rounded-full transition-all"
                style={{
                  background: "var(--floom-text)",
                  transform: menuOpen
                    ? "rotate(-45deg) translate(2.3px, -2.3px)"
                    : "none",
                }}
              />
            </button>
          </div>
        </div>
        {/* Mobile menu */}
        {menuOpen && (
          <div
            className="sm:hidden px-6 pb-4 flex flex-col gap-3"
            style={{
              background: "var(--floom-nav-bg)",
              borderBottom: "1px solid var(--floom-border)",
            }}
          >
            <a
              href="https://github.com/floomhq/floom#quick-start"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[14px] py-1 floom-link"
            >
              Docs
            </a>
            <a
              href="https://github.com/floomhq/floom"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[14px] py-1 floom-link"
            >
              GitHub
            </a>
            <a
              href="https://dashboard.floom.dev/gallery"
              onClick={() => setMenuOpen(false)}
              className="text-[14px] py-1 floom-link"
            >
              Dashboard
            </a>
            <a
              href="https://dashboard.floom.dev/sign-up"
              onClick={() => setMenuOpen(false)}
              className="inline-flex justify-center px-4 py-2 mt-1 text-[13px] font-semibold text-white rounded-lg transition-all hover:opacity-90"
              style={{ background: "#047857" }}
            >
              Paste code
            </a>
          </div>
        )}
      </nav>

      {/* ══════════ HERO ══════════ */}
      <section id="hero" className="relative overflow-hidden pt-24 pb-16 px-6">
        {/* Background layers */}
        <div className="hero-gradient absolute inset-0 pointer-events-none z-0" />
        <div className="hero-grid absolute inset-0 pointer-events-none z-0" />
        <div className="grain" />

        <div className="relative z-10 max-w-[720px] mx-auto text-center">
          {/* Heading */}
          <h1
            className="hero-reveal hero-reveal-1 leading-[1.08] tracking-[-0.025em] mb-5"
            style={{
              fontFamily: "var(--font-brand), 'DM Serif Display', serif",
              fontSize: "clamp(40px, 5vw, 64px)",
              fontWeight: 400,
              color: "var(--floom-text)",
            }}
          >
            AI Wrote It.{" "}
            <em style={{ fontStyle: "italic", color: "var(--floom-accent)" }}>
              floom Ships It.
            </em>
          </h1>

          {/* Subheading */}
          <p
            className="hero-reveal hero-reveal-2 text-[19px] leading-[1.6] mb-10 max-w-[480px] mx-auto"
            style={{ color: "var(--floom-text-secondary)" }}
          >
            The production layer for AI-written code. Live URL, REST API, web
            UI, and MCP — in 45 seconds.
          </p>

          {/* Code editor centerpiece */}
          <div
            className="hero-reveal hero-reveal-3 terminal-glow rounded-[20px] overflow-hidden text-left mb-6 max-w-[600px] mx-auto"
            style={{
              background: "var(--floom-card-bg)",
            }}
          >
            {/* Browser chrome bar */}
            <div
              className="flex items-center gap-2 px-4 py-3"
              style={{
                background: "var(--floom-bg-tertiary)",
                borderBottom: "1px solid var(--floom-border)",
              }}
            >
              <span className="flex gap-1.5">
                <span
                  className="w-[10px] h-[10px] rounded-full"
                  style={{ background: "#FF5F57" }}
                />
                <span
                  className="w-[10px] h-[10px] rounded-full"
                  style={{ background: "#FFBD2E" }}
                />
                <span
                  className="w-[10px] h-[10px] rounded-full"
                  style={{ background: "#28C840" }}
                />
              </span>
              <span
                className="ml-3 px-3 py-1 rounded-md text-[12px]"
                style={{
                  background: "var(--floom-tab-pill-bg)",
                  color: "var(--floom-text-dim)",
                  fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
                }}
              >
                app.py → floom.dev
              </span>
            </div>

            {/* Syntax-highlighted code display */}
            <div
              className="w-full p-6 leading-[1.8] code-textarea select-none"
              style={{
                fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
                fontSize: "13px",
                minHeight: "160px",
              }}
            >
              <div>
                <span style={{ color: "var(--floom-code-comment)" }}>
                  # app.py &mdash; paste AI-generated code here
                </span>
              </div>
              <div>
                <span style={{ color: "var(--floom-code-keyword)" }}>from</span>
                <span style={{ color: "var(--floom-text)" }}> floom </span>
                <span style={{ color: "var(--floom-code-keyword)" }}>
                  import
                </span>
                <span style={{ color: "var(--floom-text)" }}> app</span>
              </div>
              <div>&nbsp;</div>
              <div>
                <span style={{ color: "var(--floom-code-decorator)" }}>
                  @app.action
                </span>
              </div>
              <div>
                <span style={{ color: "var(--floom-code-keyword)" }}>def</span>
                <span style={{ color: "var(--floom-text)" }}> </span>
                <span style={{ color: "var(--floom-code-fn)" }}>
                  summarize_url
                </span>
                <span style={{ color: "var(--floom-text-secondary)" }}>
                  (url: str, style: str ={" "}
                </span>
                <span style={{ color: "var(--floom-code-string)" }}>
                  &quot;bullets&quot;
                </span>
                <span style={{ color: "var(--floom-text-secondary)" }}>):</span>
              </div>
              <div>
                <span style={{ color: "var(--floom-text-secondary)" }}>
                  {"    "}return{" "}
                </span>
                <span style={{ color: "var(--floom-text-secondary)" }}>
                  {"{"}
                </span>
                <span style={{ color: "var(--floom-code-string)" }}>
                  &quot;summary&quot;
                </span>
                <span style={{ color: "var(--floom-text-secondary)" }}>: </span>
                <span style={{ color: "var(--floom-code-string)" }}>
                  &quot;...&quot;
                </span>
                <span style={{ color: "var(--floom-text-secondary)" }}>, </span>
                <span style={{ color: "var(--floom-code-string)" }}>
                  &quot;points&quot;
                </span>
                <span style={{ color: "var(--floom-text-secondary)" }}>
                  : [...]{"}"}
                </span>
              </div>
            </div>

            {/* Example chips */}
            <div
              className="flex items-center flex-wrap gap-2 px-5 py-3"
              style={{ borderTop: "1px solid var(--floom-border)" }}
            >
              <span
                className="text-[11px] font-semibold uppercase tracking-wide"
                style={{ color: "var(--floom-text-dim)" }}
              >
                Try:
              </span>
              {["URL Summarizer", "CSV Analyzer", "Resume Screener"].map(
                (chip) => (
                  <span
                    key={chip}
                    className="text-[12px] px-3 py-1 rounded-full cursor-default"
                    style={{
                      background: "var(--floom-pill-bg)",
                      border: "1px solid var(--floom-border)",
                      color: "var(--floom-text-muted)",
                    }}
                  >
                    {chip}
                  </span>
                )
              )}
            </div>
          </div>

          {/* CTA button */}
          <div className="hero-reveal hero-reveal-4 mb-5">
            <a
              href="https://dashboard.floom.dev/sign-up"
              className="cta-primary inline-flex items-center gap-2.5 px-8 py-4 rounded-[14px] text-[16px] font-bold text-white transition-all"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              >
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              Go Live
            </a>
          </div>

          {/* Trust line */}
          <div className="hero-reveal hero-reveal-5 flex flex-wrap items-center justify-center gap-5">
            {["Free & open source", "You own your code", "No credit card"].map(
              (t) => (
                <span
                  key={t}
                  className="text-[12px] flex items-center gap-1.5"
                  style={{ color: "var(--floom-text-muted)" }}
                >
                  <svg
                    className="w-3.5 h-3.5 flex-shrink-0"
                    viewBox="0 0 20 20"
                    fill="#059669"
                  >
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                  {t}
                </span>
              )
            )}
          </div>

          {/* Scroll anchor */}
          <a
            href="#how-it-works"
            className="hero-reveal hero-reveal-6 mt-8 inline-flex items-center gap-1.5 text-[13px] font-medium transition-all hover:gap-2.5"
            style={{ color: "var(--floom-text-dim)" }}
          >
            See how it works
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M12 5v14" />
              <path d="M19 12l-7 7-7-7" />
            </svg>
          </a>
        </div>
      </section>

      {/* ══════════ HOW IT WORKS ══════════ */}
      <section
        id="how-it-works"
        className="relative py-24 px-6 scroll-mt-16 floom-section-alt"
      >
        <div className="max-w-[1100px] mx-auto">
          <div data-reveal="" className="text-center mb-14">
            <div
              className="text-[12px] font-semibold uppercase tracking-[0.1em] mb-4"
              style={{ color: "var(--floom-text-dim)" }}
            >
              How it works
            </div>
            <h2
              style={{
                fontFamily: "var(--font-brand), 'DM Serif Display', serif",
                fontSize: "clamp(32px, 3.5vw, 48px)",
                fontWeight: 400,
                color: "var(--floom-text)",
                lineHeight: 1.1,
              }}
            >
              Ask ChatGPT.{" "}
              <em style={{ fontStyle: "italic", color: "var(--floom-accent)" }}>
                Paste. Done.
              </em>
            </h2>
          </div>

          {/* 3-step flow */}
          <div
            data-reveal=""
            className="grid grid-cols-3 gap-4 sm:gap-8 mb-16 max-w-[600px] mx-auto"
          >
            {[
              {
                num: "1",
                label: "Paste Code",
                desc: "Ask ChatGPT or Claude to write it",
              },
              {
                num: "2",
                label: "floom Deploys",
                desc: "Reads your script, builds the app",
              },
              {
                num: "3",
                label: "Live App",
                desc: "URL, web UI, API — in 45 seconds",
              },
            ].map((s) => (
              <div key={s.num} className="step-stagger text-center">
                <div
                  className="w-9 h-9 rounded-full flex items-center justify-center mx-auto mb-2 text-[15px] font-bold text-white"
                  style={{ background: "#059669" }}
                >
                  {s.num}
                </div>
                <div
                  className="text-[14px] font-semibold mb-1"
                  style={{ color: "var(--floom-text)" }}
                >
                  {s.label}
                </div>
                <div
                  className="text-[12px]"
                  style={{ color: "var(--floom-text-muted)" }}
                >
                  {s.desc}
                </div>
              </div>
            ))}
          </div>

          {/* Demo layout */}
          <div
            data-reveal=""
            className="flex flex-col lg:flex-row gap-8 items-stretch"
          >
            {/* Code */}
            <div className="lg:w-[38%]">
              <div
                className="text-[12px] font-semibold uppercase tracking-[0.1em] mb-3"
                style={{ color: "var(--floom-text-dim)" }}
              >
                Your code
              </div>
              <div
                className="rounded-[16px] overflow-hidden"
                style={{ background: "#1a1a1a" }}
              >
                <div
                  className="px-4 py-2.5 flex items-center gap-2"
                  style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
                >
                  <span
                    className="w-[10px] h-[10px] rounded-full"
                    style={{ background: "#ff5f56" }}
                  />
                  <span
                    className="w-[10px] h-[10px] rounded-full"
                    style={{ background: "#ffbd2e" }}
                  />
                  <span
                    className="w-[10px] h-[10px] rounded-full"
                    style={{ background: "#27ca40" }}
                  />
                  <span
                    className="ml-2 text-[11px]"
                    style={{
                      fontFamily:
                        "var(--font-mono), 'JetBrains Mono', monospace",
                      color: "rgba(255,255,255,0.3)",
                    }}
                  >
                    app.py
                  </span>
                </div>
                <div
                  className="p-6 leading-[1.8]"
                  style={{
                    fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
                    fontSize: "13px",
                  }}
                >
                  <span style={{ color: "#6b7280" }}># app.py</span>
                  <br />
                  <span style={{ color: "#7dd3fc" }}>from</span>{" "}
                  <span style={{ color: "#34d399" }}>floom</span>{" "}
                  <span style={{ color: "#7dd3fc" }}>import</span>{" "}
                  <span style={{ color: "#e2e8f0" }}>app</span>
                  <br />
                  <br />
                  <span style={{ color: "#94a3b8" }}>@</span>
                  <span style={{ color: "#c4b5fd" }}>app.action</span>
                  <br />
                  <span style={{ color: "#7dd3fc" }}>def</span>{" "}
                  <span style={{ color: "#c4b5fd" }}>summarize_url</span>
                  <span style={{ color: "#94a3b8" }}>(</span>
                  <br />
                  {"    "}
                  <span style={{ color: "#e2e8f0" }}>url</span>
                  <span style={{ color: "#94a3b8" }}>:</span>{" "}
                  <span style={{ color: "#34d399" }}>str</span>
                  <span style={{ color: "#94a3b8" }}>,</span>
                  <br />
                  {"    "}
                  <span style={{ color: "#e2e8f0" }}>style</span>
                  <span style={{ color: "#94a3b8" }}>:</span>{" "}
                  <span style={{ color: "#34d399" }}>str</span>{" "}
                  <span style={{ color: "#94a3b8" }}>= </span>
                  <span style={{ color: "#34d399" }}>&quot;bullets&quot;</span>
                  <span style={{ color: "#94a3b8" }}>,</span>
                  <br />
                  <span style={{ color: "#94a3b8" }}>):</span>
                  <br />
                  {"    "}
                  <span style={{ color: "#7dd3fc" }}>return</span>{" "}
                  <span style={{ color: "#94a3b8" }}>{"{"}</span>
                  <span style={{ color: "#fbbf24" }}>&quot;summary&quot;</span>
                  <span style={{ color: "#94a3b8" }}>:</span>{" "}
                  <span style={{ color: "#34d399" }}>&quot;...&quot;</span>
                  <span style={{ color: "#94a3b8" }}>,</span>{" "}
                  <span style={{ color: "#fbbf24" }}>&quot;points&quot;</span>
                  <span style={{ color: "#94a3b8" }}>:</span>{" "}
                  <span style={{ color: "#94a3b8" }}>[...]</span>
                  <span style={{ color: "#94a3b8" }}>{"}"}</span>
                </div>
              </div>
            </div>

            {/* Pipeline steps */}
            <div className="lg:w-[24%] flex flex-col items-center justify-center gap-4">
              <div
                className="text-[12px] font-semibold uppercase tracking-[0.1em] text-center"
                style={{ color: "var(--floom-text-dim)" }}
              >
                floom deploys
              </div>
              <div
                className="w-full rounded-xl overflow-hidden"
                style={{
                  background: "var(--floom-card-bg)",
                  boxShadow: "var(--floom-card-shadow)",
                }}
              >
                <div
                  className="px-4 py-3 text-center"
                  style={{ borderBottom: "1px solid var(--floom-border)" }}
                >
                  <div
                    className="text-[11px] font-medium"
                    style={{ color: "var(--floom-text-muted)" }}
                  >
                    Building your app...
                  </div>
                </div>
                <div className="p-4 flex flex-col gap-2.5">
                  {[
                    "Reading your script...",
                    "Installing packages...",
                    "Building web UI...",
                  ].map((step) => (
                    <div
                      key={step}
                      className="step-stagger flex items-center gap-2.5"
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 20 20"
                        fill="#059669"
                      >
                        <path
                          fillRule="evenodd"
                          d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                          clipRule="evenodd"
                        />
                      </svg>
                      <span
                        className="text-[12px]"
                        style={{ color: "var(--floom-text-secondary)" }}
                      >
                        {step}
                      </span>
                    </div>
                  ))}
                  <div
                    className="step-stagger flex items-center gap-2.5 mt-1 pt-2"
                    style={{ borderTop: "1px solid var(--floom-border)" }}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 20 20"
                      fill="#059669"
                    >
                      <path
                        fillRule="evenodd"
                        d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                        clipRule="evenodd"
                      />
                    </svg>
                    <span
                      className="text-[13px] font-semibold"
                      style={{ color: "#059669" }}
                    >
                      Live at my-app.floom.dev
                    </span>
                  </div>
                </div>
              </div>
              <div className="text-center counter-reveal">
                <div
                  style={{
                    fontFamily: "var(--font-brand), 'DM Serif Display', serif",
                    fontSize: "42px",
                    color: "var(--floom-accent)",
                    lineHeight: 1,
                  }}
                >
                  45s
                </div>
                <div
                  className="text-[12px] mt-1"
                  style={{ color: "var(--floom-text-muted)" }}
                >
                  to go live
                </div>
              </div>
            </div>

            {/* Live app preview */}
            <div className="lg:w-[38%]">
              <div
                className="text-[12px] font-semibold uppercase tracking-[0.1em] mb-3"
                style={{ color: "var(--floom-text-dim)" }}
              >
                What users see
              </div>
              <div
                className="rounded-[20px] overflow-hidden relative"
                style={{
                  background: "var(--floom-card-bg)",
                  boxShadow: "var(--floom-card-shadow)",
                }}
              >
                <div className="grain-subtle" />
                <div
                  className="h-[44px] flex items-center px-5 gap-2"
                  style={{
                    background: "var(--floom-input-bg)",
                    borderBottom: "1px solid var(--floom-border)",
                  }}
                >
                  <span
                    className="w-[10px] h-[10px] rounded-full"
                    style={{ background: "#ff6b6b" }}
                  />
                  <span
                    className="w-[10px] h-[10px] rounded-full"
                    style={{ background: "#ffd43b" }}
                  />
                  <span
                    className="w-[10px] h-[10px] rounded-full"
                    style={{ background: "#51cf66" }}
                  />
                  <span
                    className="ml-4 px-4 py-1 rounded-md text-[12px]"
                    style={{
                      background: "var(--floom-input-hover)",
                      color: "var(--floom-text-muted)",
                      fontFamily:
                        "var(--font-mono), 'JetBrains Mono', monospace",
                    }}
                  >
                    my-app.floom.dev
                  </span>
                </div>
                <div className="p-7">
                  <div className="flex items-center gap-3 mb-2">
                    <span
                      className="text-[18px] font-bold"
                      style={{ color: "var(--floom-text)" }}
                    >
                      URL Summarizer
                    </span>
                    <span
                      className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-0.5 rounded-full live-pulse"
                      style={{
                        background: "var(--floom-accent-bg)",
                        color: "#059669",
                      }}
                    >
                      <span className="live-dot" />
                      Live
                    </span>
                  </div>
                  <p
                    className="text-[13px] mb-5"
                    style={{ color: "var(--floom-text-muted)" }}
                  >
                    Auto-generated from your Python function
                  </p>
                  {[
                    { label: "URL", value: "https://example.com/article" },
                    { label: "Style", value: "bullets" },
                  ].map((f) => (
                    <div key={f.label} className="mb-3.5">
                      <div
                        className="text-[12px] font-semibold mb-1.5"
                        style={{ color: "var(--floom-text-secondary)" }}
                      >
                        {f.label}
                      </div>
                      <div
                        className="px-4 py-2.5 rounded-[10px] text-[14px]"
                        style={{
                          background: "var(--floom-input-bg)",
                          border: "1px solid var(--floom-border)",
                          color: "var(--floom-text)",
                        }}
                      >
                        {f.value}
                      </div>
                    </div>
                  ))}
                  <button
                    className="w-full py-3 mt-2 rounded-[10px] text-[15px] font-semibold text-white"
                    style={{ background: "#047857", border: "none" }}
                  >
                    Summarize
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ══════════ WHAT YOU CAN BUILD ══════════ */}
      <section className="relative py-24 px-6">
        <div className="max-w-[1100px] mx-auto">
          <div data-reveal="" className="text-center mb-14">
            <div
              className="text-[12px] font-semibold uppercase tracking-[0.1em] mb-4"
              style={{ color: "var(--floom-text-dim)" }}
            >
              Showcase
            </div>
            <h2
              style={{
                fontFamily: "var(--font-brand), 'DM Serif Display', serif",
                fontSize: "clamp(32px, 3.5vw, 48px)",
                fontWeight: 400,
                color: "var(--floom-text)",
                lineHeight: 1.1,
              }}
            >
              What you can{" "}
              <em style={{ fontStyle: "italic", color: "var(--floom-accent)" }}>
                build
              </em>
            </h2>
          </div>

          <div data-reveal="" className="grid sm:grid-cols-3 gap-6">
            {/* Invoice Generator */}
            <div
              className="rounded-[20px] overflow-hidden floom-card-hover relative"
              style={{
                background: "var(--floom-card-bg)",
                border: "1px solid var(--floom-card-border)",
                boxShadow: "var(--floom-card-shadow)",
              }}
            >
              <div className="grain-subtle" />
              <div
                className="flex items-center gap-1.5 px-4 py-2.5"
                style={{
                  background: "var(--floom-bg-tertiary)",
                  borderBottom: "1px solid var(--floom-border)",
                }}
              >
                <span className="flex gap-1">
                  <span
                    className="w-[8px] h-[8px] rounded-full"
                    style={{ background: "#FF5F57" }}
                  />
                  <span
                    className="w-[8px] h-[8px] rounded-full"
                    style={{ background: "#FFBD2E" }}
                  />
                  <span
                    className="w-[8px] h-[8px] rounded-full"
                    style={{ background: "#28C840" }}
                  />
                </span>
                <span
                  className="flex-1 ml-2 px-2 py-0.5 rounded text-[11px] text-center overflow-hidden text-ellipsis"
                  style={{
                    background: "var(--floom-tab-pill-bg)",
                    color: "var(--floom-text-dim)",
                    fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
                    whiteSpace: "nowrap",
                  }}
                >
                  invoice.floom.dev
                </span>
                <span
                  className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ml-2 flex-shrink-0"
                  style={{
                    background: "var(--floom-accent-bg)",
                    color: "#059669",
                    border: "1px solid var(--floom-accent-border)",
                  }}
                >
                  <span
                    className="live-dot"
                    style={{ width: "5px", height: "5px" }}
                  />
                  Live
                </span>
              </div>
              <div className="p-5 min-h-[200px]">
                <div
                  className="text-[13px] font-bold mb-3"
                  style={{ color: "var(--floom-text)" }}
                >
                  Invoice Generator
                </div>
                {[
                  { l: "Client", v: "Acme Corp" },
                  { l: "Amount", v: "$2,500.00" },
                ].map((f) => (
                  <div key={f.l} className="mb-2">
                    <div
                      className="text-[9px] font-semibold uppercase tracking-wide mb-1"
                      style={{ color: "var(--floom-text-muted)" }}
                    >
                      {f.l}
                    </div>
                    <div
                      className="px-2.5 py-1.5 rounded-lg text-[12px]"
                      style={{
                        background: "var(--floom-bg-tertiary)",
                        border: "1px solid var(--floom-border)",
                        color: "var(--floom-text-secondary)",
                      }}
                    >
                      {f.v}
                    </div>
                  </div>
                ))}
                <div
                  className="w-full mt-3 py-2 rounded-lg text-[12px] font-semibold text-white text-center"
                  style={{ background: "#047857" }}
                >
                  Generate PDF
                </div>
              </div>
              <div
                className="px-4 py-3 flex items-center justify-between"
                style={{ borderTop: "1px solid var(--floom-border)" }}
              >
                <div className="flex gap-1">
                  {["Python", "PDF"].map((t) => (
                    <span
                      key={t}
                      className="text-[9px] font-semibold px-1.5 py-0.5 rounded"
                      style={{
                        background: "var(--floom-accent-bg)",
                        color: "#059669",
                        border: "1px solid var(--floom-accent-border)",
                      }}
                    >
                      {t}
                    </span>
                  ))}
                </div>
                <a
                  href="https://github.com/floomhq/floom"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] font-semibold floom-link"
                  style={{ color: "var(--floom-accent)" }}
                >
                  View template &rarr;
                </a>
              </div>
            </div>

            {/* CSV Analyzer */}
            <div
              className="rounded-[20px] overflow-hidden floom-card-hover relative"
              style={{
                background: "var(--floom-card-bg)",
                border: "1px solid var(--floom-card-border)",
                boxShadow: "var(--floom-card-shadow)",
              }}
            >
              <div className="grain-subtle" />
              <div
                className="flex items-center gap-1.5 px-4 py-2.5"
                style={{
                  background: "var(--floom-bg-tertiary)",
                  borderBottom: "1px solid var(--floom-border)",
                }}
              >
                <span className="flex gap-1">
                  <span
                    className="w-[8px] h-[8px] rounded-full"
                    style={{ background: "#FF5F57" }}
                  />
                  <span
                    className="w-[8px] h-[8px] rounded-full"
                    style={{ background: "#FFBD2E" }}
                  />
                  <span
                    className="w-[8px] h-[8px] rounded-full"
                    style={{ background: "#28C840" }}
                  />
                </span>
                <span
                  className="flex-1 ml-2 px-2 py-0.5 rounded text-[11px] text-center overflow-hidden text-ellipsis"
                  style={{
                    background: "var(--floom-tab-pill-bg)",
                    color: "var(--floom-text-dim)",
                    fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
                    whiteSpace: "nowrap",
                  }}
                >
                  csv-analyzer.floom.dev
                </span>
                <span
                  className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ml-2 flex-shrink-0"
                  style={{
                    background: "var(--floom-accent-bg)",
                    color: "#059669",
                    border: "1px solid var(--floom-accent-border)",
                  }}
                >
                  <span
                    className="live-dot"
                    style={{ width: "5px", height: "5px" }}
                  />
                  Live
                </span>
              </div>
              <div className="p-5 min-h-[200px]">
                <div
                  className="text-[13px] font-bold mb-3"
                  style={{ color: "var(--floom-text)" }}
                >
                  CSV Analyzer
                </div>
                <div
                  className="border-2 border-dashed rounded-xl p-3 text-center mb-3"
                  style={{
                    borderColor: "var(--floom-border)",
                    background: "var(--floom-bg-tertiary)",
                  }}
                >
                  <div
                    className="text-[11px]"
                    style={{ color: "var(--floom-text-muted)" }}
                  >
                    Drop CSV here or{" "}
                    <span style={{ color: "var(--floom-accent)" }}>browse</span>
                  </div>
                </div>
                <table
                  className="w-full"
                  style={{ fontSize: "10px", borderCollapse: "collapse" }}
                >
                  <thead>
                    <tr>
                      {["Name", "Q1", "Q2"].map((h) => (
                        <th
                          key={h}
                          className="text-left pb-1 font-semibold"
                          style={{
                            color: "var(--floom-text-muted)",
                            borderBottom: "1px solid var(--floom-border)",
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ["Alice", "$4.2k", "+12%"],
                      ["Bob", "$3.8k", "+8%"],
                    ].map((r, i) => (
                      <tr key={i}>
                        {r.map((c, j) => (
                          <td
                            key={j}
                            className="py-1"
                            style={{
                              color:
                                j === 2
                                  ? "#059669"
                                  : "var(--floom-text-secondary)",
                              borderBottom:
                                "1px solid var(--floom-border-subtle)",
                            }}
                          >
                            {c}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div
                className="px-4 py-3 flex items-center justify-between"
                style={{ borderTop: "1px solid var(--floom-border)" }}
              >
                <div className="flex gap-1">
                  {["Pandas", "Charts"].map((t) => (
                    <span
                      key={t}
                      className="text-[9px] font-semibold px-1.5 py-0.5 rounded"
                      style={{
                        background: "var(--floom-accent-bg)",
                        color: "#059669",
                        border: "1px solid var(--floom-accent-border)",
                      }}
                    >
                      {t}
                    </span>
                  ))}
                </div>
                <a
                  href="https://github.com/floomhq/floom"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] font-semibold floom-link"
                  style={{ color: "var(--floom-accent)" }}
                >
                  View template &rarr;
                </a>
              </div>
            </div>

            {/* Resume Screener */}
            <div
              className="rounded-[20px] overflow-hidden floom-card-hover relative"
              style={{
                background: "var(--floom-card-bg)",
                border: "1px solid var(--floom-card-border)",
                boxShadow: "var(--floom-card-shadow)",
              }}
            >
              <div className="grain-subtle" />
              <div
                className="flex items-center gap-1.5 px-4 py-2.5"
                style={{
                  background: "var(--floom-bg-tertiary)",
                  borderBottom: "1px solid var(--floom-border)",
                }}
              >
                <span className="flex gap-1">
                  <span
                    className="w-[8px] h-[8px] rounded-full"
                    style={{ background: "#FF5F57" }}
                  />
                  <span
                    className="w-[8px] h-[8px] rounded-full"
                    style={{ background: "#FFBD2E" }}
                  />
                  <span
                    className="w-[8px] h-[8px] rounded-full"
                    style={{ background: "#28C840" }}
                  />
                </span>
                <span
                  className="flex-1 ml-2 px-2 py-0.5 rounded text-[11px] text-center overflow-hidden text-ellipsis"
                  style={{
                    background: "var(--floom-tab-pill-bg)",
                    color: "var(--floom-text-dim)",
                    fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
                    whiteSpace: "nowrap",
                  }}
                >
                  screener.floom.dev
                </span>
                <span
                  className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ml-2 flex-shrink-0"
                  style={{
                    background: "var(--floom-accent-bg)",
                    color: "#059669",
                    border: "1px solid var(--floom-accent-border)",
                  }}
                >
                  <span
                    className="live-dot"
                    style={{ width: "5px", height: "5px" }}
                  />
                  Live
                </span>
              </div>
              <div className="p-5 min-h-[200px]">
                <div
                  className="text-[13px] font-bold mb-3"
                  style={{ color: "var(--floom-text)" }}
                >
                  Resume Screener
                </div>
                <div className="text-center mb-3">
                  <div
                    className="text-[9px] font-semibold uppercase tracking-wide mb-2"
                    style={{ color: "var(--floom-text-muted)" }}
                  >
                    Match Score
                  </div>
                  <div
                    className="w-full h-2 rounded-full overflow-hidden mb-1"
                    style={{ background: "var(--floom-bg-tertiary)" }}
                  >
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: "82%",
                        background: "linear-gradient(90deg, #059669, #34D399)",
                      }}
                    />
                  </div>
                  <div
                    style={{
                      fontFamily:
                        "var(--font-brand), 'DM Serif Display', serif",
                      fontSize: "28px",
                      color: "var(--floom-accent)",
                    }}
                  >
                    82
                  </div>
                  <div
                    className="text-[11px]"
                    style={{ color: "var(--floom-text-muted)" }}
                  >
                    Strong match
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  {[
                    "5+ years Python",
                    "Team lead experience",
                    "Startup background",
                  ].map((f) => (
                    <div
                      key={f}
                      className="text-[11px] flex items-center gap-1.5"
                      style={{ color: "var(--floom-text-secondary)" }}
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 20 20"
                        fill="#059669"
                      >
                        <path
                          fillRule="evenodd"
                          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                      {f}
                    </div>
                  ))}
                </div>
              </div>
              <div
                className="px-4 py-3 flex items-center justify-between"
                style={{ borderTop: "1px solid var(--floom-border)" }}
              >
                <div className="flex gap-1">
                  {["AI", "NLP"].map((t) => (
                    <span
                      key={t}
                      className="text-[9px] font-semibold px-1.5 py-0.5 rounded"
                      style={{
                        background: "var(--floom-accent-bg)",
                        color: "#059669",
                        border: "1px solid var(--floom-accent-border)",
                      }}
                    >
                      {t}
                    </span>
                  ))}
                </div>
                <a
                  href="https://github.com/floomhq/floom"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] font-semibold floom-link"
                  style={{ color: "var(--floom-accent)" }}
                >
                  View template &rarr;
                </a>
              </div>
            </div>
          </div>

          {/* Use case pills */}
          <div
            data-reveal=""
            className="flex justify-center flex-wrap gap-2 mt-10"
          >
            {[
              "Invoice Generator",
              "CSV Analyzer",
              "PDF Merger",
              "Email Drafter",
              "Image Resizer",
              "Price Tracker",
              "Data Validator",
              "Report Builder",
            ].map((pill) => (
              <span
                key={pill}
                className="px-3 py-1.5 rounded-full text-[12px] font-medium"
                style={{
                  background: "var(--floom-card-bg)",
                  border: "1px solid var(--floom-border)",
                  color: "var(--floom-text-muted)",
                }}
              >
                {pill}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ══════════ PROBLEM ══════════ */}
      <section className="relative py-24 px-6 floom-section-alt">
        <div className="max-w-[1100px] mx-auto">
          <div data-reveal="" className="mb-12">
            <div
              className="text-[13px] font-semibold uppercase tracking-[0.1em] mb-4"
              style={{ color: "var(--floom-text-dim)" }}
            >
              Problem
            </div>
            <h2
              style={{
                fontFamily: "var(--font-brand), 'DM Serif Display', serif",
                fontSize: "clamp(32px, 4vw, 52px)",
                fontWeight: 400,
                color: "var(--floom-text)",
                lineHeight: 1.15,
              }}
            >
              AI Writes the Code.{" "}
              <em style={{ fontStyle: "italic", color: "var(--floom-accent)" }}>
                Then It Gets Stuck on Your Computer.
              </em>
            </h2>
          </div>

          <div data-reveal="" className="flex flex-col lg:flex-row gap-8">
            <div
              className="lg:w-[40%] rounded-[20px] p-10 flex flex-col justify-center"
              style={{
                background: "var(--floom-quote-card-bg)",
                border: "1px solid var(--floom-card-border)",
                boxShadow: "var(--floom-card-shadow)",
              }}
            >
              <div
                style={{
                  fontFamily: "var(--font-brand), 'DM Serif Display', serif",
                  fontSize: "72px",
                  color: "var(--floom-accent)",
                  lineHeight: 1,
                }}
              >
                &ldquo;
              </div>
              <p
                className="text-[20px] font-medium leading-[1.6] mt-2"
                style={{ color: "var(--floom-text)" }}
              >
                Built it in{" "}
                <strong style={{ color: "var(--floom-quote-highlight)" }}>
                  2 hours
                </strong>
                . Spent{" "}
                <strong style={{ color: "var(--floom-quote-highlight)" }}>
                  3 days
                </strong>{" "}
                trying to deploy it. Gave up. Shared the GitHub link.
              </p>
              <p
                className="text-[13px] mt-5"
                style={{ color: "var(--floom-text-muted)" }}
              >
                Posted daily on Reddit, HackerNews, and X
              </p>
            </div>

            <div className="lg:w-[60%] flex flex-col gap-4">
              {[
                {
                  title: "Can't Put It Online",
                  desc: "Servers, domains, security. Most give up before anyone else can use it.",
                  stat: "3-7 days",
                  statLabel: "to go live",
                  icon: (
                    <path d="M18 10h-4V6M14 10l7.7-7.7M20 4v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4M2 17h20v3a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-3z" />
                  ),
                },
                {
                  title: "Can't Share",
                  desc: "Your script works in the terminal. Your client can't open a terminal.",
                  stat: "2-3 weeks",
                  statLabel: "to build a UI",
                  icon: (
                    <>
                      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                      <circle cx="9" cy="7" r="4" />
                      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                    </>
                  ),
                },
                {
                  title: "Can't Monetize",
                  desc: "No app store for scripts. No payment flow. The tool dies as a GitHub link.",
                  stat: "$0",
                  statLabel: "revenue",
                  icon: (
                    <>
                      <line x1="12" y1="1" x2="12" y2="23" />
                      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                    </>
                  ),
                },
              ].map((p) => (
                <div
                  key={p.title}
                  className="rounded-[20px] p-7 flex items-center gap-6 floom-card-hover"
                  style={{
                    background: "var(--floom-card-bg)",
                    boxShadow: "var(--floom-card-shadow)",
                  }}
                >
                  <div
                    className="w-12 h-12 min-w-[48px] rounded-xl flex items-center justify-center"
                    style={{ background: "var(--floom-problem-bg)" }}
                  >
                    <svg
                      width="22"
                      height="22"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#ef4444"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      {p.icon}
                    </svg>
                  </div>
                  <div className="flex-1">
                    <div
                      className="text-[17px] font-bold mb-1"
                      style={{ color: "var(--floom-text)" }}
                    >
                      {p.title}
                    </div>
                    <div
                      className="text-[14px] leading-[1.6]"
                      style={{ color: "var(--floom-text-secondary)" }}
                    >
                      {p.desc}
                    </div>
                  </div>
                  <div className="text-right min-w-[60px] sm:min-w-[80px]">
                    <div
                      className="text-[20px] sm:text-[26px] font-bold"
                      style={{ color: "#ef4444" }}
                    >
                      {p.stat}
                    </div>
                    <div
                      className="text-[10px] sm:text-[11px] uppercase tracking-wide"
                      style={{ color: "var(--floom-text-muted)" }}
                    >
                      {p.statLabel}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ══════════ WHAT YOU GET ══════════ */}
      <section className="relative py-24 px-6">
        <div className="max-w-[1100px] mx-auto">
          <div data-reveal="" className="mb-12">
            <div
              className="text-[13px] font-semibold uppercase tracking-[0.1em] mb-4"
              style={{ color: "var(--floom-text-dim)" }}
            >
              What you get
            </div>
            <h2
              style={{
                fontFamily: "var(--font-brand), 'DM Serif Display', serif",
                fontSize: "clamp(32px, 4vw, 52px)",
                fontWeight: 400,
                color: "var(--floom-text)",
                lineHeight: 1.15,
              }}
            >
              One Script.{" "}
              <em style={{ fontStyle: "italic", color: "var(--floom-accent)" }}>
                Four Outputs.
              </em>
            </h2>
          </div>

          <div
            data-reveal=""
            className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5"
          >
            {[
              {
                title: "Live URL",
                desc: "Shareable link, instant",
                icon: (
                  <>
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                  </>
                ),
              },
              {
                title: "Web UI",
                desc: "Auto-generated from your code",
                icon: (
                  <>
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <path d="M3 9h18" />
                    <path d="M9 21V9" />
                  </>
                ),
              },
              {
                title: "REST API",
                desc: "Connect to Zapier, Make, Slack and 5,000+ tools",
                icon: (
                  <>
                    <polyline points="16 18 22 12 16 6" />
                    <polyline points="8 6 2 12 8 18" />
                    <line x1="14" y1="4" x2="10" y2="20" />
                  </>
                ),
              },
              {
                title: "MCP Tool",
                desc: "Let Claude, Cursor, and other AI agents call your app",
                icon: (
                  <>
                    <path d="M12 2C6.48 2 2 4.69 2 8v8c0 3.31 4.48 6 10 6s10-2.69 10-6V8c0-3.31-4.48-6-10-6z" />
                    <path d="M2 8c0 3.31 4.48 6 10 6s10-2.69 10-6" />
                  </>
                ),
              },
            ].map((item) => (
              <div
                key={item.title}
                className="rounded-[20px] p-7 flex flex-col floom-card-hover"
                style={{
                  background: "var(--floom-card-bg)",
                  boxShadow: "var(--floom-card-shadow)",
                }}
              >
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center mb-4"
                  style={{ background: "var(--floom-accent-bg)" }}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#059669"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    {item.icon}
                  </svg>
                </div>
                <div
                  className="text-[17px] font-bold mb-1"
                  style={{ color: "var(--floom-text)" }}
                >
                  {item.title}
                </div>
                <div
                  className="text-[14px]"
                  style={{ color: "var(--floom-text-muted)" }}
                >
                  {item.desc}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══════════ COPY PROMPT CTA ══════════ */}
      <section className="relative py-16 px-6 floom-section-alt">
        <div className="max-w-[680px] mx-auto">
          <div
            data-reveal=""
            className="rounded-[20px] p-8"
            style={{
              background: "var(--floom-card-bg)",
              boxShadow: "var(--floom-card-shadow)",
            }}
          >
            <div className="flex items-center gap-2 mb-3">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#059669"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
              <span
                className="text-[14px] font-semibold"
                style={{ color: "#059669" }}
              >
                Try it now — copy this prompt into ChatGPT or Claude
              </span>
            </div>
            <p
              className="text-[13px] mb-5"
              style={{ color: "var(--floom-text-secondary)" }}
            >
              Not a toy script. A real app with forms, memory, and multiple
              pages.
            </p>
            <button
              onClick={() => {
                const prompt = `Write a Python app using the Floom framework. Here's how it works:\n\nfrom floom import app, remember\nfrom typing import Literal\n\n@app.action\ndef do_something(text: str, mode: Literal["fast", "detailed"] = "fast") -> dict:\n    count = (remember("runs") or 0) + 1\n    remember("runs", count)\n    return {"result": "...", "run_number": count}\n\nRules:\n- @app.action on each function (multiple actions = multiple pages in the app)\n- Type hints become the UI: str=text, int/float=number, bool=checkbox, Literal["a","b"]=dropdown\n- Return a dict (becomes the output card)\n- remember(key, value) saves data between runs; remember(key) reads it back\n- Any pip packages auto-install\n- Do NOT use requests, urllib, or any network calls (sandbox has no internet)\n\nNow write an app that [DESCRIBE WHAT YOU WANT].`;
                navigator.clipboard.writeText(prompt);
                const btn = document.getElementById("copy-prompt-btn");
                if (btn) {
                  btn.textContent = "Copied!";
                  setTimeout(() => {
                    if (btn) btn.textContent = "Copy Prompt";
                  }, 2000);
                }
              }}
              id="copy-prompt-btn"
              className="w-full text-[14px] font-semibold px-4 py-3 rounded-xl transition-all hover:opacity-90"
              style={{
                background: "transparent",
                border: "1px solid #059669",
                color: "#059669",
              }}
            >
              Copy Prompt
            </button>
            <button
              onClick={() => setShowPowerPrompt(!showPowerPrompt)}
              className="w-full text-[12px] mt-2 text-center transition-colors hover:underline"
              style={{
                color: "var(--floom-text-muted)",
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: "4px 0",
              }}
            >
              {showPowerPrompt
                ? "Hide full SDK prompt"
                : "Need more power? Copy the full SDK prompt →"}
            </button>
            {showPowerPrompt && (
              <button
                onClick={() => {
                  const powerPrompt = `Write a Python app using Floom. Full SDK:\n\nfrom floom import app, remember, forget, db, save_artifact, save_json\nfrom typing import Literal\n\n@app.action\ndef my_action(text: str, n: int = 5, mode: Literal["fast","slow"] = "fast") -> dict:\n    return {"result": "..."}\n\nMULTIPLE ACTIONS (one file = multiple pages):\n@app.action(name="add")\ndef add_item(text: str) -> dict: ...\n@app.action(name="list")\ndef list_items() -> dict: ...\n\nPERSISTENT MEMORY:\nremember("key", value)  # save\nremember("key")          # read\nforget("key")            # delete\n\nSQLITE DATABASE:\ndb.execute("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT)")\ndb.execute("INSERT INTO items (name) VALUES (?)", (name,))\nrows = db.execute("SELECT * FROM items").fetchall()\n\nFILE OUTPUT (downloadable by users):\nsave_artifact("report.html", "<h1>Done</h1>")\nsave_json("data.json", {"key": "value"})\n\nTYPES -> UI: str=text, int/float=number, bool=checkbox, Literal[...]=dropdown, dict=JSON editor\n\nRULES: Always return dict. Any pip packages auto-install. No network calls.\n\nBuild: [YOUR APP IDEA]`;
                  navigator.clipboard.writeText(powerPrompt);
                  const btn = document.getElementById("copy-power-prompt-btn");
                  if (btn) {
                    btn.textContent = "Copied!";
                    setTimeout(() => {
                      if (btn) btn.textContent = "Copy Full Prompt";
                    }, 2000);
                  }
                }}
                id="copy-power-prompt-btn"
                className="w-full text-[12px] font-semibold px-4 py-2.5 rounded-xl transition-all hover:opacity-90 mt-2"
                style={{
                  background: "transparent",
                  border: "1px solid rgba(5,150,105,0.3)",
                  color: "#059669",
                }}
              >
                Copy Full Prompt
              </button>
            )}
          </div>
        </div>
      </section>

      {/* ══════════ AGENT DISTRIBUTION ══════════ */}
      <section className="relative py-16 px-6">
        <div data-reveal="" className="max-w-[680px] mx-auto">
          <div
            className="text-[12px] font-semibold uppercase tracking-[0.1em] mb-4 text-center"
            style={{ color: "var(--floom-text-dim)" }}
          >
            For Claude Code + Cursor users
          </div>
          <h2
            className="text-center mb-8"
            style={{
              fontFamily: "var(--font-brand), 'DM Serif Display', serif",
              fontSize: "clamp(28px, 3vw, 40px)",
              fontWeight: 400,
              color: "var(--floom-text)",
              lineHeight: 1.15,
            }}
          >
            Make floom the{" "}
            <em style={{ fontStyle: "italic", color: "var(--floom-accent)" }}>
              default.
            </em>
          </h2>

          <div className="flex flex-col gap-4">
            {/* Skill install */}
            <div
              className="rounded-[20px] p-6"
              style={{
                background: "var(--floom-card-bg)",
                boxShadow: "var(--floom-card-shadow)",
              }}
            >
              <div className="flex items-center gap-2 mb-2">
                <div
                  className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ background: "var(--floom-accent-bg)" }}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#059669"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <path d="M12 2L2 7l10 5 10-5-10-5z" />
                    <path d="M2 17l10 5 10-5" />
                    <path d="M2 12l10 5 10-5" />
                  </svg>
                </div>
                <span
                  className="text-[14px] font-semibold"
                  style={{ color: "var(--floom-text)" }}
                >
                  Add floom skill to Claude Code
                </span>
              </div>
              <p
                className="text-[13px] mb-4"
                style={{ color: "var(--floom-text-secondary)" }}
              >
                One command. Every future Claude session in any project reaches
                for floom automatically.
              </p>
              <div
                className="rounded-xl px-4 py-3 flex items-center justify-between gap-3"
                style={{
                  background: "var(--floom-bg-tertiary)",
                  border: "1px solid var(--floom-border)",
                }}
              >
                <code
                  className="text-[12px] flex-1 min-w-0 truncate"
                  style={{
                    fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
                    color: "var(--floom-text-secondary)",
                  }}
                >
                  git clone https://github.com/floomhq/floom.git
                  ~/.claude/skills/floom-repo &amp;&amp;
                  ~/.claude/skills/floom-repo/scripts/setup
                </code>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(
                      "git clone https://github.com/floomhq/floom.git ~/.claude/skills/floom-repo && ~/.claude/skills/floom-repo/scripts/setup"
                    );
                    const btn = document.getElementById("copy-skill-btn");
                    if (btn) {
                      btn.textContent = "Copied!";
                      setTimeout(() => {
                        if (btn) btn.textContent = "Copy";
                      }, 2000);
                    }
                  }}
                  id="copy-skill-btn"
                  className="text-[11px] font-semibold px-3 py-1.5 rounded-lg flex-shrink-0 transition-all hover:opacity-80"
                  style={{
                    background: "var(--floom-accent-bg)",
                    color: "#059669",
                    border: "1px solid var(--floom-accent-border)",
                  }}
                >
                  Copy
                </button>
              </div>
            </div>

            {/* Badge */}
            <div
              className="rounded-[20px] p-6"
              style={{
                background: "var(--floom-card-bg)",
                boxShadow: "var(--floom-card-shadow)",
              }}
            >
              <div className="flex items-center gap-2 mb-2">
                <div
                  className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ background: "var(--floom-accent-bg)" }}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#059669"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
                  </svg>
                </div>
                <span
                  className="text-[14px] font-semibold"
                  style={{ color: "var(--floom-text)" }}
                >
                  Add a Deploy badge to your README
                </span>
              </div>
              <p
                className="text-[13px] mb-4"
                style={{ color: "var(--floom-text-secondary)" }}
              >
                Agents reading your repo see floom as the deploy target. One
                line.
              </p>
              <div
                className="rounded-xl px-4 py-3 flex items-center justify-between gap-3"
                style={{
                  background: "var(--floom-bg-tertiary)",
                  border: "1px solid var(--floom-border)",
                }}
              >
                <code
                  className="text-[12px] flex-1 min-w-0 truncate"
                  style={{
                    fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
                    color: "var(--floom-text-secondary)",
                  }}
                >
                  {
                    "[![Deploy on floom](https://floom.dev/badge.svg)](https://floom.dev/deploy)"
                  }
                </code>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(
                      "[![Deploy on floom](https://floom.dev/badge.svg)](https://floom.dev/deploy)"
                    );
                    const btn = document.getElementById("copy-badge-btn");
                    if (btn) {
                      btn.textContent = "Copied!";
                      setTimeout(() => {
                        if (btn) btn.textContent = "Copy";
                      }, 2000);
                    }
                  }}
                  id="copy-badge-btn"
                  className="text-[11px] font-semibold px-3 py-1.5 rounded-lg flex-shrink-0 transition-all hover:opacity-80"
                  style={{
                    background: "var(--floom-accent-bg)",
                    color: "#059669",
                    border: "1px solid var(--floom-accent-border)",
                  }}
                >
                  Copy
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ══════════ BUILT BY ══════════ */}
      <section className="relative py-16 px-6">
        <div data-reveal="" className="max-w-[680px] mx-auto">
          <div
            className="rounded-[20px] p-7 flex flex-col sm:flex-row items-start gap-5"
            style={{
              background: "var(--floom-card-bg)",
              boxShadow: "var(--floom-card-shadow)",
            }}
          >
            <img
              src="/about/federico.png"
              alt="Federico De Ponte"
              className="w-14 h-14 min-w-[56px] rounded-full object-cover"
            />
            <div>
              <div
                className="text-[15px] font-bold mb-1"
                style={{ color: "var(--floom-text)" }}
              >
                Built by Federico De Ponte
              </div>
              <p
                className="text-[14px] leading-[1.6] mb-3"
                style={{ color: "var(--floom-text-secondary)" }}
              >
                Ex-BCG, co-founded SCAILE ($600K ARR). Writing AI-generated code
                fast enough that deploying it became the bottleneck. So I built
                floom: the production layer for AI-written code.
              </p>
            </div>
          </div>

          {stars && (
            <div className="flex items-center justify-center gap-3 mt-6">
              <a
                href="https://github.com/floomhq/floom"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-[13px] font-medium px-5 py-2.5 rounded-xl transition-all hover:opacity-80 floom-outline-btn"
                style={{
                  color: "var(--floom-text-secondary)",
                  border: "1px solid var(--floom-outline-border)",
                }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="var(--floom-github-fill)"
                >
                  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                </svg>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                </svg>
                {stars} stars{lastPush ? ` · updated ${lastPush}` : ""}
              </a>
            </div>
          )}
        </div>
      </section>

      {/* ══════════ FINAL CTA ══════════ */}
      <section className="relative py-24 px-6 floom-section-alt">
        <div
          data-reveal=""
          className="relative z-10 max-w-[680px] mx-auto text-center"
        >
          <div
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[250px] pointer-events-none"
            style={{
              background:
                "radial-gradient(ellipse, rgba(16,185,129,0.06) 0%, transparent 70%)",
            }}
          />

          <h2
            className="mb-4 relative"
            style={{
              fontFamily: "var(--font-brand), 'DM Serif Display', serif",
              fontSize: "clamp(36px, 4.5vw, 56px)",
              fontWeight: 400,
              color: "var(--floom-text)",
              lineHeight: 1.1,
            }}
          >
            Your script deserves an{" "}
            <em style={{ fontStyle: "italic", color: "var(--floom-accent)" }}>
              audience.
            </em>
          </h2>
          <p
            className="text-[16px] mb-3 relative"
            style={{ color: "var(--floom-text-secondary)" }}
          >
            It&apos;s in your ChatGPT history. Put it at a URL.
          </p>
          <p
            className="text-[13px] mb-10 relative"
            style={{ color: "var(--floom-text-dim)" }}
          >
            Free and open source. Takes less than a minute.
          </p>

          <div className="flex flex-wrap items-center justify-center gap-4 mb-6 relative">
            <a
              href="https://dashboard.floom.dev/sign-up"
              className="cta-primary px-8 py-3.5 text-[16px] font-semibold text-white rounded-xl transition-all"
            >
              Ship your first script
            </a>
            <a
              href="https://github.com/floomhq/floom"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-6 py-3.5 text-[14px] font-medium rounded-xl transition-all floom-outline-btn"
              style={{
                color: "var(--floom-text-secondary)",
                border: "1px solid var(--floom-outline-border)",
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="var(--floom-github-fill)"
              >
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
              </svg>
              Star on GitHub{stars ? ` (${stars})` : ""}
            </a>
          </div>

          <div className="flex justify-center gap-4 relative">
            {["Free", "Open source", "No credit card"].map((t, i) => (
              <span
                key={t}
                className="text-[12px]"
                style={{ color: "var(--floom-text-dim)" }}
              >
                {i > 0 && (
                  <span
                    className="mr-4"
                    style={{ color: "var(--floom-text-dimmer)" }}
                  >
                    &middot;
                  </span>
                )}
                {t}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ══════════ FOOTER ══════════ */}
      <footer
        className="py-8 px-6"
        style={{ borderTop: "1px solid var(--floom-border)" }}
      >
        <div className="max-w-[1100px] mx-auto">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
            <div className="flex items-center gap-2.5">
              <svg
                className="w-4 h-4"
                viewBox="0 0 48 48"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M10 6 Q4 6 4 12 L4 36 Q4 42 10 42 L28 42 L44 24 L28 6 Z"
                  fill="#059669"
                />
              </svg>
              <span
                className="text-[13px] font-bold"
                style={{ color: "var(--floom-text)" }}
              >
                floom
              </span>
            </div>
            <div
              className="flex items-center gap-6 text-[12px]"
              style={{ color: "var(--floom-text-muted)" }}
            >
              <a
                href="https://github.com/floomhq/floom"
                target="_blank"
                rel="noopener noreferrer"
                className="floom-link"
              >
                GitHub
              </a>
              <a
                href="https://github.com/floomhq/floom#quick-start"
                target="_blank"
                rel="noopener noreferrer"
                className="floom-link"
              >
                Docs
              </a>
              <a href="mailto:fede@floom.dev" className="floom-link">
                Contact
              </a>
            </div>
          </div>
          <div
            className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 pt-4"
            style={{ borderTop: "1px solid var(--floom-border)" }}
          >
            <span
              className="text-[11px]"
              style={{ color: "var(--floom-text-dimmer)" }}
            >
              &copy; 2026 floom. MIT License.
            </span>
            <div
              className="flex items-center gap-4 text-[11px]"
              style={{ color: "var(--floom-text-dimmer)" }}
            >
              <span>Made in San Francisco</span>
            </div>
          </div>
        </div>
      </footer>

      {/* Sticky mobile CTA */}
      <div
        className="fixed bottom-0 inset-x-0 z-40 sm:hidden px-4 py-3 backdrop-blur-xl"
        style={{
          background: "var(--floom-nav-bg)",
          borderTop: "1px solid var(--floom-border)",
        }}
      >
        <a
          href="https://dashboard.floom.dev/sign-up"
          className="flex items-center justify-center w-full py-3 rounded-xl text-[14px] font-semibold text-white transition-all"
          style={{ background: "#047857" }}
        >
          Paste your code
        </a>
      </div>
    </div>
  );
}
