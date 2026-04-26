// /about — the Floom story page.
//
// 2026-04-20: replaces the old `/about` → `/` redirect. A real page that
// tells creators + biz users what Floom is, who it's for, and what it
// isn't. H1 "Get that thing off localhost fast." lives alongside the
// landing H1 (currently "Production infrastructure for AI apps that do
// real work." / after H1-swap "Ship AI apps fast.") — the two taglines
// coexist: landing leads with what you get, About leads with the pain
// Floom solves.
//
// Rules applied: no em dashes, plain language (no "infrastructure",
// "orchestration", "abstraction layer" in body copy), Federico's voice
// ("your thing"), real numbers only (100 apps live, MIT, one founder),
// no invented stats.
//
// Structure (5 sections):
//   1. Hero: H1 + one-sentence mission restatement
//   2. Who Floom is for: two side-by-side cards (vibecoders + biz users)
//   3. Why headless: the standardization/security/speed argument
//   4. What Floom isn't: three negations
//   5. Who's behind it: Federico + Floom Inc + OSS commitment
//   + Footer CTA band: "Paste your app" → /studio/build

import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PageShell } from '../components/PageShell';
import { WhosBehind } from '../components/home/WhosBehind';
import { readDeployEnabled } from '../lib/flags';
import { waitlistHref } from '../lib/waitlistCta';

// ── Shared styles ─────────────────────────────────────────────────────────

const SECTION_STYLE: React.CSSProperties = {
  maxWidth: 820,
  margin: '0 auto',
  padding: '56px 0',
};

const SECTION_BORDERED: React.CSSProperties = {
  ...SECTION_STYLE,
  borderTop: '1px solid var(--line)',
};

const EYEBROW_STYLE: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 11,
  fontWeight: 700,
  color: 'var(--muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  margin: '0 0 12px',
};

const H2_STYLE: React.CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontWeight: 700,
  fontSize: 32,
  lineHeight: 1.2,
  letterSpacing: '-0.02em',
  color: 'var(--ink)',
  margin: '0 0 20px',
};

const BODY_STYLE: React.CSSProperties = {
  fontSize: 17,
  lineHeight: 1.7,
  color: 'var(--ink)',
  margin: '0 0 16px',
};

const MUTED_BODY_STYLE: React.CSSProperties = {
  ...BODY_STYLE,
  color: 'var(--muted)',
};

// ── Page ──────────────────────────────────────────────────────────────────

export function AboutPage() {
  const deployEnabled = useMemo(() => readDeployEnabled(), []);
  const navigate = useNavigate();

  return (
    <PageShell
      title="About · Floom"
      description="Floom is the protocol and runtime for agentic work — built so vibecoders and business users can ship AI apps without wiring auth, rate limits, sandboxing, or MCP tooling themselves."
      contentStyle={{ padding: '24px 24px 80px', maxWidth: 960 }}
    >
      {/* 1. Hero */}
      <section
        data-testid="about-hero"
        style={{ ...SECTION_STYLE, padding: '72px 0 56px', textAlign: 'center' }}
      >
        <p style={{ ...EYEBROW_STYLE, textAlign: 'center' }}>About Floom</p>
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 800,
            fontSize: 52,
            lineHeight: 1.08,
            letterSpacing: '-0.025em',
            color: 'var(--ink)',
            margin: '0 0 20px',
            textWrap: 'balance' as unknown as 'balance',
          }}
        >
          Get that thing off localhost fast.
        </h1>
        <p
          style={{
            fontSize: 19,
            lineHeight: 1.55,
            color: 'var(--muted)',
            margin: '0 auto',
            maxWidth: 640,
            textWrap: 'balance' as unknown as 'balance',
          }}
        >
          Floom exists for one reason: to turn your code into a real app
          with a real URL so other people can actually use it.
        </p>
      </section>

      {/* 2. Who Floom is for */}
      <section data-testid="about-who-for" style={SECTION_BORDERED}>
        <p style={EYEBROW_STYLE}>Who Floom is for</p>
        <h2 style={H2_STYLE}>Two groups, equal weight.</h2>
        <p style={MUTED_BODY_STYLE}>
          Floom has two kinds of users. One builds the thing. The other
          just wants to use the thing. We care about both the same.
        </p>

        <div
          className="about-who-cards"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: 20,
            margin: '28px 0 0',
          }}
        >
          <WhoCard
            tag="Vibecoders"
            title="People who build real tools with Cursor, Lovable, ChatGPT."
            body={
              deployEnabled ? (
                <>
                  You have something useful running on your laptop. Your
                  coworkers cannot use it because your coworkers cannot run
                  Python. Floom gives your thing a real URL.
                </>
              ) : (
                <>
                  You have something useful running on your laptop. Your
                  coworkers cannot use it if they cannot run your stack. On
                  floom.dev you can run apps and wire them into Claude via MCP
                  today. Publishing your own app to our hosted runtime is
                  waitlist-only; self-host is always open.
                </>
              )
            }
          />
          {/* Tag copy 2026-04-24 (audit): was "Biz users". Rendered uppercase
              with letter-spacing it read as "BIZ USERS" / "BIG USERS" and was
              ambiguous on first glance (business? frequent? corporate?).
              Swapped to "Users" to pair cleanly with "Vibecoders" above —
              one short noun per card, same grammatical weight. Internal ICP
              notes elsewhere in the codebase still say "biz users" for
              clarity; the customer-facing label is what moves here. */}
          <WhoCard
            tag="Users"
            title="People who need to use AI tools at work, not build them."
            body={
              <>
                A colleague built something. You want to run it once, get
                an answer, move on. Floom is the shareable link that just
                works. No install, no setup.
              </>
            }
          />
        </div>

      </section>

      {/* 3. Why headless */}
      <section data-testid="about-why-headless" style={SECTION_BORDERED}>
        <p style={EYEBROW_STYLE}>Why headless</p>
        <h2 style={H2_STYLE}>Floom is not another AI chat window.</h2>
        <p style={BODY_STYLE}>
          Every app's shape comes from its inputs and outputs, not from a
          chat box we bolt on top. That one choice buys three things:
        </p>

        <div
          style={{
            display: 'grid',
            gap: 16,
            margin: '24px 0 0',
          }}
        >
          <Triad
            label="More secure"
            body="Standardizing around one protocol shrinks the attack surface. No user-generated UI, no custom-rendered HTML bugs, no chat-prompt tricks on the input side."
          />
          <Triad
            label="Faster to go live"
            body={
              deployEnabled
                ? 'You ship a spec, not a UI. The page draws itself from your fields. Publish, share the link, done.'
                : 'You ship a spec, not a UI. The page draws itself from your fields. When you have publish access on floom.dev (or on your self-hosted instance), share the link and you are done.'
            }
          />
          <Triad
            label="Less ambiguity"
            body="Creators don't debate what interface to build. Users don't wonder 'is this a chat app or a dashboard?' The app looks like its job."
          />
        </div>
      </section>

      {/* 4. What Floom isn't */}
      <section data-testid="about-not" style={SECTION_BORDERED}>
        <p style={EYEBROW_STYLE}>What Floom isn't</p>
        <h2 style={H2_STYLE}>Three things people ask, three things we're not.</h2>

        <div style={{ display: 'grid', gap: 14, margin: '24px 0 0' }}>
          <NotRow
            lead="Not a chat UI."
            body="We don't wrap your app in a chat interface. Your app gets the UI its inputs and outputs deserve."
          />
          <NotRow
            lead="Not a low-code app builder."
            body="You bring the code. We give it a URL, auth, logs, and error handling. No drag-and-drop."
          />
          <NotRow
            lead="Not an agent orchestrator."
            body="We run apps. You orchestrate them wherever you want: Claude, Cursor, your own tool, whatever comes next."
          />
        </div>
      </section>

      {/* 5. Who's behind it */}
      <section data-testid="about-who-behind" style={SECTION_BORDERED}>
        <p style={EYEBROW_STYLE}>Who's behind it</p>
        <h2 style={H2_STYLE}>One founder, open source by default.</h2>
        <p style={BODY_STYLE}>
          Floom is built by{' '}
          <a
            href="https://linkedin.com/in/federicodeponte"
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--accent)' }}
          >
            Federico De Ponte
          </a>
          . Before Floom, he ran SCAILE for three years. He's building
          this one solo, moving to San Francisco, and shipping in public.
        </p>
        <p style={BODY_STYLE}>
          Floom, Inc. is a Delaware C-Corp. The runtime and the protocol
          spec are open source and self-hostable. No VC funding yet. If
          you want the hosted version, it's{' '}
          <Link to="/" style={{ color: 'var(--accent)' }}>floom.dev</Link>.
          If you want to run it on your own box, clone the repo.
        </p>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, margin: '20px 0 0' }}>
          <PillLink href="https://github.com/floomhq/floom">GitHub repo</PillLink>
          <PillLink href="https://discord.gg/8fXGXjxcRz">Discord community</PillLink>
          <PillLink to="/protocol">The Floom protocol</PillLink>
        </div>
      </section>

      {/* Who's behind — photo + contact band (2026-04-24). The /about
          page mentioned Federico textually but had no face; WhosBehind
          is already rendered on the landing page, reuse it here.
          Wrapped in a top-bordered section so the vertical rhythm
          matches the other /about sections. */}
      <section
        data-testid="about-whos-behind-wrap"
        style={{ ...SECTION_BORDERED, padding: '24px 0 24px' }}
      >
        <WhosBehind />
      </section>

      {/* CTA footer band */}
      <section
        data-testid="about-cta"
        style={{
          ...SECTION_BORDERED,
          textAlign: 'center',
          padding: '64px 0 24px',
        }}
      >
        {/* Copy 2026-04-24 (audit): "Paste your thing" reads too informal
            for the trust section. "Paste your app" names what you're
            actually pasting and keeps the short imperative rhythm. */}
        <h2 style={{ ...H2_STYLE, margin: '0 0 12px' }}>
          {deployEnabled ? 'Paste your app. Share the link.' : 'Paste your app. Run it everywhere.'}
        </h2>
        <p
          style={{
            ...MUTED_BODY_STYLE,
            maxWidth: 560,
            margin: '0 auto 24px',
          }}
        >
          {deployEnabled ? (
            <>
              Point Floom at an OpenAPI spec or a GitHub repo. You get a live
              URL, auth, logs, and a page your colleagues can actually open.
            </>
          ) : (
            <>
              Point Floom at an OpenAPI spec or a GitHub repo to publish when
              your account has access on floom.dev, or run without limits on
              your own hardware. Until publish opens for you here, run catalog
              apps, use MCP, and self-host your own.
            </>
          )}
        </p>
        {deployEnabled ? (
          <Link
            to="/studio/build"
            data-testid="about-cta-build"
            style={{
              display: 'inline-block',
              padding: '14px 26px',
              background: 'var(--accent)',
              color: '#ffffff',
              fontWeight: 600,
              fontSize: 15,
              borderRadius: 10,
              textDecoration: 'none',
              letterSpacing: '-0.005em',
            }}
          >
            Paste your app → Studio
          </Link>
        ) : (
          <button
            type="button"
            data-testid="about-cta-waitlist"
            onClick={() => {
              // TODO(Agent 9): open WaitlistModal instead of routing.
              navigate(waitlistHref('about-footer'));
            }}
            style={{
              display: 'inline-block',
              padding: '14px 26px',
              background: 'var(--accent)',
              color: '#ffffff',
              fontWeight: 600,
              fontSize: 15,
              borderRadius: 10,
              textDecoration: 'none',
              letterSpacing: '-0.005em',
              border: 'none',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Join the publish waitlist
          </button>
        )}
      </section>
    </PageShell>
  );
}

// ── Building blocks ───────────────────────────────────────────────────────

function WhoCard({
  tag,
  title,
  body,
}: {
  tag: string;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 14,
        padding: '24px 22px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <span
        style={{
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 11,
          fontWeight: 700,
          color: 'var(--accent)',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        }}
      >
        {tag}
      </span>
      <p
        style={{
          fontSize: 18,
          fontWeight: 600,
          lineHeight: 1.35,
          color: 'var(--ink)',
          margin: 0,
          letterSpacing: '-0.01em',
        }}
      >
        {title}
      </p>
      <p
        style={{
          fontSize: 15,
          lineHeight: 1.6,
          color: 'var(--muted)',
          margin: 0,
        }}
      >
        {body}
      </p>
    </div>
  );
}

function Triad({ label, body }: { label: string; body: string }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '160px 1fr',
        gap: 20,
        alignItems: 'baseline',
        padding: '14px 0',
        borderTop: '1px dashed var(--line)',
      }}
      className="about-triad"
    >
      <span
        style={{
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 12,
          fontWeight: 700,
          color: 'var(--accent)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        {label}
      </span>
      <p style={{ fontSize: 15, lineHeight: 1.65, color: 'var(--ink)', margin: 0 }}>
        {body}
      </p>
    </div>
  );
}

function NotRow({ lead, body }: { lead: string; body: string }) {
  return (
    <div
      style={{
        padding: '16px 18px',
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 12,
      }}
    >
      <p
        style={{
          fontSize: 16,
          fontWeight: 600,
          color: 'var(--ink)',
          margin: '0 0 4px',
          letterSpacing: '-0.005em',
        }}
      >
        {lead}
      </p>
      <p style={{ fontSize: 15, lineHeight: 1.6, color: 'var(--muted)', margin: 0 }}>
        {body}
      </p>
    </div>
  );
}

function PillLink({
  href,
  to,
  children,
}: {
  href?: string;
  to?: string;
  children: React.ReactNode;
}) {
  const style: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '8px 14px',
    border: '1px solid var(--line)',
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--ink)',
    textDecoration: 'none',
    background: 'var(--card)',
  };
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" style={style}>
        {children}
      </a>
    );
  }
  return (
    <Link to={to!} style={style}>
      {children}
    </Link>
  );
}
