import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChatStore } from '../store/chatStore';
import { TopBar } from '../components/TopBar';
import { PromptBox } from '../components/PromptBox';
import { TrustStrip } from '../components/TrustStrip';
import { AppIcon } from '../components/AppIcon';
import { AppSuggestionCard } from '../components/chat/AppSuggestionCard';
import { AppInputsCard } from '../components/chat/AppInputsCard';
import { StreamingTerminal } from '../components/chat/StreamingTerminal';
import { OutputPanel } from '../components/chat/OutputPanel';
import { Sidebar } from '../components/Sidebar';
import { PublicAppsResponse } from '../components/chat/responses/PublicAppsResponse';
import { MyAppsResponse } from '../components/chat/responses/MyAppsResponse';
import { BuildYourOwnResponse } from '../components/chat/responses/BuildYourOwnResponse';
import { AboutFloomResponse } from '../components/chat/responses/AboutFloomResponse';
import { ConnectGithubResponse } from '../components/chat/responses/ConnectGithubResponse';
import { getApp, getHub } from '../api/client';
import type { ChatTurn, HubApp, AppDetail, InlineTemplateId, PickResult } from '../lib/types';

export function ChatPage() {
  const {
    turns,
    currentApp,
    sidebarOpen,
    isSubmitting,
    init,
    submitPrompt,
    submitPillPrompt,
    expandToInputs,
    updateInput,
    runTurn,
    openSidebar,
    closeSidebar,
  } = useChatStore();

  const [allApps, setAllApps] = useState<HubApp[]>([]);
  const [trending, setTrending] = useState<HubApp[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    init();
    getHub()
      .then((apps) => {
        setAllApps(apps);
        setTrending(apps.slice(0, 4));
      })
      .catch(() => {
        /* non-fatal */
      });
  }, [init]);

  const isEmpty = turns.length === 0;

  // Listen for floom:pill events dispatched by TopBar nav buttons
  useEffect(() => {
    const handler = (evt: Event) => {
      const pill = (evt as CustomEvent<{ pill: string }>).detail?.pill as
        | 'public-apps'
        | 'my-apps'
        | 'build-your-own'
        | 'about-floom'
        | 'connect-github'
        | undefined;
      if (!pill) return;
      const textMap: Record<string, string> = {
        'public-apps': 'Show me all public apps',
        'my-apps': 'Show me my apps',
        'build-your-own': 'I want to build my own app',
        'about-floom': 'What is Floom?',
        'connect-github': 'Connect my GitHub',
      };
      const text = textMap[pill];
      if (text) submitPillPrompt(text, pill as Parameters<typeof submitPillPrompt>[1]);
    };
    window.addEventListener('floom:pill', handler);
    return () => window.removeEventListener('floom:pill', handler);
  }, [submitPillPrompt]);

  const handleOpenDetails = async (slug: string) => {
    try {
      const detail = await getApp(slug);
      openSidebar(detail);
    } catch {
      // non-fatal
    }
  };

  const handleSignIn = () => {
    submitPillPrompt('Connect my GitHub', 'connect-github');
  };

  const handleBrowsePublic = () => {
    submitPillPrompt('Show me all public apps', 'public-apps');
  };

  return (
    <div className={`page-root sidebar-push-layout ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <TopBar onSignIn={handleSignIn} />

      {isEmpty ? (
        <EmptyHero
          onSubmit={(v) => submitPrompt(v)}
          onPillClick={submitPillPrompt}
          trending={trending}
          onPickApp={(app) => {
            submitPrompt(`Run ${app.name}: ${app.description}`);
          }}
        />
      ) : (
        <main
          className="main"
          id="chat-main"
          style={{ paddingTop: 48, paddingBottom: 160 }}
        >
          <div className="chat-thread">
            {turns.map((turn, idx) => (
              <TurnView
                key={turn.id}
                turn={turn}
                idx={idx}
                allApps={allApps}
                onExpand={async () => {
                  if (turn.kind !== 'assistant' || turn.state.phase !== 'suggested') return;
                  try {
                    const detail = await getApp(turn.state.app.slug);
                    const action = turn.state.parsed.action;
                    const actionSpec = detail.manifest.actions[action];
                    if (actionSpec) {
                      expandToInputs(idx, turn.state.app, actionSpec, action);
                    }
                  } catch {
                    /* non-fatal */
                  }
                }}
                onChange={(name, val) => updateInput(idx, name, val)}
                onRun={() => runTurn(idx)}
                onCancel={() => {
                  // Mark the streaming turn as an error/cancelled via a store reset
                  // The close() function from streamRun is not exposed here, so we stop
                  // by removing the turn from the chat with an error state.
                  const { turns: currentTurns } = useChatStore.getState();
                  const t = currentTurns[idx];
                  if (t && t.kind === 'assistant' && t.state.phase === 'streaming') {
                    const updated = currentTurns.slice();
                    updated[idx] = {
                      ...t,
                      state: { phase: 'error', message: 'Run cancelled.' },
                    };
                    useChatStore.setState({ turns: updated, isSubmitting: false });
                  }
                }}
                onReset={() => {
                  if (turn.kind === 'assistant' && turn.state.phase === 'inputs') {
                    const cleared: Record<string, unknown> = {};
                    turn.state.actionSpec.inputs.forEach((inp) => {
                      cleared[inp.name] = '';
                    });
                    Object.keys(cleared).forEach((k) => updateInput(idx, k, ''));
                  }
                }}
                onIterate={(prompt) => submitPrompt(prompt)}
                onOpenDetails={(slug) => handleOpenDetails(slug)}
                onPickApp={(app) => submitPrompt(`Run ${app.name}: ${app.description}`)}
                onSignIn={handleSignIn}
                onBrowsePublic={handleBrowsePublic}
              />
            ))}
          </div>
        </main>
      )}

      {/* Sticky bottom prompt (only when there's a thread) */}
      {!isEmpty && (
        <div className="bottom-prompt-wrap">
          <div className="bottom-prompt-inner">
            <PromptBox
              size="sm"
              placeholder="Ask a follow-up or start a new request…"
              onSubmit={(v) => submitPrompt(v)}
              disabled={isSubmitting}
            />
          </div>
        </div>
      )}

      <Sidebar app={currentApp} open={sidebarOpen} onClose={closeSidebar} />

      {/* Silence unused */}
      <span hidden>{navigate.length}</span>
    </div>
  );
}

function EmptyHero({
  onSubmit,
  onPillClick,
  trending,
  onPickApp,
}: {
  onSubmit: (v: string) => void;
  onPillClick: (text: string, templateId: InlineTemplateId) => void;
  trending: HubApp[];
  onPickApp: (app: HubApp) => void;
}) {
  return (
    <main
      className="main"
      style={{
        background:
          'radial-gradient(ellipse at top, rgba(255,255,255,1) 0%, var(--bg) 60%)',
      }}
    >
      <h1 className="headline" style={{ maxWidth: 680 }}>
        Infra for<span className="headline-dim"> agentic work.</span>
      </h1>
      <p className="subhead">
        One manifest. Every agent surface. Any CLI, MCP server, or Python library becomes a
        chat, a tool call, and an HTTP endpoint in 10 seconds.
      </p>

      <PromptBox autoFocus onSubmit={onSubmit} />

      <div className="pills" style={{ marginTop: 16 }}>
        <button
          type="button"
          className="pill"
          data-testid="pill-public-apps"
          onClick={() => onPillClick('Show me all public apps', 'public-apps')}
        >
          Public apps
        </button>
        <button
          type="button"
          className="pill"
          data-testid="pill-my-apps"
          onClick={() => onPillClick('Show me my apps', 'my-apps')}
        >
          My apps
        </button>
        <button
          type="button"
          className="pill"
          data-testid="pill-build-your-own"
          onClick={() => onPillClick('I want to build my own app', 'build-your-own')}
        >
          Build your own
        </button>
        <button
          type="button"
          className="pill"
          data-testid="pill-about-floom"
          onClick={() => onPillClick('What is Floom?', 'about-floom')}
        >
          About Floom
        </button>
        <button
          type="button"
          className="pill"
          data-testid="pill-connect-github"
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          onClick={() => onPillClick('Connect my GitHub', 'connect-github')}
        >
          <svg width={13} height={13} viewBox="0 0 24 24" fill="currentColor">
            <use href="#icon-github" />
          </svg>
          Connect GitHub
        </button>
      </div>

      {trending.length > 0 && (
        <section className="trending-section">
          <p className="label-mono">Trending</p>
          <div className="trending-grid">
            {trending.map((app) => (
              <button
                key={app.slug}
                type="button"
                className="app-tile"
                onClick={() => onPickApp(app)}
                style={{ textAlign: 'left' }}
              >
                <div className="app-tile-icon">
                  <AppIcon slug={app.slug} size={24} />
                </div>
                <div className="app-tile-name">{app.name}</div>
                <div className="app-tile-desc">{app.description}</div>
                <div className="app-tile-runs">{app.category || app.runtime}</div>
              </button>
            ))}
          </div>
        </section>
      )}

      <TrustStrip />
    </main>
  );
}

interface TurnViewProps {
  turn: ChatTurn;
  idx: number;
  allApps: HubApp[];
  onExpand: () => void;
  onChange: (name: string, value: unknown) => void;
  onRun: () => void;
  onCancel: () => void;
  onReset: () => void;
  onIterate: (prompt: string) => void;
  onOpenDetails: (slug: string) => void;
  onPickApp: (app: HubApp) => void;
  onSignIn: () => void;
  onBrowsePublic: () => void;
}

function TurnView({
  turn,
  onExpand,
  onChange,
  onRun,
  onCancel,
  onReset,
  onIterate,
  onOpenDetails,
  allApps,
  onPickApp,
  onSignIn,
  onBrowsePublic,
}: TurnViewProps) {
  if (turn.kind === 'user') {
    return <div className="user-bubble">{turn.text}</div>;
  }
  const s = turn.state;
  switch (s.phase) {
    case 'suggested':
      return (
        <AppSuggestionCard
          app={s.app}
          alternatives={s.alternatives}
          onRun={onExpand}
          onDetails={() => onOpenDetails(s.app.slug)}
          onPickAlternative={(alt) => {
            onOpenDetails(alt.slug);
          }}
        />
      );
    case 'inputs':
      return (
        <AppInputsCard
          app={s.app}
          actionSpec={s.actionSpec}
          inputs={s.inputs}
          onChange={onChange}
          onRun={onRun}
          onReset={onReset}
          onOpenDetails={() => onOpenDetails(s.app.slug)}
        />
      );
    case 'streaming':
      return <StreamingTerminal app={s.app} lines={s.logs} onCancel={onCancel} />;
    case 'done':
      return (
        <OutputPanel
          app={s.app}
          run={s.run}
          onIterate={(p) => onIterate(p)}
          onOpenDetails={() => onOpenDetails(s.app.slug)}
        />
      );
    case 'no-match':
      return (
        <NoMatchCard
          suggestions={s.suggestions}
          onPickApp={onPickApp}
        />
      );
    case 'error':
      return (
        <div className="assistant-turn">
          <div className="app-expanded-card" style={{ background: '#fdf4f1', borderColor: '#e7d0c9' }}>
            <p style={{ margin: 0, color: '#9a3a19', fontWeight: 600 }}>Something went wrong</p>
            <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--muted)' }}>
              {s.message || 'Try rephrasing your request.'}
            </p>
            <button
              type="button"
              onClick={() => onIterate('')}
              style={{
                marginTop: 12,
                padding: '6px 14px',
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 8,
                fontSize: 13,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Try again
            </button>
          </div>
        </div>
      );
    case 'inline-template': {
      switch (s.templateId) {
        case 'public-apps':
          return <PublicAppsResponse apps={allApps} onPickApp={onPickApp} />;
        case 'my-apps':
          return (
            <MyAppsResponse
              isSignedIn={false}
              onSignIn={onSignIn}
              onBrowsePublic={onBrowsePublic}
            />
          );
        case 'build-your-own':
          return <BuildYourOwnResponse />;
        case 'about-floom':
          return <AboutFloomResponse />;
        case 'connect-github':
          return <ConnectGithubResponse isSignedIn={false} onSignIn={onSignIn} />;
        default:
          return null;
      }
    }
  }
}

function NoMatchCard({
  suggestions,
  onPickApp,
}: {
  suggestions: PickResult[];
  onPickApp: (app: HubApp) => void;
}) {
  return (
    <div className="assistant-turn">
      <p className="assistant-preamble">
        I couldn't pick a confident match. Try rephrasing, or start with one of these:
      </p>
      <div className="trending-grid">
        {suggestions.slice(0, 3).map((s) => (
          <button
            key={s.slug}
            type="button"
            className="app-tile"
            onClick={() =>
              onPickApp({
                ...s,
                author: null,
                actions: [],
                runtime: '',
                created_at: '',
              })
            }
            style={{ textAlign: 'left', width: '100%' }}
          >
            <div className="app-tile-icon">
              <AppIcon slug={s.slug} size={24} />
            </div>
            <div className="app-tile-name">{s.name}</div>
            <div className="app-tile-desc">{s.description}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

export type { AppDetail };
