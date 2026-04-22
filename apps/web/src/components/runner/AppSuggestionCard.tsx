import type { PickResult } from '../../lib/types';
import { AppIcon } from '../AppIcon';
import { DescriptionMarkdown } from '../DescriptionMarkdown';

interface Props {
  app: PickResult;
  alternatives?: PickResult[];
  onRun: () => void;
  onDetails: () => void;
  onPickAlternative?: (app: PickResult) => void;
}

export function AppSuggestionCard({ app, alternatives, onRun, onDetails, onPickAlternative }: Props) {
  return (
    <div className="assistant-turn">
      <p className="assistant-preamble">
        <strong>{app.name}</strong> looks like the best fit. Run it?
      </p>
      <div className="app-suggestion-card">
        <div className="app-suggestion-icon">
          <AppIcon slug={app.slug} size={22} />
        </div>
        <div className="app-suggestion-info">
          <p className="app-suggestion-name">{app.name}</p>
          <p className="app-suggestion-creator">{app.category || 'Floom app'}</p>
          {/* 2026-04-23: Fix #413 — description is markdown. */}
          {app.description && (
            <div className="app-suggestion-desc">
              <DescriptionMarkdown
                description={app.description}
                testId={`app-suggestion-desc-${app.slug}`}
                style={{ margin: 0, maxWidth: 'none', fontSize: 'inherit', color: 'inherit' }}
              />
            </div>
          )}
        </div>
        <div className="app-suggestion-action">
          <button className="btn-primary" type="button" onClick={onRun}>
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
        </div>
      </div>
      {alternatives && alternatives.length > 0 && (
        <div className="other-options" onClick={onDetails} role="button" tabIndex={0}>
          <span>
            {alternatives.length} other {alternatives.length === 1 ? 'option' : 'options'}:{' '}
            {alternatives.map((a, i) => (
              <span key={a.slug}>
                {i > 0 && ' · '}
                <strong
                  style={{ color: 'var(--accent)', cursor: onPickAlternative ? 'pointer' : 'default' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onPickAlternative?.(a);
                  }}
                >
                  {a.name}
                </strong>
              </span>
            ))}
          </span>
          <svg
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            style={{ width: 14, height: 14, color: 'var(--muted)' }}
            aria-hidden="true"
          >
            <path
              d="M4 6l4 4 4-4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      )}
    </div>
  );
}
