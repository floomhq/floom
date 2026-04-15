import { Server, Globe, Terminal, LayoutTemplate, FileCode } from 'lucide-react';

// One spec, four surfaces. The diagram is a hub-and-spoke visual: an OpenAPI
// node on the left, four agent surface nodes on the right, connected by SVG
// paths so the reader sees the relationship in one glance instead of reading
// a paragraph.

const SURFACES = [
  {
    Icon: Server,
    label: 'MCP server',
    desc: 'Auto-generated from each OpenAPI operation. Drop into Claude Desktop, Cursor, Windsurf.',
    accent: '#059669',
  },
  {
    Icon: Globe,
    label: 'HTTP API',
    desc: 'Pass-through proxy with secrets injection. Same routes as the upstream spec.',
    accent: '#059669',
  },
  {
    Icon: Terminal,
    label: 'CLI',
    desc: '@floom/cli. Every action becomes a command. Pipe inputs, pipe outputs.',
    accent: '#059669',
  },
  {
    Icon: LayoutTemplate,
    label: 'Web',
    desc: 'Hosted form + output renderer for every action. Share a permalink, no signup, no SDK.',
    accent: '#059669',
  },
];

export function SurfacesDiagram() {
  return (
    <div className="surfaces-wrap">
      <div className="surfaces-diagram">
        {/* spec node */}
        <div className="surfaces-spec">
          <div className="surfaces-spec-icon">
            <FileCode size={20} />
          </div>
          <div className="surfaces-spec-text">
            <p className="surfaces-spec-label">openapi.json</p>
            <p className="surfaces-spec-meta">one file</p>
          </div>
        </div>

        {/* connecting lines (decorative svg) */}
        <svg
          className="surfaces-lines"
          viewBox="0 0 320 240"
          fill="none"
          aria-hidden="true"
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id="line-grad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#059669" stopOpacity="0.45" />
              <stop offset="100%" stopColor="#059669" stopOpacity="0.05" />
            </linearGradient>
          </defs>
          <path d="M0 120 C 110 120, 180 30,  320 30"  stroke="url(#line-grad)" strokeWidth="1.2" />
          <path d="M0 120 C 110 120, 180 90,  320 90"  stroke="url(#line-grad)" strokeWidth="1.2" />
          <path d="M0 120 C 110 120, 180 150, 320 150" stroke="url(#line-grad)" strokeWidth="1.2" />
          <path d="M0 120 C 110 120, 180 210, 320 210" stroke="url(#line-grad)" strokeWidth="1.2" />
        </svg>

        {/* surface nodes */}
        <div className="surfaces-nodes">
          {SURFACES.map(({ Icon, label, desc }) => (
            <div key={label} className="surface-node">
              <div className="surface-node-head">
                <span className="surface-node-icon">
                  <Icon size={16} />
                </span>
                <span className="surface-node-label">{label}</span>
              </div>
              <p className="surface-node-desc">{desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
