/**
 * ClaudeSkillModal — "Install as Claude Skill" dialog for /p/:slug.
 *
 * Front-door for the backend route shipped in PR #761
 * (apps/server/src/routes/skill.ts). The route serves a Claude Skill
 * markdown file at GET /p/:slug/skill.md; this modal teaches a user how
 * to wire that file into Claude Code so the app becomes callable as a
 * skill from inside their session.
 *
 * Modal scaffolding mirrors BYOKModal — same backdrop, --card surface,
 * single accent button, Escape-to-close. No new modal primitive.
 *
 * Slug substitution is direct (`app.slug`) — public app slugs are
 * sanitised at ingest (lowercase, hyphenated, alphanumeric) so no
 * encoding hacks are needed in the curl block.
 */
import { useEffect } from 'react';
import { Sparkles, Terminal, X } from 'lucide-react';
import { CopyButton } from '../output/CopyButton';

export interface ClaudeSkillModalProps {
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

export function ClaudeSkillModal({
  open,
  onClose,
  slug,
  appName,
  firstInputName,
  origin,
}: ClaudeSkillModalProps) {
  // Close on Escape. Mirrors ShareModal's keyboard handling at a smaller
  // surface — no focus trap needed: the modal has at most three
  // interactive elements (close, two copy buttons) and tab-cycling
  // through them naturally stays inside the dialog.
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

  const installCommand = [
    `mkdir -p ~/.claude/skills/${slug}`,
    `curl -fsSL ${baseOrigin}/p/${slug}/skill.md \\`,
    `  -o ~/.claude/skills/${slug}/SKILL.md`,
  ].join('\n');

  const examplePrompt = firstInputName
    ? `Run ${slug} with ${firstInputName}=…`
    : `Run ${slug}`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="claude-skill-modal-title"
      data-testid="claude-skill-modal"
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
        className="claude-skill-modal-surface"
        style={{
          background: 'var(--card)',
          color: 'var(--ink)',
          border: '1px solid var(--line)',
          borderRadius: 14,
          width: '100%',
          maxWidth: 520,
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
            id="claude-skill-modal-title"
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
            Install {appName} as a Claude Skill
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
            data-testid="claude-skill-modal-blurb"
            style={{
              fontSize: 13.5,
              color: 'var(--muted)',
              lineHeight: 1.55,
              margin: 0,
            }}
          >
            Run this app from inside Claude Code with one prompt. Claude
            reads the skill file and knows how to call your endpoint.
          </p>
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
            Step 1 — save the skill file
          </div>
          <div
            data-testid="claude-skill-modal-install-block"
            style={{
              border: '1px solid var(--line)',
              borderRadius: 10,
              background: 'var(--bg)',
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
            Step 2 — use it in Claude Code
          </div>
          <div
            data-testid="claude-skill-modal-example"
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              border: '1px solid var(--line)',
              borderRadius: 10,
              padding: '10px 12px',
              background: 'var(--bg)',
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
                Open Claude Code and ask:
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
          [data-testid="claude-skill-modal"] {
            align-items: flex-end !important;
            padding: 0 !important;
          }
          [data-testid="claude-skill-modal"] .claude-skill-modal-surface {
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

export default ClaudeSkillModal;

// Marker icon export so the trigger button on /p/:slug uses the same
// Sparkles glyph as the modal header. Keeps a single visual identity
// for the "Claude Skill" affordance without forcing the page to import
// lucide directly for one icon.
export function ClaudeSkillIcon({ size = 14 }: { size?: number }) {
  return <Sparkles size={size} aria-hidden="true" />;
}
