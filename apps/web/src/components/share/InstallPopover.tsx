/**
 * InstallPopover — unified "Install" affordance for /p/:slug.
 *
 * R7.6 (2026-04-28). Federico's brief: replace the two-button install
 * cluster ("+ Install in workspace" disabled stub + "Install as Skill"
 * modal trigger) with ONE primary Install button that opens a popover
 * with three tabs:
 *
 *   - MCP    — pre-filled MCP config snippet for /mcp/app/:slug
 *   - CLI    — `npx @floomhq/cli@latest run <slug>` (or `floom run <slug>`)
 *   - Skill  — paste paths for Claude Code / Cursor / Codex + download
 *
 * The popover is anchored to the trigger button. Click-outside and Escape
 * dismiss. Tabs are role=tablist for a11y. Snippets sit on `--studio`
 * tinted bg per the global "no black copy boxes" rule.
 *
 * Token state: when the user is signed in and has a token minted, we
 * inline a masked placeholder (`floom_agent_••••••••`) plus a "Mint a
 * token →" link if no token exists. We deliberately don't fetch the
 * raw token here — that lives behind `/home`'s mint flow so it's only
 * shown once at create time. Users with a token get the snippet ready
 * to paste; users without get the snippet template + a clear path to
 * mint.
 */
import { useEffect, useRef, useState } from 'react';
import type { ElementType } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles, Terminal, Server, Download } from 'lucide-react';
import { CopyButton } from '../output/CopyButton';

// lucide-react icons forward refs and use `Booleanish` for aria-hidden,
// which doesn't match a tightly-typed ComponentType. Use ElementType so
// the JSX rendering path infers the right shape without us mirroring
// lucide's full prop surface.
type IconCmp = ElementType;

type TabId = 'mcp' | 'cli' | 'skill';
type AgentId = 'claude-code' | 'cursor' | 'codex';

interface InstallPopoverProps {
  open: boolean;
  onClose: () => void;
  /** App slug — used for /mcp/app/<slug> + skill.md URL + cli command. */
  slug: string;
  /** App display name — used in skill modal headline. */
  appName: string;
  /** Whether the visitor is signed in. */
  isAuthenticated: boolean;
  /** Whether the visitor's workspace has at least one active token. */
  hasToken?: boolean;
  /**
   * Optional first declared input on the primary action — used to seed
   * the example prompt in the Skill tab so users see a concrete
   * invocation, not a placeholder.
   */
  firstInputName?: string | null;
  /**
   * Optional public origin override. Defaults to window.location.origin
   * so previews on preview.floom.dev / mvp.floom.dev fetch from the
   * host they were rendered on.
   */
  origin?: string;
}

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

export function InstallPopover({
  open,
  onClose,
  slug,
  appName,
  isAuthenticated,
  hasToken = false,
  firstInputName,
  origin,
}: InstallPopoverProps) {
  const [activeTab, setActiveTab] = useState<TabId>('mcp');
  const [activeAgent, setActiveAgent] = useState<AgentId>('claude-code');
  const surfaceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    function onClick(e: MouseEvent) {
      if (surfaceRef.current && !surfaceRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open, onClose]);

  if (!open) return null;

  const baseOrigin =
    origin ||
    (typeof window !== 'undefined' ? window.location.origin : 'https://floom.dev');
  const tokenPlaceholder = hasToken
    ? 'floom_agent_<your_token>'
    : 'floom_agent_<your_token>';

  // MCP snippet — points at the per-app route (/mcp/app/<slug>) so the
  // agent only sees this app, not the whole catalogue.
  const mcpSnippet = `{
  "mcpServers": {
    "${slug}": {
      "url": "${baseOrigin}/mcp/app/${slug}",
      "headers": {
        "Authorization": "Bearer ${tokenPlaceholder}"
      }
    }
  }
}`;

  // CLI snippet — npx form is the primary affordance (no install step).
  const cliSnippet = `npx @floomhq/cli@latest run ${slug}`;

  // Skill: per-agent install command. Mirrors SkillModal's structure
  // but inlined here so the popover is one self-contained surface.
  const skillUrl = `${baseOrigin}/p/${slug}/skill.md`;
  const agent = AGENTS.find((a) => a.id === activeAgent) ?? AGENTS[0];
  const pastePath = agent.pastePath(slug);
  const skillCommand = [
    `mkdir -p ${pastePath.replace(/\/SKILL\.md$/, '')}`,
    `curl -fsSL ${skillUrl} \\`,
    `  -o ${pastePath}`,
  ].join('\n');
  const examplePrompt = firstInputName
    ? `Run ${slug} with ${firstInputName}=…`
    : `Run ${slug}`;

  const tabBtn = (id: TabId, label: string, Icon: IconCmp) => {
    const active = id === activeTab;
    return (
      <button
        key={id}
        type="button"
        role="tab"
        aria-selected={active}
        data-testid={`install-popover-tab-${id}`}
        onClick={() => setActiveTab(id)}
        style={{
          padding: '9px 14px',
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
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <Icon size={13} aria-hidden />
        {label}
      </button>
    );
  };

  return (
    <div
      ref={surfaceRef}
      role="dialog"
      aria-modal="false"
      aria-label={`Install ${appName}`}
      data-testid="install-popover"
      style={{
        position: 'absolute',
        top: 'calc(100% + 8px)',
        right: 0,
        width: 'min(520px, calc(100vw - 32px))',
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        boxShadow: '0 16px 40px rgba(27,26,23,0.18)',
        zIndex: 60,
        overflow: 'hidden',
      }}
    >
      {/* Tab bar */}
      <div
        role="tablist"
        aria-label="Install path"
        style={{
          display: 'flex',
          gap: 2,
          padding: '0 14px',
          borderBottom: '1px solid var(--line)',
          background: 'var(--bg, #fafaf8)',
        }}
      >
        {tabBtn('mcp', 'MCP config', Server)}
        {tabBtn('cli', 'CLI', Terminal)}
        {tabBtn('skill', 'Skill', Sparkles)}
      </div>

      {/* Tab body */}
      <div style={{ padding: 14 }}>
        {/* Token affordance — visible on every tab so the user always
            knows whether their snippet is ready to paste. */}
        {!isAuthenticated ? (
          <p
            data-testid="install-popover-signin"
            style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 }}
          >
            <Link
              to={`/login?next=${encodeURIComponent(`/p/${slug}`)}`}
              style={{ color: 'var(--accent)', fontWeight: 600, textDecoration: 'none' }}
            >
              Sign in to mint a token →
            </Link>{' '}
            or paste with a placeholder and fill it in later.
          </p>
        ) : !hasToken ? (
          <p
            data-testid="install-popover-mint"
            style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 }}
          >
            <Link
              to="/home"
              style={{ color: 'var(--accent)', fontWeight: 600, textDecoration: 'none' }}
            >
              Mint a token →
            </Link>{' '}
            then replace <code style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}>{'<your_token>'}</code> below.
          </p>
        ) : null}

        {activeTab === 'mcp' && (
          <Snippet
            label="MCP config"
            description="Works with any MCP client (Claude Desktop, Cursor, Codex, …)."
            value={mcpSnippet}
            testId="install-popover-mcp-snippet"
          />
        )}
        {activeTab === 'cli' && (
          <Snippet
            label="CLI"
            description="Run from any shell — Node 18+ required."
            value={cliSnippet}
            testId="install-popover-cli-snippet"
          />
        )}
        {activeTab === 'skill' && (
          <div data-testid="install-popover-skill-pane">
            {/* Per-agent sub-tabs */}
            <div
              role="tablist"
              aria-label="Agent"
              style={{
                display: 'flex',
                gap: 2,
                marginBottom: 10,
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
                    data-testid={`install-popover-agent-${a.id}`}
                    onClick={() => setActiveAgent(a.id)}
                    style={{
                      padding: '6px 12px',
                      fontSize: 11.5,
                      fontWeight: active ? 700 : 500,
                      border: 'none',
                      background: 'transparent',
                      color: active ? 'var(--ink)' : 'var(--muted)',
                      borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
                      marginBottom: -1,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    {a.label}
                  </button>
                );
              })}
            </div>
            <Snippet
              label={`Save to ${agent.label}`}
              description={
                <>
                  Saves to{' '}
                  <code style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}>{pastePath}</code>
                </>
              }
              value={skillCommand}
              testId="install-popover-skill-snippet"
            />
            {/* Direct download fallback. */}
            <div
              style={{
                marginTop: 10,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
              }}
            >
              <a
                href={skillUrl}
                data-testid="install-popover-skill-download"
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
                <Download size={13} aria-hidden /> Download skill.md
              </a>
              <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                Then ask {agent.label}: <em>"{examplePrompt}"</em>
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Snippet({
  label,
  description,
  value,
  testId,
}: {
  label: string;
  description: React.ReactNode;
  value: string;
  testId: string;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 11.5,
          fontWeight: 600,
          color: 'var(--muted)',
          letterSpacing: 0.4,
          textTransform: 'uppercase',
          margin: '0 0 4px',
        }}
      >
        {label}
      </div>
      <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 }}>
        {description}
      </p>
      <div
        data-testid={testId}
        style={{
          position: 'relative',
          border: '1px solid var(--line)',
          borderRadius: 10,
          background: 'var(--studio, #f5f4f0)',
          padding: '10px 12px',
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
          {value}
        </pre>
        <div style={{ position: 'absolute', top: 8, right: 8 }}>
          <CopyButton value={value} label="Copy" className="output-copy-btn" />
        </div>
      </div>
    </div>
  );
}

export default InstallPopover;
