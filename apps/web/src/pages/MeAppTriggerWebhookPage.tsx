import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { WorkspaceHeader, WorkspacePageShell } from '../components/WorkspacePageShell';
import { RunAppTabs } from './MeAppRunPage';
import * as api from '../api/client';
import { crossLinkStyle, inlineLinkStyle, primaryLinkStyle, secondaryLinkStyle } from './MeAppTriggersPage';

export function MeAppTriggerWebhookPage() {
  const { slug = '' } = useParams<{ slug: string }>();
  const [action, setAction] = useState('run');
  const [payload, setPayload] = useState('{"prompt":"stripe vs adyen"}');
  const [secret, setSecret] = useState('');
  const [signature, setSignature] = useState('');
  const [verifyResult, setVerifyResult] = useState<string | null>(null);
  const [response, setResponse] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await api.createWebhookTrigger(slug, { action });
      setResponse(JSON.stringify(res, null, 2));
      setError(null);
    } catch (err) {
      setError((err as Error).message || 'Failed to create webhook trigger');
    }
  }

  async function verify() {
    const expected = await hmacSha256(secret, payload);
    setVerifyResult(signature.trim() === expected ? 'HMAC verified.' : `Expected ${expected}`);
  }

  return (
    <WorkspacePageShell mode="run" title="Webhook trigger | Floom">
      <WorkspaceHeader
        eyebrow="Workspace Run"
        title="Webhook trigger"
        scope="Create and test a signed POST trigger for this installed app."
        actions={<Link to={`/run/apps/${slug}/triggers`} style={secondaryLinkStyle}>Back to triggers</Link>}
      />
      <RunAppTabs slug={slug} active="triggers" />
      <div style={crossLinkStyle}>Webhook runs use workspace BYOK keys. <Link to="/settings/byok-keys" style={inlineLinkStyle}>Manage BYOK keys</Link></div>
      {error ? <div style={errorStyle}>{error}</div> : null}
      <div style={gridStyle}>
        <form onSubmit={create} style={cardStyle}>
          <h2 style={h2Style}>Create webhook</h2>
          <label style={labelStyle}>Action<input value={action} onChange={(e) => setAction(e.target.value)} style={inputStyle} /></label>
          <button type="submit" style={primaryLinkStyle}>Create webhook</button>
          {response ? <pre style={codeStyle}>{response}</pre> : null}
        </form>
        <section style={cardStyle}>
          <h2 style={h2Style}>Test signature</h2>
          <label style={labelStyle}>Payload<textarea value={payload} onChange={(e) => setPayload(e.target.value)} rows={7} style={textareaStyle} /></label>
          <label style={labelStyle}>Webhook secret<input value={secret} onChange={(e) => setSecret(e.target.value)} style={inputStyle} /></label>
          <label style={labelStyle}>HMAC signature<input value={signature} onChange={(e) => setSignature(e.target.value)} style={inputStyle} /></label>
          <button type="button" onClick={() => void verify()} style={secondaryLinkStyle}>Verify HMAC</button>
          {verifyResult ? <div style={resultStyle}>{verifyResult}</div> : null}
        </section>
      </div>
    </WorkspacePageShell>
  );
}

async function hmacSha256(secret: string, payload: string): Promise<string> {
  if (!window.crypto?.subtle) return '';
  const key = await window.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await window.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const gridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
  gap: 14,
};

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 12,
  background: 'var(--card)',
  padding: 20,
  display: 'grid',
  gap: 12,
};

const h2Style: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 750,
  margin: 0,
  color: 'var(--ink)',
};

const labelStyle: React.CSSProperties = {
  display: 'grid',
  gap: 6,
  fontSize: 12,
  fontWeight: 700,
  color: 'var(--muted)',
};

const inputStyle: React.CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 8,
  padding: '10px 12px',
  fontSize: 13,
  color: 'var(--ink)',
  background: 'var(--bg)',
  fontFamily: 'inherit',
};

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  resize: 'vertical',
  fontFamily: 'JetBrains Mono, monospace',
};

const codeStyle: React.CSSProperties = {
  background: '#1b1a17',
  color: '#d4d4c8',
  borderRadius: 8,
  padding: 14,
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 12,
  overflowX: 'auto',
};

const resultStyle: React.CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 8,
  padding: '10px 12px',
  fontSize: 12,
  color: 'var(--ink)',
  overflowWrap: 'anywhere',
};

const errorStyle: React.CSSProperties = {
  background: '#fdecea',
  border: '1px solid #f4b7b1',
  color: '#c2321f',
  borderRadius: 8,
  padding: '10px 12px',
  fontSize: 13,
  marginBottom: 14,
};
