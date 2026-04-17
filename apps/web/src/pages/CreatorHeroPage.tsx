import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Globe,
  LayoutDashboard,
  LayoutTemplate,
  Server,
  ShieldCheck,
} from 'lucide-react';
import { TopBar } from '../components/TopBar';
import { Footer } from '../components/Footer';
import { FeedbackButton } from '../components/FeedbackButton';
import { useSession } from '../hooks/useSession';
import {
  LaunchAppsStrip,
  type LaunchStripItem,
} from '../components/home/LaunchAppsStrip';
import { ProductionLayerDiagram } from '../components/home/ProductionLayerDiagram';
import { RequestFlowStack } from '../components/home/RequestFlowStack';
import { SelfHostTerminal } from '../components/home/SelfHostTerminal';
import { getHub } from '../api/client';
import type { HubApp } from '../lib/types';
import { LAUNCH_APPS } from '../data/demoData';
import '../components/home/home.css';

const HERO_BADGE = 'Self-host with Docker or apps.yaml · open source';

const BUILT_IN_CHIPS = [
  'Auth',
  'Access control',
  'Logs',
  'Reviews',
  'Feedback',
  'Secrets',
];

const SURFACES = [
  {
    Icon: Server,
    label: 'MCP server',
    desc: 'One endpoint per app for Claude Desktop, Cursor, and other MCP clients.',
  },
  {
    Icon: Globe,
    label: 'HTTP API',
    desc: 'POST /api/run plus the same proxied request path Floom wraps for the web UI.',
  },
  {
    Icon: LayoutDashboard,
    label: 'Operator views',
    desc: 'Creator dashboards, run history, installs, and feedback stay attached to the same app.',
  },
  {
    Icon: LayoutTemplate,
    label: 'Web run surface',
    desc: 'Shareable /p/:slug pages with typed inputs, rendered outputs, reviews, and feedback.',
  },
];

const SELF_HOST_POINTS = [
  'The default self-host story is an empty hub. Add apps through apps.yaml when you are ready.',
  'Bundled preview apps are opt-in via FLOOM_SEED_APPS=true, with blocked_reason surfaced when something cannot run in OSS.',
  'Secrets can come from env vars or per-call MCP _auth payloads for apps that need user-specific tokens.',
  'Feedback, reviews, app memory, and encrypted user secrets already live behind the current backend.',
];

const WORKS_WITH = [
  'Store pages',
  'Shareable app URLs',
  'HTTP API',
  'MCP endpoints',
  'Creator dashboard',
  'Self-host docs',
];

const APPS_YAML = `apps:
  - slug: petstore
    type: proxied
    openapi_spec_url: https://petstore3.swagger.io/api/v3/openapi.json
    display_name: Petstore
    category: developer-tools`;

const FALLBACK_PREVIEW_APPS: LaunchStripItem[] = LAUNCH_APPS.slice(0, 8).map((app) => ({
  slug: app.slug,
  name: app.name,
  category: app.category,
  tagline: app.tagline,
}));

function mapHubAppToStrip(app: HubApp): LaunchStripItem {
  return {
    slug: app.slug,
    name: app.name,
    category: app.category,
    tagline: app.description,
    blockedReason: app.blocked_reason ?? null,
  };
}

function SectionIntro({
  eyebrow,
  title,
  copy,
  align = 'left',
}: {
  eyebrow: string;
  title: string;
  copy: string;
  align?: 'left' | 'center';
}) {
  return (
    <div
      style={{
        maxWidth: align === 'center' ? 760 : 560,
        textAlign: align,
      }}
    >
      <p
        className="label-mono"
        style={{
          margin: '0 0 8px',
        }}
      >
        {eyebrow}
      </p>
      <h2
        className="section-title-display"
        style={{
          marginBottom: 14,
        }}
      >
        {title}
      </h2>
      <p
        style={{
          margin: 0,
          fontSize: 15,
          color: 'var(--muted)',
          lineHeight: 1.7,
        }}
      >
        {copy}
      </p>
    </div>
  );
}

export function CreatorHeroPage() {
  const { isAuthenticated } = useSession();
  const [previewApps, setPreviewApps] = useState<LaunchStripItem[]>(FALLBACK_PREVIEW_APPS);
  const deployHref = isAuthenticated ? '/build' : '/signup?next=%2Fbuild';
  const featuredPreviewApps = previewApps.slice(0, 3);
  const recentPreviewApps = previewApps.slice(0, 6);

  useEffect(() => {
    document.title = 'Floom · Production infrastructure for AI apps that do real work';
    getHub()
      .then((apps) => {
        if (apps.length > 0) {
          setPreviewApps(apps.slice(0, 8).map(mapHubAppToStrip));
        }
      })
      .catch(() => {
        // Keep the homepage stable even when the API is unavailable.
      });
  }, []);

  return (
    <div className="page-root" data-testid="creator-hero">
      <TopBar />

      <main style={{ display: 'block' }}>
        <section
          style={{
            padding: '48px 24px 72px',
          }}
        >
          <div
            style={{
              maxWidth: 1120,
              margin: '0 auto',
              display: 'grid',
              gap: 24,
            }}
          >
            <div
              style={{
                border: '1px solid var(--line)',
                borderRadius: 18,
                background: 'rgba(255,255,255,0.9)',
                overflow: 'hidden',
                boxShadow: '0 18px 44px rgba(14,14,12,0.05)',
              }}
            >
              <div
                style={{
                  padding: '64px 28px 28px',
                  textAlign: 'center',
                  borderBottom: '1px solid var(--line)',
                }}
              >
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    padding: '7px 14px',
                    borderRadius: 999,
                    border: '1px solid var(--accent-border)',
                    background: 'var(--accent-soft)',
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--accent-hover)',
                    lineHeight: 1,
                    marginBottom: 20,
                  }}
                >
                  {HERO_BADGE}
                </span>

                <h1
                  className="headline"
                  style={{
                    maxWidth: 760,
                    margin: '0 auto 18px',
                    textWrap: 'balance' as unknown as 'balance',
                  }}
                >
                  Vibe-coding speed.
                  <br />
                  Production-grade safety.
                </h1>

                <p
                  className="subhead"
                  style={{
                    maxWidth: 560,
                    margin: '0 auto 28px',
                    fontSize: 19,
                  }}
                >
                  The open-source production layer for AI apps.
                </p>

                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'center',
                    gap: 12,
                    flexWrap: 'wrap',
                  }}
                >
                  <Link
                    to={deployHref}
                    className="btn-primary"
                    data-testid="hero-cta-ship"
                    style={{
                      padding: '12px 24px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    Deploy an app <ArrowRight size={14} />
                  </Link>
                  <Link
                    to="/apps"
                    data-testid="hero-cta-try"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '12px 24px',
                      borderRadius: 10,
                      border: '1px solid var(--line)',
                      background: 'var(--card)',
                      color: 'var(--ink)',
                      fontSize: 14,
                      fontWeight: 600,
                      textDecoration: 'none',
                    }}
                  >
                    Browse the store
                  </Link>
                </div>
              </div>

              <div
                data-testid="hero-demo"
                style={{
                  padding: '28px',
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
                  gap: 28,
                  alignItems: 'start',
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
                  <SectionIntro
                    eyebrow="How Floom works"
                    title="One layer between your app and real users."
                    copy="Ship a vibe-coded app. Floom wraps it in the production layer every real product needs, so anyone can install it, run it, and trust it."
                  />
                  <ProductionLayerDiagram />
                  <div
                    style={{
                      background:
                        'linear-gradient(180deg, rgba(5,150,105,0.06), rgba(5,150,105,0.02))',
                      border: '1px solid var(--accent-border)',
                      borderRadius: 12,
                      padding: '16px 18px',
                    }}
                  >
                    <p
                      style={{
                        margin: '0 0 10px',
                        fontSize: 14,
                        fontWeight: 700,
                        color: 'var(--ink)',
                      }}
                    >
                      Included in every app
                    </p>
                    <div
                      style={{
                        display: 'flex',
                        gap: 8,
                        flexWrap: 'wrap',
                      }}
                    >
                      {BUILT_IN_CHIPS.map((chip) => (
                        <span
                          key={chip}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            padding: '7px 10px',
                            borderRadius: 999,
                            background: 'rgba(255,255,255,0.78)',
                            color: 'var(--accent-hover)',
                            border: '1px solid var(--accent-border)',
                            fontSize: 11,
                            fontWeight: 600,
                            lineHeight: 1,
                          }}
                        >
                          {chip}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                <div style={{ minWidth: 0 }}>
                  <LaunchAppsStrip apps={previewApps} />
                </div>
              </div>
            </div>

            <p
              style={{
                margin: 0,
                fontSize: 13,
                color: 'var(--muted)',
                lineHeight: 1.6,
                maxWidth: 760,
              }}
            >
              Feature truth comes from the shipped MVP and backend routes. The wireframes drive the
              design and hierarchy, not fantasy features.
            </p>
          </div>
        </section>

        <section
          style={{
            borderTop: '1px solid var(--line)',
            borderBottom: '1px solid var(--line)',
            padding: '72px 24px',
          }}
        >
          <div
            style={{
              maxWidth: 1120,
              margin: '0 auto',
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
              gap: 28,
              alignItems: 'start',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              <SectionIntro
                eyebrow="Every layer a real product needs"
                title="What happens to every request."
                copy="From the moment a user hits your app to the response they see: auth, limits and access, app execution, and response handling all pass through the same envelope."
              />

              <div
                style={{
                  display: 'grid',
                  gap: 14,
                }}
              >
                {SURFACES.map(({ Icon, label, desc }) => (
                  <div
                    key={label}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '26px minmax(0, 1fr)',
                      gap: 12,
                      alignItems: 'start',
                      background: 'var(--card)',
                      border: '1px solid var(--line)',
                      borderRadius: 8,
                      padding: '16px 16px 15px',
                    }}
                  >
                    <span
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: 8,
                        background: 'var(--accent-soft)',
                        color: 'var(--accent-hover)',
                        border: '1px solid var(--accent-border)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Icon size={14} />
                    </span>
                    <div>
                      <p
                        style={{
                          margin: '0 0 4px',
                          fontSize: 14,
                          fontWeight: 700,
                          color: 'var(--ink)',
                        }}
                      >
                        {label}
                      </p>
                      <p
                        style={{
                          margin: 0,
                          fontSize: 13,
                          color: 'var(--muted)',
                          lineHeight: 1.6,
                        }}
                      >
                        {desc}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ minWidth: 0 }}>
              <RequestFlowStack />
            </div>
          </div>
        </section>

        <section
          id="self-host"
          data-testid="self-host-section"
          style={{
            padding: '72px 24px',
          }}
        >
          <div
            style={{
              maxWidth: 1120,
              margin: '0 auto',
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
              gap: 28,
              alignItems: 'start',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <SectionIntro
                eyebrow="For builders"
                title="Deploy in minutes. Not weeks."
                copy="Point Floom at an OpenAPI spec or hosted app and you get the production layer, a store listing, a real URL, MCP, and creator surfaces without stitching them together by hand."
              />

              <div
                style={{
                  background: 'var(--card)',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    padding: '12px 14px',
                    borderBottom: '1px solid var(--line)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                  }}
                >
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: 'var(--ink)',
                    }}
                  >
                    apps.yaml starter
                  </span>
                  <span
                    style={{
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 11,
                      color: 'var(--muted)',
                    }}
                  >
                    proxied mode
                  </span>
                </div>
                <pre
                  style={{
                    margin: 0,
                    padding: '16px 16px 18px',
                    background: 'rgba(255,255,255,0.72)',
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 12,
                    lineHeight: 1.7,
                    color: 'var(--ink)',
                    overflowX: 'auto',
                  }}
                >
                  {APPS_YAML}
                </pre>
              </div>

              <div
                style={{
                  display: 'grid',
                  gap: 12,
                }}
              >
                {SELF_HOST_POINTS.map((item) => (
                  <div
                    key={item}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '20px minmax(0, 1fr)',
                      gap: 10,
                      alignItems: 'start',
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: '50%',
                        background: 'var(--accent-soft)',
                        color: 'var(--accent-hover)',
                        border: '1px solid var(--accent-border)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        marginTop: 1,
                      }}
                    >
                      <ShieldCheck size={12} />
                    </span>
                    <p
                      style={{
                        margin: 0,
                        fontSize: 14,
                        color: 'var(--muted)',
                        lineHeight: 1.6,
                      }}
                    >
                      {item}
                    </p>
                  </div>
                ))}
              </div>

              <div
                style={{
                  display: 'flex',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <Link
                  to={deployHref}
                  className="btn-primary"
                  style={{
                    padding: '12px 18px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  Deploy your first app <ArrowRight size={14} />
                </Link>
                <Link
                  to="/protocol"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '11px 18px',
                    borderRadius: 10,
                    border: '1px solid var(--line)',
                    background: 'var(--card)',
                    color: 'var(--ink)',
                    fontSize: 14,
                    fontWeight: 600,
                    textDecoration: 'none',
                  }}
                >
                  Read the docs
                </Link>
              </div>
            </div>

            <div style={{ minWidth: 0 }}>
              <SelfHostTerminal />
            </div>
          </div>
        </section>

        <section
          style={{
            borderTop: '1px solid var(--line)',
            borderBottom: '1px solid var(--line)',
            padding: '72px 24px',
          }}
        >
          <div
            style={{
              maxWidth: 1120,
              margin: '0 auto',
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
              gap: 28,
              alignItems: 'start',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <SectionIntro
                eyebrow="For your whole team"
                title="Real apps, for real work. From the store."
                copy="Your coworkers are not builders. They need a clear store, a runnable page, and trusted surfaces they can use without learning the internals."
              />

              <div style={{ display: 'grid', gap: 14 }}>
                {featuredPreviewApps.map((app, index) => (
                  <Link
                    key={app.slug}
                    to={`/p/${app.slug}`}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 10,
                      padding: '18px 18px 16px',
                      borderRadius: 12,
                      border: '1px solid var(--line)',
                      background: 'var(--card)',
                      color: 'inherit',
                      textDecoration: 'none',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        justifyContent: 'space-between',
                        gap: 12,
                      }}
                    >
                      <div>
                        <p
                          style={{
                            margin: '0 0 4px',
                            fontSize: 16,
                            fontWeight: 700,
                            color: 'var(--ink)',
                          }}
                        >
                          {app.name}
                        </p>
                        <p
                          style={{
                            margin: 0,
                            fontSize: 12,
                            color: 'var(--muted)',
                            textTransform: 'capitalize',
                          }}
                        >
                          {app.category || 'utility'}
                        </p>
                      </div>
                      <span
                        style={{
                          padding: '7px 10px',
                          borderRadius: 999,
                          background: index === 0 ? 'var(--accent)' : 'var(--card)',
                          color: index === 0 ? '#fff' : 'var(--ink)',
                          border: `1px solid ${index === 0 ? 'var(--accent)' : 'var(--line)'}`,
                          fontSize: 12,
                          fontWeight: 700,
                          lineHeight: 1,
                        }}
                      >
                        Open
                      </span>
                    </div>
                    <p
                      style={{
                        margin: 0,
                        fontSize: 13,
                        color: 'var(--muted)',
                        lineHeight: 1.6,
                      }}
                    >
                      {app.tagline}
                    </p>
                  </Link>
                ))}
              </div>

              <div
                style={{
                  display: 'flex',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <Link
                  to="/apps"
                  className="btn-primary"
                  style={{
                    padding: '12px 18px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  Browse the store <ArrowRight size={14} />
                </Link>
                <Link
                  to={deployHref}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '11px 18px',
                    borderRadius: 10,
                    border: '1px solid var(--line)',
                    background: 'var(--card)',
                    color: 'var(--ink)',
                    fontSize: 14,
                    fontWeight: 600,
                    textDecoration: 'none',
                  }}
                >
                  Deploy an app
                </Link>
              </div>
            </div>

            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  background: 'var(--card)',
                  border: '1px solid var(--line)',
                  borderRadius: 12,
                  padding: 22,
                  display: 'grid',
                  gap: 18,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    flexWrap: 'wrap',
                  }}
                >
                  <div>
                    <p className="label-mono" style={{ margin: '0 0 6px' }}>
                      /me preview
                    </p>
                    <p
                      style={{
                        margin: 0,
                        fontSize: 14,
                        color: 'var(--muted)',
                      }}
                    >
                      Recent apps from the live preview catalog.
                    </p>
                  </div>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      padding: '5px 9px',
                      borderRadius: 999,
                      background: 'var(--accent-soft)',
                      color: 'var(--accent-hover)',
                      border: '1px solid var(--accent-border)',
                    }}
                  >
                    live
                  </span>
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                    gap: 12,
                  }}
                >
                  {recentPreviewApps.map((app) => (
                    <Link
                      key={app.slug}
                      to={`/p/${app.slug}`}
                      style={{
                        display: 'block',
                        padding: '14px 14px 13px',
                        borderRadius: 10,
                        border: '1px solid var(--line)',
                        background: 'var(--bg)',
                        textDecoration: 'none',
                        color: 'inherit',
                      }}
                    >
                      <p
                        style={{
                          margin: '0 0 4px',
                          fontSize: 13,
                          fontWeight: 700,
                          color: 'var(--ink)',
                        }}
                      >
                        {app.name}
                      </p>
                      <p
                        style={{
                          margin: 0,
                          fontSize: 11,
                          color: 'var(--muted)',
                          textTransform: 'capitalize',
                        }}
                      >
                        {app.category || 'utility'}
                      </p>
                    </Link>
                  ))}
                </div>

                <p
                  style={{
                    margin: 0,
                    fontSize: 12,
                    color: 'var(--muted)',
                    lineHeight: 1.6,
                  }}
                >
                  The store, app pages, MCP endpoints, and creator surfaces all read from the same
                  live hub data.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section
          style={{
            padding: '72px 24px 84px',
          }}
        >
          <div
            style={{
              maxWidth: 1120,
              margin: '0 auto',
              display: 'grid',
              gap: 28,
            }}
          >
            <SectionIntro
              eyebrow="Works with"
              title="Two sides, one launch."
              copy="Builder entry points and user entry points are both live now. The current product already supports the deploy flow, store, app pages, HTTP, and MCP while the next UI ramps stay clearly staged."
            />

            <div
              style={{
                display: 'flex',
                gap: 10,
                flexWrap: 'wrap',
              }}
            >
              {WORKS_WITH.map((item) => (
                <span
                  key={item}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    padding: '8px 12px',
                    borderRadius: 999,
                    background: 'var(--card)',
                    color: 'var(--ink)',
                    border: '1px solid var(--line)',
                    fontSize: 12,
                    fontWeight: 600,
                    lineHeight: 1,
                  }}
                >
                  {item}
                </span>
              ))}
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                gap: 16,
              }}
            >
              <div
                style={{
                  background: 'var(--card)',
                  border: '1px solid var(--line)',
                  borderRadius: 12,
                  padding: '22px 20px',
                  display: 'grid',
                  gap: 14,
                }}
              >
                <div>
                  <p className="label-mono" style={{ margin: '0 0 8px' }}>
                    I want to deploy apps
                  </p>
                  <h3
                    style={{
                      margin: 0,
                      fontSize: 24,
                      fontWeight: 700,
                      color: 'var(--ink)',
                    }}
                  >
                    Builder entry
                  </h3>
                </div>
                <p style={{ margin: 0, fontSize: 14, color: 'var(--muted)', lineHeight: 1.65 }}>
                  Start with signup, land in the deploy flow, and publish into the same store your
                  users browse later.
                </p>
                <Link
                  to={deployHref}
                  className="btn-primary"
                  style={{
                    padding: '12px 18px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    justifySelf: 'start',
                  }}
                >
                  Deploy an app <ArrowRight size={14} />
                </Link>
              </div>

              <div
                style={{
                  background: 'var(--card)',
                  border: '1px solid var(--line)',
                  borderRadius: 12,
                  padding: '22px 20px',
                  display: 'grid',
                  gap: 14,
                }}
              >
                <div>
                  <p className="label-mono" style={{ margin: '0 0 8px' }}>
                    I want to use apps
                  </p>
                  <h3
                    style={{
                      margin: 0,
                      fontSize: 24,
                      fontWeight: 700,
                      color: 'var(--ink)',
                    }}
                  >
                    User entry
                  </h3>
                </div>
                <p style={{ margin: 0, fontSize: 14, color: 'var(--muted)', lineHeight: 1.65 }}>
                  Browse the store, open an app page, and run the same app over web, MCP, or HTTP
                  without learning the backend story first.
                </p>
                <Link
                  to="/apps"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '11px 18px',
                    borderRadius: 10,
                    border: '1px solid var(--line)',
                    background: 'var(--card)',
                    color: 'var(--ink)',
                    fontSize: 14,
                    fontWeight: 600,
                    textDecoration: 'none',
                    justifySelf: 'start',
                  }}
                >
                  Browse the store
                </Link>
              </div>
            </div>

            <p
              style={{
                margin: 0,
                fontSize: 13,
                color: 'var(--muted)',
                lineHeight: 1.7,
                maxWidth: 860,
              }}
            >
              Live today: signup, deploy flow, creator dashboard, store, app pages, HTTP runs, and
              MCP endpoints. Still staged: workspace switcher UI, connected tools, Stripe
              monetization UI, async jobs, and custom renderer upload.
            </p>
          </div>
        </section>
      </main>

      <Footer />
      <FeedbackButton />
    </div>
  );
}
