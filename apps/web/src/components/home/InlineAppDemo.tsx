import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plane, Play, ArrowRight, Check, FileCode, Clock } from 'lucide-react';
import { FLYFAST_DEMO, BLAST_RADIUS_DEMO } from '../../data/demoData';

// Inline app demos. NOT a form. Real outputs from the live API are baked in
// as static evidence so the homepage renders the result instantly. The
// "Replay" button just re-animates the response - the data is the same. Hit
// the permalink to get a real, fresh run.

type DemoTab = 'flyfast' | 'blast-radius';

function fmtDuration(min: number) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h ${m}m`;
}

function fmtTime(iso: string) {
  return iso.slice(11, 16);
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function FlightCard({ flight }: { flight: typeof FLYFAST_DEMO.flights[number] }) {
  const firstLeg = flight.legs[0];
  const lastLeg = flight.legs[flight.legs.length - 1];
  return (
    <a
      href={flight.booking_url}
      target="_blank"
      rel="noreferrer"
      className="flight-card"
    >
      <div className="flight-card-row">
        <div className="flight-card-times">
          <span className="flight-card-time">{fmtTime(firstLeg.departs)}</span>
          <span className="flight-card-arrow">
            <ArrowRight size={12} />
          </span>
          <span className="flight-card-time">{fmtTime(lastLeg.arrives)}</span>
        </div>
        <div className="flight-card-price">
          €{flight.price}
        </div>
      </div>
      <div className="flight-card-row">
        <div className="flight-card-meta">
          {flight.route} · {fmtDuration(flight.duration_minutes)} · {flight.stops === 0 ? 'Direct' : `${flight.stops} stop`}
        </div>
        <div className="flight-card-date">{fmtDate(flight.date)}</div>
      </div>
    </a>
  );
}

function BlastOutput() {
  const out = BLAST_RADIUS_DEMO.output;
  return (
    <div className="blast-output">
      <div className="blast-summary">
        <Check size={14} />
        <span>{out.summary}</span>
      </div>
      <div className="blast-cols">
        <div className="blast-col">
          <p className="blast-col-label">changed ({out.changed.length})</p>
          <ul className="blast-list">
            {out.changed.slice(0, 6).map((f) => (
              <li key={f}><FileCode size={11} /> {f}</li>
            ))}
            {out.changed.length > 6 && <li className="blast-more">+{out.changed.length - 6} more</li>}
          </ul>
        </div>
        <div className="blast-col">
          <p className="blast-col-label">affected ({out.affected.length})</p>
          <ul className="blast-list">
            {out.affected.slice(0, 6).map((f) => (
              <li key={f}><FileCode size={11} /> {f}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

export function InlineAppDemo() {
  const [tab, setTab] = useState<DemoTab>('flyfast');
  const [replaying, setReplaying] = useState(false);

  const replay = () => {
    setReplaying(true);
    setTimeout(() => setReplaying(false), 700);
  };

  return (
    <div className="demo-wrap">
      <div className="demo-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'flyfast'}
          className={`demo-tab ${tab === 'flyfast' ? 'is-active' : ''}`}
          onClick={() => setTab('flyfast')}
        >
          <Plane size={13} />
          FlyFast
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'blast-radius'}
          className={`demo-tab ${tab === 'blast-radius' ? 'is-active' : ''}`}
          onClick={() => setTab('blast-radius')}
        >
          <FileCode size={13} />
          Blast Radius
        </button>
        <div className="demo-tabs-spacer" />
        <button type="button" className="demo-replay" onClick={replay}>
          <Play size={11} /> Replay
        </button>
      </div>

      {tab === 'flyfast' ? (
        <div className="demo-body">
          <div className="demo-prompt">
            <span className="demo-prompt-label">prompt</span>
            <code>{FLYFAST_DEMO.prompt}</code>
          </div>
          <div className="demo-status">
            <span className="status-dot" />
            <span>Returned {FLYFAST_DEMO.total_results} flights in {(FLYFAST_DEMO.duration_ms / 1000).toFixed(1)}s</span>
            <Clock size={11} style={{ marginLeft: 'auto', opacity: 0.6 }} />
          </div>
          <div className={`demo-results ${replaying ? 'is-replaying' : ''}`}>
            {FLYFAST_DEMO.flights.map((f, i) => (
              <FlightCard key={`${f.date}-${i}`} flight={f} />
            ))}
          </div>
          <div className="demo-actions">
            <Link to="/p/flyfast" className="demo-cta">
              Run it yourself <ArrowRight size={12} />
            </Link>
            <code className="demo-curl">POST /api/flyfast/run</code>
          </div>
        </div>
      ) : (
        <div className="demo-body">
          <div className="demo-prompt">
            <span className="demo-prompt-label">repo_url</span>
            <code>{BLAST_RADIUS_DEMO.repo_url}</code>
          </div>
          <div className="demo-status">
            <span className="status-dot" />
            <span>Diffed {BLAST_RADIUS_DEMO.base_branch} in {(BLAST_RADIUS_DEMO.duration_ms / 1000).toFixed(1)}s</span>
            <Clock size={11} style={{ marginLeft: 'auto', opacity: 0.6 }} />
          </div>
          <div className={`demo-results ${replaying ? 'is-replaying' : ''}`}>
            <BlastOutput />
          </div>
          <div className="demo-actions">
            <Link to="/p/blast-radius" className="demo-cta">
              Run it yourself <ArrowRight size={12} />
            </Link>
            <code className="demo-curl">POST /api/blast-radius/run</code>
          </div>
        </div>
      )}
    </div>
  );
}
