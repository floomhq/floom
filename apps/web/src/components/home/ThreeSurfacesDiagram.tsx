/**
 * ThreeSurfacesDiagram — "paste your app -> get three surfaces" visual.
 *
 * Federico 2026-04-23 (#542): "a simple visual for non-technical folks
 * that shows: paste app, get three surfaces (web page, MCP endpoint,
 * JSON API)". Inline SVG, no bespoke PNG, no animation. Scales cleanly
 * on mobile, single brand accent color, restrained palette.
 *
 * One source box on the left, three target surface boxes on the right,
 * three thin connector lines between them. Intended to sit right after
 * WorkedExample so a visitor reads: "here's one run -> and here are
 * the three places it shows up".
 */
import type { CSSProperties } from 'react';

import { SectionEyebrow } from './SectionEyebrow';

const SECTION_STYLE: CSSProperties = {
  padding: '44px 28px 56px',
  maxWidth: 1040,
  margin: '0 auto',
  textAlign: 'center',
};

const H2_STYLE: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontWeight: 700,
  fontSize: 28,
  lineHeight: 1.15,
  letterSpacing: '-0.025em',
  margin: '0 auto 8px',
  maxWidth: 720,
  color: 'var(--ink)',
  textWrap: 'balance' as unknown as 'balance',
};

const SUB_STYLE: CSSProperties = {
  fontSize: 15,
  color: 'var(--muted)',
  margin: '0 auto 28px',
  maxWidth: 560,
  lineHeight: 1.55,
};

const DIAGRAM_WRAP_STYLE: CSSProperties = {
  maxWidth: 820,
  margin: '0 auto',
};

export function ThreeSurfacesDiagram() {
  return (
    <section data-testid="three-surfaces-diagram" style={SECTION_STYLE}>
      <SectionEyebrow>One app, three surfaces</SectionEyebrow>
      <h2 style={H2_STYLE}>
        Paste your app. Get a web page, an MCP endpoint, and a JSON API.
      </h2>
      <p style={SUB_STYLE}>
        Same logic, three places it shows up. No duplication, no
        per-surface framework to learn.
      </p>

      <div style={DIAGRAM_WRAP_STYLE}>
        <svg
          viewBox="0 0 820 260"
          width="100%"
          height="auto"
          role="img"
          aria-labelledby="three-surfaces-title three-surfaces-desc"
          style={{ display: 'block' }}
        >
          <title id="three-surfaces-title">
            Paste your app to get three surfaces
          </title>
          <desc id="three-surfaces-desc">
            A diagram with one source box labelled "Your app" on the left,
            connected by three lines to three target boxes on the right:
            a web page, an MCP endpoint, and a JSON API.
          </desc>

          <defs>
            <marker
              id="three-surfaces-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path d="M0,0 L10,5 L0,10 z" fill="#047857" />
            </marker>
          </defs>

          {/* Source box — "Your app" */}
          <g>
            <rect
              x="20"
              y="100"
              width="220"
              height="60"
              rx="10"
              ry="10"
              fill="#ffffff"
              stroke="#e5e7eb"
              strokeWidth="1"
            />
            <text
              x="130"
              y="126"
              textAnchor="middle"
              fontFamily="'JetBrains Mono', ui-monospace, monospace"
              fontSize="10"
              fontWeight="600"
              fill="#6b7280"
              letterSpacing="1.2"
            >
              YOUR APP
            </text>
            <text
              x="130"
              y="146"
              textAnchor="middle"
              fontFamily="'Inter', system-ui, sans-serif"
              fontSize="14"
              fontWeight="600"
              fill="#0e0e0c"
            >
              One JSON spec on GitHub
            </text>
          </g>

          {/* Connector lines — source -> 3 targets */}
          <g
            stroke="#047857"
            strokeWidth="1.5"
            fill="none"
            markerEnd="url(#three-surfaces-arrow)"
          >
            <path d="M240,130 C340,130 420,50 550,50" />
            <path d="M240,130 C340,130 420,130 550,130" />
            <path d="M240,130 C340,130 420,210 550,210" />
          </g>

          {/* Three surface boxes */}
          <SurfaceRect
            y={20}
            label="WEB PAGE"
            title="floom.dev/a/your-app"
            hint="Shareable URL. No signup."
          />
          <SurfaceRect
            y={100}
            label="MCP ENDPOINT"
            title="Claude / Cursor / ChatGPT"
            hint="Your app as a tool in the chat."
          />
          <SurfaceRect
            y={180}
            label="JSON API"
            title="POST /api/runs"
            hint="Bearer token. JSON in, JSON out."
          />
        </svg>
      </div>
    </section>
  );
}

interface SurfaceRectProps {
  y: number;
  label: string;
  title: string;
  hint: string;
}

function SurfaceRect({ y, label, title, hint }: SurfaceRectProps) {
  return (
    <g>
      <rect
        x="550"
        y={y}
        width="250"
        height="60"
        rx="10"
        ry="10"
        fill="#ffffff"
        stroke="#e5e7eb"
        strokeWidth="1"
      />
      <text
        x="566"
        y={y + 20}
        fontFamily="'JetBrains Mono', ui-monospace, monospace"
        fontSize="9.5"
        fontWeight="600"
        fill="#047857"
        letterSpacing="1.2"
      >
        {label}
      </text>
      <text
        x="566"
        y={y + 36}
        fontFamily="'Inter', system-ui, sans-serif"
        fontSize="13"
        fontWeight="600"
        fill="#0e0e0c"
      >
        {title}
      </text>
      <text
        x="566"
        y={y + 51}
        fontFamily="'Inter', system-ui, sans-serif"
        fontSize="11.5"
        fill="#6b7280"
      >
        {hint}
      </text>
    </g>
  );
}
