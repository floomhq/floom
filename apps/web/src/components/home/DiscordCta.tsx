/**
 * DiscordCta — small "join the Discord" band near the footer.
 *
 * Federico 2026-04-23 (#613): Floom's Discord exists (invite
 * https://discord.gg/8fXGXjxcRz, MEMORY project_floom_discord) but the
 * landing page has no path to it. This adds a small chip-style band
 * right above the footer: one line of copy, one outbound button.
 *
 * Not a full card, not a second hero — deliberately understated so it
 * doesn't compete with the GitHub / Docs CTAs above it. Discord logo
 * is inline SVG (lucide-react 1.8 doesn't carry it); brand color
 * stays in the icon only, the button itself follows the site's
 * restrained palette.
 */
import type { CSSProperties } from 'react';

const DISCORD_INVITE = 'https://discord.gg/8fXGXjxcRz';

const SECTION_STYLE: CSSProperties = {
  padding: '36px 28px 48px',
  textAlign: 'center',
};

const INNER_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 14,
  padding: '14px 18px',
  borderRadius: 14,
  background: 'var(--card)',
  border: '1px solid var(--line)',
  maxWidth: '100%',
  flexWrap: 'wrap',
  justifyContent: 'center',
};

const COPY_STYLE: CSSProperties = {
  fontSize: 14,
  color: 'var(--ink)',
  lineHeight: 1.4,
  fontWeight: 500,
};

const MUTED_STYLE: CSSProperties = {
  color: 'var(--muted)',
  fontWeight: 400,
};

const BUTTON_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '9px 14px',
  borderRadius: 999,
  background: 'var(--ink)',
  color: '#fff',
  border: '1px solid var(--ink)',
  fontSize: 13,
  fontWeight: 600,
  textDecoration: 'none',
  fontFamily: "'Inter', system-ui, sans-serif",
};

export function DiscordCta() {
  return (
    <section data-testid="discord-cta" style={SECTION_STYLE}>
      <div style={INNER_STYLE}>
        <DiscordMark />
        <span style={COPY_STYLE}>
          Questions, feedback, or building something on Floom?{' '}
          <span style={MUTED_STYLE}>
            Say hi in the Discord.
          </span>
        </span>
        <a
          href={DISCORD_INVITE}
          target="_blank"
          rel="noreferrer"
          data-testid="discord-cta-link"
          style={BUTTON_STYLE}
        >
          Join the Discord
        </a>
      </div>
    </section>
  );
}

function DiscordMark() {
  // Simplified Discord mark, single color. Kept small (22px) so it
  // reads as an inline logo, not an illustration.
  return (
    <svg
      viewBox="0 0 24 24"
      width={22}
      height={22}
      aria-hidden="true"
      focusable="false"
      fill="#5865F2"
      style={{ flexShrink: 0 }}
    >
      <path d="M20.317 4.369A19.79 19.79 0 0016.558 3.2a.074.074 0 00-.079.037c-.34.607-.719 1.4-.984 2.025a18.27 18.27 0 00-5.487 0 12.67 12.67 0 00-1-2.025.077.077 0 00-.079-.037 19.736 19.736 0 00-3.76 1.169.07.07 0 00-.032.027C2.533 8.045 1.91 11.63 2.216 15.172a.082.082 0 00.031.056 19.9 19.9 0 005.993 3.03.077.077 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.042-.106 13.107 13.107 0 01-1.872-.893.077.077 0 01-.008-.128c.126-.094.252-.192.371-.292a.075.075 0 01.077-.01c3.927 1.793 8.18 1.793 12.061 0a.075.075 0 01.078.009c.12.1.245.199.372.293a.077.077 0 01-.006.128 12.298 12.298 0 01-1.873.892.077.077 0 00-.041.107c.36.699.772 1.364 1.225 1.993a.076.076 0 00.084.029 19.84 19.84 0 006.002-3.03.077.077 0 00.032-.054c.5-4.094-.838-7.647-3.548-10.776a.061.061 0 00-.03-.028zM8.02 13.017c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.955 2.418-2.157 2.418zm7.974 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}
