import { useEffect, useState } from 'react';
import { Copy, Check } from 'lucide-react';

// Real docker run command (the image is published to ghcr.io/floomhq) plus a
// simulated terminal showing what the operator sees: image pull, manifest
// load, the four surfaces registering, server up. Everything below the prompt
// is a static script that types itself out so it feels live.

const DOCKER_CMD = `docker run -p 3051:3051 \\
  -v $(pwd)/apps.yaml:/app/config/apps.yaml:ro \\
  -e FLOOM_APPS_CONFIG=/app/config/apps.yaml \\
  -e STRIPE_SECRET_KEY=sk_test_... \\
  ghcr.io/floomhq/floom-monorepo:v0.1.0`;

const TERMINAL_SCRIPT: { text: string; cls?: string; delay?: number }[] = [
  { text: '$ docker run -p 3051:3051 ghcr.io/floomhq/floom-monorepo:v0.1.0', cls: 'term-cmd', delay: 0 },
  { text: 'Unable to find image \'ghcr.io/floomhq/floom-monorepo:v0.1.0\' locally', cls: 'term-dim', delay: 220 },
  { text: 'v0.1.0: Pulling from floomhq/floom-monorepo', cls: 'term-dim', delay: 320 },
  { text: 'Digest: sha256:c4f1a7…  Status: Downloaded newer image', cls: 'term-dim', delay: 460 },
  { text: '', delay: 520 },
  { text: '[floom] booting v0.1.0', cls: 'term-info', delay: 600 },
  { text: '[floom] reading apps.yaml … 1 app found', cls: 'term-info', delay: 720 },
  { text: '[floom] fetching openapi spec from docs.stripe.com … 832 KB', cls: 'term-info', delay: 880 },
  { text: '[floom] generating MCP server     ✓  47 tools', cls: 'term-ok', delay: 1040 },
  { text: '[floom] generating HTTP proxy     ✓  /api/stripe/*', cls: 'term-ok', delay: 1180 },
  { text: '[floom] generating CLI commands   ✓  floom stripe …', cls: 'term-ok', delay: 1320 },
  { text: '[floom] generating web renderer   ✓  /p/stripe', cls: 'term-ok', delay: 1460 },
  { text: '', delay: 1520 },
  { text: '[floom] ready  →  http://localhost:3051', cls: 'term-ready', delay: 1620 },
];

function useTypewriter() {
  const [step, setStep] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const tick = (i: number) => {
      if (cancelled) return;
      if (i >= TERMINAL_SCRIPT.length) return;
      setStep(i + 1);
      const next = TERMINAL_SCRIPT[i + 1];
      if (next) {
        const wait = (next.delay ?? 0) - (TERMINAL_SCRIPT[i].delay ?? 0);
        setTimeout(() => tick(i + 1), Math.max(80, wait));
      }
    };
    setTimeout(() => tick(0), 250);
    return () => { cancelled = true; };
  }, []);

  return step;
}

export function SelfHostTerminal() {
  const [copied, setCopied] = useState(false);
  const step = useTypewriter();

  const copy = () => {
    try { navigator.clipboard.writeText(DOCKER_CMD).catch(() => {}); } catch { /* ignore */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="terminal">
      <div className="terminal-head">
        <div className="terminal-traffic">
          <span /><span /><span />
        </div>
        <span className="terminal-title">~/floom · sh</span>
        <button type="button" className="codeblock-copy" onClick={copy}>
          {copied ? <><Check size={11} /> Copied</> : <><Copy size={11} /> Copy</>}
        </button>
      </div>
      <pre className="terminal-body">
        <code>
          <span className="term-cmd">{DOCKER_CMD}</span>
          {'\n\n'}
          {TERMINAL_SCRIPT.slice(0, step).map((line, i) => (
            <div key={i} className={line.cls || 'term-out'}>
              {line.text || '\u00a0'}
            </div>
          ))}
          {step < TERMINAL_SCRIPT.length && <span className="term-cursor">▍</span>}
        </code>
      </pre>
    </div>
  );
}
