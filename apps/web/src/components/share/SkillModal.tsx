/**
 * SkillModal — agent-agnostic "Install as Skill" dialog for /p/:slug.
 *
 * R7.6 (2026-04-28) — renamed from ClaudeSkillModal. Federico's brief:
 * the install affordance is agent-agnostic (Claude Code, Cursor, Codex,
 * any agent that supports markdown skills). Modal copy + paste paths
 * reflect that — no longer Claude-specific.
 *
 * Front-door for the backend route shipped in PR #761
 * (apps/server/src/routes/skill.ts). The route serves a markdown skill
 * file at GET /p/:slug/skill.md; this modal teaches a user how to wire
 * that file into their agent of choice so the app becomes callable as
 * a skill from inside their session.
 *
 * Modal scaffolding mirrors BYOKModal — same backdrop, --card surface,
 * single accent button, Escape-to-close. No new modal primitive.
 *
 * Slug substitution is direct (`app.slug`) — public app slugs are
 * sanitised at ingest (lowercase, hyphenated, alphanumeric) so no
 * encoding hacks are needed in the curl block.
 */
import { useEffect, useState } from 'react';
import { Sparkles, Terminal, X, Download } from 'lucide-react';
import { CopyButton } from '../output/CopyButton';

export interface SkillModalProps {
  open: boolean;
  onClose: () => void;
  /** App slug — used to build the skill.md URL and the install path. */
  slug: string;
  /** Display name in the headline. */
  appName: string;
  /**
   * First declared input on the primary action. Used for the example
   * prompt line so a user sees a concrete invocation, not a placeholder.
   * Pass null when the manifest declares no inputs.
   */
  firstInputName?: string | null;
  /**
   * Optional — the public origin to pull skill.md from. Defaults to
   * window.location.origin at render time so previews fetch from
   * preview.floom.dev and prod fetches from floom.dev without any extra
   * wiring. Override for SSR / tests.
   */
  origin?: string;
}

type AgentId = 'claude-code' | 'cursor' | 'codex';

const AGENTS: Array<{
  id: AgentId;
  label: string;
  pastePath: (slug: string) => string;
}> = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    pastePath: (slug) => `~/.claude/skills/${slug}/SKILL.md`,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    pastePath: (slug) => `~/.cursor/skills/${slug}/SKILL.md`,
  },
  {
    id: 'codex',
    label: 'Codex',
    pastePath: (slug) => `~/.codex/skills/${slug}/SKILL.md`,
  },
];

export function SkillModal({
  open,
  onClose,
  slug,
  appName,
  firstInputName,
  origin,
}: SkillModalProps) {
  const [activeAgent, setActiveAgent] = useState<AgentId>('claude-code');

  // Close on Escape. Mirrors ShareModal's keyboard handling at a smaller
  // surface — no focus trap needed: the modal has at most a handful of
  // interactive elements (close, tab buttons, copy buttons, download)
  // and tab-cycling through them naturally stays inside the dialog.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const baseOrigin =
    origin ||
    (typeof window !== 'undefined' ? window.location.origin : 'https://floom.dev');

  const skillUrl = `${baseOrigin}/p/${slug}/skill.md`;

  const agent = AGENTS.find((a) => a.id === activeAgent) ?? AGENTS[0];
  const pastePath = agent.pastePath(slug);
  // Strip the trailing /SKILL.md so `mkdir -p` lines up under the
  // path the user actually sees in the paste-path label.
  const installCommand = [
    `mkdir -p ${pastePath.replace(/\/SKILL\.md$/, '')}`,
    `curl -fsSL ${skillUrl} \\`,
    `  -o ${pastePath}`,
  ].join('\n');

  const examplePrompt = firstInputName
    ? `Run ${slug} with ${firstInputName}=…`
    : `Run ${slug}`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="skill-modal-title"
      data-testid="skill-modal"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1100,
        background: 'rgba(27, 26, 23, 0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="skill-modal-surface"
        style={{
          background: 'var(--card)',
          color: 'var(--ink)',
          border: '1px solid var(--line)',
          borderRadius: 14,
          width: '100%',
          maxWidth: 540,
          maxHeight: 'calc(100vh - 32px)',
          overflow: 'auto',
          boxShadow: '0 20px 60px rgba(27,26,23,0.25)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '18px 20px 14px',
            borderBottom: '1px solid var(--line)',
          }}
        >
          <h2
            id="skill-modal-title"
            style={{
              fontSize: 15.5,
              fontWeight: 600,
              margin: 0,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            Install {appName} as a Skill
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              padding: 6,
              borderRadius: 8,
              color: 'var(--ink)',
              display: 'inline-flex',
              flexShrink: 0,
            }}
          >
            <X size={18} />
          </button>
        </header>

        {/* What this is */}
        <section style={{ padding: '14px 20px 6px' }}>
          <p
            data-testid="skill-modal-blurb"
            style={{
              fontSize: 13.5,
              color: 'var(--muted)',
              lineHeight: 1.55,
              margin: 0,
            }}
          >
            Save this skill file to your agent. Works in Claude Code, Cursor,
            Codex, and any agent that supports markdown skills.
          </p>
        </section>

        {/* Agent tab bar */}
        <section style={{ padding: '12px 20px 0' }}>
          <div
            role="tablist"
            aria-label="Agent"
            data-testid="skill-modal-agent-tabs"
            style={{
              display: 'flex',
              gap: 2,
              borderBottom: '1px solid var(--line)',
            }}
          >
            {AGENTS.map((a) => {
              const active = a.id === activeAgent;
              return (
                <button
                  key={a.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-testid={`skill-modal-tab-${a.id}`}
                  onClick={() => setActiveAgent(a.id)}
                  style={{
                    padding: '8px 14px',
                    fontSize: 12.5,
                    fontWeight: active ? 700 : 500,
                    border: 'none',
                    background: 'transparent',
                    color: active ? 'var(--ink)' : 'var(--muted)',
                    borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
                    marginBottom: -1,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {a.label}
                </button>
              );
            })}
          </div>
        </section>

        {/* Step 1 — save the skill file */}
        <section style={{ padding: '14px 20px 8px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 11.5,
              fontWeight: 600,
              color: 'var(--muted)',
              letterSpacing: 0.4,
              textTransform: 'uppercase',
              margin: '0 0 8px',
            }}
          >
            Step 1 — save to {agent.label}
          </div>
          <div
            data-testid="skill-modal-install-block"
            style={{
              border: '1px solid var(--line)',
              borderRadius: 10,
              background: 'var(--studio, #f5f4f0)',
              padding: '10px 12px',
              position: 'relative',
            }}
          >
            <pre
              style={{
                margin: 0,
                fontFamily:
                  'JetBrains Mono, ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace',
                fontSize: 12,
                lineHeight: 1.55,
                color: 'var(--ink)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                paddingRight: 64,
              }}
            >
              {installCommand}
            </pre>
            <div
              style={{
                position: 'absolute',
                top: 8,
                right: 8,
              }}
            >
              <CopyButton
                value={installCommand}
                label="Copy"
                className="output-copy-btn"
              />
            </div>
          </div>
          {/* Direct download fallback for users who prefer not to curl. */}
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <a
              href={skillUrl}
              data-testid="skill-modal-download"
              download={`${slug}.skill.md`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12.5,
                fontWeight: 600,
                color: 'var(--accent)',
                textDecoration: 'none',
                fontFamily: 'inherit',
              }}
            >
              <Download size={13} aria-hidden="true" /> Download skill.md
            </a>
            <span
              style={{
                fontSize: 11.5,
                color: 'var(--muted)',
              }}
            >
              Save to <code style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 11.5 }}>{pastePath}</code>
            </span>
          </div>
        </section>

        {/* Step 2 — use it */}
        <section style={{ padding: '8px 20px 18px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 11.5,
              fontWeight: 600,
              color: 'var(--muted)',
              letterSpacing: 0.4,
              textTransform: 'uppercase',
              margin: '6px 0 8px',
            }}
          >
            Step 2 — use it in {agent.label}
          </div>
          <div
            data-testid="skill-modal-example"
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              border: '1px solid var(--line)',
              borderRadius: 10,
              padding: '10px 12px',
              background: 'var(--studio, #f5f4f0)',
            }}
          >
            <Terminal
              size={14}
              aria-hidden="true"
              style={{ color: 'var(--muted)', flexShrink: 0, marginTop: 3 }}
            />
            <div style={{ minWidth: 0, flex: 1 }}>
              <p
                style={{
                  margin: 0,
                  fontSize: 13,
                  color: 'var(--ink)',
                  lineHeight: 1.5,
                }}
              >
                Open {agent.label} and ask:
              </p>
              <p
                style={{
                  margin: '4px 0 0',
                  fontFamily:
                    'JetBrains Mono, ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace',
                  fontSize: 12.5,
                  color: 'var(--accent)',
                  lineHeight: 1.5,
                  wordBreak: 'break-word',
                }}
              >
                {`"${examplePrompt}"`}
              </p>
            </div>
          </div>
        </section>
      </div>

      {/* Mobile bottom-sheet polish — same pattern as ShareModal. */}
      <style>{`
        @media (max-width: 640px) {
          [data-testid="skill-modal"] {
            align-items: flex-end !important;
            padding: 0 !important;
          }
          [data-testid="skill-modal"] .skill-modal-surface {
            max-width: 100% !important;
            width: 100% !important;
            max-height: 92vh !important;
            border-radius: 18px 18px 0 0 !important;
          }
        }
      `}</style>
    </div>
  );
}

export default SkillModal;

// Marker icon export so the trigger button on /p/:slug uses the same
// Sparkles glyph as the modal header. Keeps a single visual identity
// for the "Skill" affordance without forcing the page to import
// lucide directly for one icon.
export function SkillIcon({ size = 14 }: { size?: number }) {
  return <Sparkles size={size} aria-hidden="true" />;
}

// R7.6 (2026-04-28): backwards-compat aliases. Earlier callers imported
// `ClaudeSkillModal` / `ClaudeSkillIcon` from this file under the old
// name — keep the symbols exported so a stale import on another branch
// does not break the build. Remove once all callers are migrated.
export const ClaudeSkillModal = SkillModal;
export const ClaudeSkillIcon = SkillIcon;
