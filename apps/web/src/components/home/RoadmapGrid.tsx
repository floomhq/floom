import { useState } from 'react';
import {
  Webhook,
  Clock,
  Bookmark,
  ShieldCheck,
  Database,
  Globe,
  Activity,
  GitBranch,
  RotateCcw,
  CreditCard,
  Lock,
  ArrowRight,
} from 'lucide-react';

// Roadmap as a dense grid plus a single waitlist form. The form posts to the
// already-working /api/deploy-waitlist endpoint - no other waitlists exist on
// the page so this is the one place a visitor leaves an email.

const ROADMAP_ITEMS = [
  { Icon: Webhook,     label: 'Webhooks',          desc: 'Trigger any app from external events.' },
  { Icon: Clock,       label: 'Scheduling',        desc: 'Cron-like recurring runs.' },
  { Icon: Bookmark,    label: 'Save to my apps',   desc: 'Personal app collection per account.' },
  { Icon: ShieldCheck, label: 'Access control',    desc: 'RBAC per app, per team.' },
  { Icon: Database,    label: 'Per-app database',  desc: 'Persistent state, no external DB.' },
  { Icon: GitBranch,   label: 'Versioning',        desc: 'Diff and rollback every deploy.' },
  { Icon: RotateCcw,   label: 'Staging env',       desc: 'Preview before promoting to prod.' },
  { Icon: Activity,    label: 'Analytics',         desc: 'Per-action usage and latency.' },
  { Icon: CreditCard,  label: 'Payment',           desc: 'Charge per run or per subscription.' },
  { Icon: Globe,       label: 'Custom domains',    desc: 'apps.yourcompany.com.' },
  { Icon: Lock,        label: 'Private apps',      desc: 'Hide from the public directory.' },
  { Icon: ShieldCheck, label: 'Auth providers',    desc: 'GitHub, Google, Microsoft, SSO.' },
];

export function RoadmapGrid() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'submitting' | 'submitted' | 'error'>('idle');
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = email.trim();
    if (!v || !v.includes('@')) {
      setError('Please enter a valid email.');
      return;
    }
    setState('submitting');
    setError('');
    try {
      const res = await fetch('/api/deploy-waitlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: v }),
      });
      if (!res.ok) throw new Error('server');
      setState('submitted');
    } catch {
      setState('error');
      setError('Something went wrong. Try again.');
    }
  };

  return (
    <div className="roadmap">
      <div className="roadmap-grid">
        {ROADMAP_ITEMS.map(({ Icon, label, desc }) => (
          <div key={label} className="roadmap-cell">
            <span className="roadmap-cell-icon">
              <Icon size={14} />
            </span>
            <div className="roadmap-cell-text">
              <p className="roadmap-cell-label">{label}</p>
              <p className="roadmap-cell-desc">{desc}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="roadmap-cta">
        <div className="roadmap-cta-text">
          <p className="roadmap-cta-eyebrow">Cloud waitlist</p>
          <h3 className="roadmap-cta-title">Get notified as each ships.</h3>
          <p className="roadmap-cta-sub">
            One email when the next item lands. No newsletter, no drip campaign, no spam.
          </p>
        </div>
        {state === 'submitted' ? (
          <div className="roadmap-cta-form is-success" data-testid="waitlist-success">
            You're in. We'll email <strong>{email}</strong>.
          </div>
        ) : (
          <form
            onSubmit={submit}
            className="roadmap-cta-form"
            data-testid="waitlist-form"
          >
            <input
              type="email"
              required
              placeholder="you@company.com"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError(''); }}
              data-testid="waitlist-email-input"
            />
            <button type="submit" disabled={state === 'submitting'} data-testid="waitlist-notify-btn">
              {state === 'submitting' ? 'Sending…' : (
                <>Notify me <ArrowRight size={12} /></>
              )}
            </button>
            {error && <p className="roadmap-cta-error">{error}</p>}
          </form>
        )}
      </div>
    </div>
  );
}
