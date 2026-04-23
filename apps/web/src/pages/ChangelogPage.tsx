// /changelog — lightweight landing page introduced alongside the v17
// TopBar nav rewrite (PR #405 ripple fix, 2026-04-22). TopBar advertises
// a "Changelog" link in the centre nav; previously it pointed at `#`
// which was a dead-end. This page gives it a real destination without
// standing up a full-blown changelog engine — it points readers at the
// two live sources: GitHub Releases (authoritative) and the Discord
// community (where Federico posts the "what's new" colour commentary).
//
// Deliberately minimal: one H1, one blurb, two pills. Matches the tone
// of /pricing (which is also a "we're small, here's the truth" page).
// When we have a real changelog surface we'll replace this with a
// proper list view; until then, this is the honest answer.
import { PageShell } from '../components/PageShell';

const SECTION_STYLE: React.CSSProperties = {
  maxWidth: 720,
  margin: '0 auto',
  padding: '56px 0',
  textAlign: 'center',
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

const H1_STYLE: React.CSSProperties = {
  fontFamily: "'DM Serif Display', Georgia, serif",
  fontWeight: 400,
  fontSize: 52,
  lineHeight: 1.08,
  letterSpacing: '-0.025em',
  color: 'var(--ink)',
  margin: '0 0 20px',
  textWrap: 'balance' as unknown as 'balance',
};

const SUB_STYLE: React.CSSProperties = {
  fontSize: 18,
  lineHeight: 1.6,
  color: 'var(--muted)',
  margin: '0 auto',
  maxWidth: 560,
};

const PILL_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 10,
  justifyContent: 'center',
  margin: '28px 0 0',
};

const PILL_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '10px 18px',
  borderRadius: 999,
  fontSize: 14,
  fontWeight: 600,
  textDecoration: 'none',
  background: 'var(--ink)',
  color: '#fff',
  border: '1px solid var(--ink)',
};

const PILL_SECONDARY_STYLE: React.CSSProperties = {
  ...PILL_STYLE,
  background: 'transparent',
  color: 'var(--ink)',
  border: '1px solid var(--line)',
};

export function ChangelogPage() {
  return (
    <PageShell
      title="Changelog · Floom"
      description="Ship notes from the Floom team. Platform features, protocol changes, and apps that recently went live."
    >
      <section style={SECTION_STYLE}>
        <p style={EYEBROW_STYLE}>CHANGELOG</p>
        <h1 style={H1_STYLE}>What's new in Floom</h1>
        <p style={SUB_STYLE}>
          Floom ships frequently. Every tagged release and protocol change is
          published on GitHub Releases. Short "what just landed" posts go out in
          the Discord community first.
        </p>
        <div style={PILL_ROW_STYLE}>
          <a
            href="https://github.com/floomhq/floom/releases"
            target="_blank"
            rel="noreferrer noopener"
            style={PILL_STYLE}
          >
            GitHub releases
          </a>
          <a
            href="https://discord.gg/8fXGXjxcRz"
            target="_blank"
            rel="noreferrer noopener"
            style={PILL_SECONDARY_STYLE}
          >
            Join Discord
          </a>
        </div>

        <section
          style={{
            ...SECTION_STYLE,
            paddingTop: 8,
            textAlign: 'left',
            maxWidth: 640,
            marginLeft: 'auto',
            marginRight: 'auto',
          }}
          data-testid="changelog-launch-2026-04-24"
        >
          <p
            style={{
              ...EYEBROW_STYLE,
              textAlign: 'left',
            }}
          >
            2026-04-24
          </p>
          <h2
            style={{
              ...H1_STYLE,
              fontSize: 28,
              textAlign: 'left',
            }}
          >
            Launch week
          </h2>
          <p
            style={{
              ...SUB_STYLE,
              textAlign: 'left',
              maxWidth: 'none',
            }}
          >
            Public floom.dev with catalog apps, MCP installs, and sign-in. Publishing
            to the hosted cloud opens from the waitlist first. Full release notes ship
            on GitHub Releases on launch day.
          </p>
          <p
            style={{
              ...SUB_STYLE,
              textAlign: 'left',
              maxWidth: 'none',
              fontSize: 15,
              fontStyle: 'italic',
              marginTop: 16,
            }}
          >
            Detailed bullets: coming soon — GitHub Releases stays authoritative.
          </p>
        </section>
      </section>
    </PageShell>
  );
}
