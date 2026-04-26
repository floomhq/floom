import type { ActionSpec, PickResult } from '../../lib/types';
import { AppIcon } from '../AppIcon';
import { DescriptionMarkdown } from '../DescriptionMarkdown';

import { InputField } from './InputField';

interface Props {
  app: PickResult;
  actionSpec: ActionSpec;
  inputs: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
  onRun: () => void;
  onReset: () => void;
  onOpenDetails?: () => void;
}

export function AppInputsCard({
  app,
  actionSpec,
  inputs,
  onChange,
  onRun,
  onReset,
  onOpenDetails,
}: Props) {
  return (
    <div className="assistant-turn">
      <p className="assistant-preamble">
        <strong>{app.name}</strong> is the best fit. Want me to run it?
      </p>
      {/* data-testid hook (2026-04-20): OutputPanel's error classifier
          focuses the first input inside this card when a
          user_input_error (4xx from upstream) comes back, so retrying
          means fixing the input, not clicking Run again. */}
      <div className="app-expanded-card" data-testid="app-inputs-card">
        <div className="app-expanded-header">
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 10,
              border: '1px solid var(--line)',
              background: 'var(--bg)',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--ink)',
              cursor: onOpenDetails ? 'pointer' : 'default',
            }}
            onClick={onOpenDetails}
          >
            <AppIcon slug={app.slug} size={22} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink)' }}>{app.name}</span>
              <span className="category-pill">{app.category || 'app'}</span>
            </div>
            {/* 2026-04-23: Fix #413 — render description as markdown. */}
            {app.description && (
              <DescriptionMarkdown
                description={app.description}
                testId={`app-inputs-card-desc-${app.slug}`}
                style={{
                  fontSize: 13,
                  color: 'var(--muted)',
                  margin: '4px 0 0',
                  maxWidth: 'none',
                }}
              />
            )}
          </div>
        </div>
        <div className="divider" />
        <p className="parsed-hint">Auto-parsed from your prompt. Edit anything.</p>

        {actionSpec.inputs.map((inp) => (
          <InputField
            key={inp.name}
            spec={inp}
            value={inputs[inp.name]}
            onChange={(v) => onChange(inp.name, v)}
            idPrefix="app-card"
            appSlug={app.slug}
          />
        ))}

        <div className="action-row">
          <button
            type="button"
            className="btn-primary"
            style={{ height: 40, padding: '0 24px', fontSize: 15 }}
            onClick={onRun}
          >
            Run
            <svg
              viewBox="0 0 16 16"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              style={{ width: 14, height: 14 }}
              aria-hidden="true"
            >
              <path d="M5 3l6 5-6 5V3z" fill="currentColor" />
            </svg>
          </button>
          <button type="button" className="btn-ghost" onClick={onReset}>
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}

