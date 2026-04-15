// FlyFast custom renderer — reference implementation for W2.2.
//
// This renders the FlyFast flight search response as a list of cards sorted
// by price ascending. It is the canonical example of a creator-shipped custom
// renderer: a pure function of props, no state, no custom hooks, < 200 LOC.
//
// The Floom server compiles this file via esbuild at ingest time (see
// apps/server/src/services/renderer-bundler.ts) and serves the result at
// GET /renderer/flyfast/bundle.js. The web client lazy-loads the bundle
// when a flyfast run completes and wraps it in an ErrorBoundary so a crash
// here silently falls back to the default table renderer.
//
// Contract: this file imports only the RenderProps type from @floom/renderer.
// That's the entire stable API surface creators can rely on.

import React from 'react';
import type { RenderProps } from '@floom/renderer/contract';

// The shape FlyFast returns on a successful search. Mirrors the OpenAPI
// response schema defined in examples/flyfast/openapi.yaml (trimmed to the
// fields this renderer uses).
interface Flight {
  origin: string;
  destination: string;
  carrier: string;
  carrier_logo?: string;
  price_eur: number;
  duration_minutes: number;
  stops: number;
  departure: string; // ISO 8601
  arrival: string;   // ISO 8601
  booking_url?: string;
}

interface FlightsResponse {
  results: Flight[];
  query?: string;
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function formatPrice(eur: number): string {
  return `€${eur.toFixed(0)}`;
}

function FlightCard({ flight }: { flight: Flight }): React.ReactElement {
  const stopsLabel =
    flight.stops === 0 ? 'Direct' : flight.stops === 1 ? '1 stop' : `${flight.stops} stops`;
  return (
    <article
      className="flyfast-card"
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto 1fr auto',
        gap: 16,
        padding: 16,
        border: '1px solid #e5e5e5',
        borderRadius: 8,
        background: '#fff',
        marginBottom: 12,
      }}
    >
      <div className="flyfast-carrier" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {flight.carrier_logo && (
          <img
            src={flight.carrier_logo}
            alt={flight.carrier}
            width={32}
            height={32}
            style={{ borderRadius: 4 }}
          />
        )}
        <div style={{ fontWeight: 600 }}>{flight.carrier}</div>
      </div>
      <div className="flyfast-route" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{flight.origin}</div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>{formatTime(flight.departure)}</div>
        </div>
        <div style={{ flex: 1, textAlign: 'center', opacity: 0.6 }}>
          <div style={{ fontSize: 11 }}>{formatDuration(flight.duration_minutes)}</div>
          <div style={{ borderBottom: '1px dashed #ccc', margin: '4px 0' }} />
          <div style={{ fontSize: 11 }}>{stopsLabel}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{flight.destination}</div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>{formatTime(flight.arrival)}</div>
        </div>
      </div>
      <div
        className="flyfast-price"
        style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}
      >
        <div style={{ fontSize: 24, fontWeight: 700 }}>{formatPrice(flight.price_eur)}</div>
        {flight.booking_url && (
          <a
            href={flight.booking_url}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: 12 }}
          >
            Book →
          </a>
        )}
      </div>
    </article>
  );
}

/**
 * Default export: the custom renderer. Floom looks for a default export on
 * the compiled bundle and renders it inside the RendererShell's
 * ErrorBoundary.
 */
export default function FlyFastRenderer({ state, data, error }: RenderProps): React.ReactElement {
  if (state === 'input-available') {
    return <div className="flyfast-loading">Searching flights…</div>;
  }
  if (state === 'output-error') {
    return (
      <div className="flyfast-error" role="alert">
        <strong>Flight search failed</strong>
        <div>{error?.message || 'Unknown error'}</div>
      </div>
    );
  }

  const payload = data as FlightsResponse | undefined;
  const results = Array.isArray(payload?.results) ? payload.results : [];
  if (results.length === 0) {
    return (
      <div className="flyfast-empty">
        <em>No flights found for this query.</em>
      </div>
    );
  }

  // Sort by price ascending (pure function of props, no component state).
  const sorted = [...results].sort((a, b) => a.price_eur - b.price_eur);

  return (
    <div className="flyfast-results">
      {payload?.query && (
        <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 8 }}>
          Results for: <em>{payload.query}</em>
        </div>
      )}
      {sorted.map((flight, i) => (
        <FlightCard key={`${flight.origin}-${flight.destination}-${i}`} flight={flight} />
      ))}
    </div>
  );
}
