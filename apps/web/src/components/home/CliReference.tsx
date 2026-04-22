/**
 * CliReference — v17 landing · "Works in any coding agent" strip.
 *
 * A small terminal-styled code block showing the Floom slash command
 * (`/floom-deploy`) + the shell equivalent (`floom deploy`). Per Federico
 * 2026-04-22: "having /floom referenced somewhere would be sick." The
 * slash command is real and lives at /root/floom/skills/claude-code/SKILL.md;
 * `floom deploy` is the CLI equivalent (skills/floom/cli).
 *
 * Light theme terminal per the 2026-04-21 "no black terminals on landing"
 * correction (memory · feedback_light_terminals).
 */
import type { CSSProperties } from 'react';

const SHELL_STYLE: CSSProperties = {
  maxWidth: 720,
  margin: '36px auto 0',
  padding: '0 12px',
};

const EYEBROW_STYLE: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 11,
  color: 'var(--muted)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  fontWeight: 600,
  textAlign: 'center',
  marginBottom: 12,
};

const BLOCK_STYLE: CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--line)',
  borderRadius: 12,
  padding: '16px 18px',
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 13,
  lineHeight: 1.7,
  textAlign: 'left',
  color: 'var(--ink)',
};

const DIM: CSSProperties = { color: 'var(--muted)' };
const ACCENT: CSSProperties = { color: 'var(--accent)', fontWeight: 600 };

export function CliReference() {
  return (
    <div data-testid="cli-reference" style={SHELL_STYLE}>
      <div style={EYEBROW_STYLE}>Works in any coding agent</div>
      <div style={BLOCK_STYLE}>
        <div>
          <span style={DIM}>{'>'}</span>{' '}
          <span style={{ fontWeight: 600 }}>/floom-deploy</span>
          <span style={DIM}> &nbsp;# inside Claude Code</span>
        </div>
        <div>
          <span style={DIM}>$</span>{' '}
          <span style={{ fontWeight: 600 }}>floom deploy</span>
          <span style={DIM}> &nbsp;# from any terminal</span>
        </div>
        <div style={{ marginTop: 6, ...DIM }}>
          <span style={ACCENT}>&#10003;</span> App live at floom.dev/a/&lt;slug&gt; &middot;
          MCP tool + JSON API included
        </div>
      </div>
    </div>
  );
}
