// W4-minimal: reviews section for /p/:slug.
//
// Renders the review summary (5-star avg + count) and the two most-recent
// reviews. A "Leave a review" button opens a modal with a 5-star picker +
// title + body textarea. Logged-out users see a "Sign in to review" hint.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import * as api from '../api/client';
import { useSession } from '../hooks/useSession';
import type { Review, ReviewSummary } from '../lib/types';

export function AppReviews({ slug }: { slug: string }) {
  const { data: session } = useSession();
  const [summary, setSummary] = useState<ReviewSummary | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [modal, setModal] = useState(false);

  async function load() {
    try {
      const res = await api.getAppReviews(slug, 20);
      // Hide QA fixture reviews ("QA Creator B", "QA User A p3", "B review", etc.)
      // from the public product page. See 2026-04-18 consumer UX audit finding #2.
      const isFixture = (r: Review) =>
        /^(QA\s|B review$)/.test(r.author_name) ||
        /^(QA test|B thinks it is ok|Updated review content)/.test(r.title ?? '') ||
        /^(QA test|B thinks it is ok|Updated review content)/.test(r.body ?? '');
      const clean = res.reviews.filter((r) => !isFixture(r));
      const cleanCount = clean.length;
      const cleanAvg = cleanCount === 0 ? 0 : clean.reduce((s, r) => s + r.rating, 0) / cleanCount;
      setSummary({ count: cleanCount, avg: cleanAvg });
      setReviews(clean);
    } catch {
      // render empty state
      setSummary({ count: 0, avg: 0 });
      setReviews([]);
    }
  }

  useEffect(() => {
    void load();
  }, [slug]);

  const canReview = session !== null && !session.user.is_local;
  const localMode = session?.cloud_mode === false;

  return (
    <section
      data-testid="app-reviews"
      style={{
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        padding: '20px 24px',
        marginTop: 24,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 16,
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--ink)' }}>
            Reviews
          </h2>
          {summary && summary.count > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <Stars value={summary.avg} />
              <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                {summary.avg.toFixed(1)} · {summary.count}{' '}
                review{summary.count === 1 ? '' : 's'}
              </span>
            </div>
          )}
        </div>
        {canReview || localMode ? (
          <button
            type="button"
            onClick={() => setModal(true)}
            data-testid="reviews-leave"
            style={{
              padding: '8px 14px',
              background: 'var(--ink)',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Leave a review
          </button>
        ) : (
          <Link
            to="/login"
            data-testid="reviews-sign-in"
            style={{
              padding: '8px 14px',
              background: 'var(--bg)',
              color: 'var(--muted)',
              border: '1px solid var(--line)',
              borderRadius: 8,
              fontSize: 13,
              textDecoration: 'none',
            }}
          >
            Sign in to review
          </Link>
        )}
      </div>

      {summary && summary.count === 0 ? (
        <p
          style={{
            margin: 0,
            fontSize: 13,
            color: 'var(--muted)',
            padding: '20px 0',
            textAlign: 'center',
          }}
          data-testid="reviews-empty"
        >
          No reviews yet. Be the first.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {reviews.slice(0, 2).map((r) => (
            <div
              key={r.id}
              data-testid={`review-${r.id}`}
              style={{ paddingBottom: 14, borderBottom: '1px solid var(--line)' }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  marginBottom: 6,
                }}
              >
                <Stars value={r.rating} />
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {r.author_name} · {new Date(r.created_at).toLocaleDateString()}
                </span>
              </div>
              {r.title && (
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>
                  {r.title}
                </div>
              )}
              {r.body && (
                <p
                  style={{
                    margin: 0,
                    fontSize: 13,
                    color: 'var(--muted)',
                    lineHeight: 1.55,
                  }}
                >
                  {r.body}
                </p>
              )}
            </div>
          ))}
          {reviews.length > 2 && (
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              …and {reviews.length - 2} more
            </div>
          )}
        </div>
      )}

      {modal && (
        <ReviewModal
          onClose={() => setModal(false)}
          onSaved={async () => {
            setModal(false);
            await load();
          }}
          slug={slug}
        />
      )}
    </section>
  );
}

function ReviewModal({
  slug,
  onClose,
  onSaved,
}: {
  slug: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [rating, setRating] = useState(5);
  const [hover, setHover] = useState(0);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setState('saving');
    setError(null);
    try {
      await api.postReview(slug, { rating, title: title || undefined, body: body || undefined });
      onSaved();
    } catch (err) {
      setState('error');
      setError((err as Error).message || 'Could not save review');
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid="review-modal"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={onClose}
    >
      <form
        onSubmit={save}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--card)',
          borderRadius: 12,
          padding: 24,
          maxWidth: 440,
          width: '100%',
        }}
      >
        <h3 style={{ margin: '0 0 16px', fontSize: 16, color: 'var(--ink)' }}>
          Leave a review
        </h3>
        <div
          role="radiogroup"
          aria-label="rating"
          style={{
            display: 'flex',
            gap: 4,
            marginBottom: 16,
          }}
        >
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              type="button"
              key={n}
              onMouseEnter={() => setHover(n)}
              onMouseLeave={() => setHover(0)}
              onClick={() => setRating(n)}
              aria-label={`${n} star${n === 1 ? '' : 's'}`}
              aria-checked={rating === n}
              role="radio"
              data-testid={`star-${n}`}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 2,
                color: (hover || rating) >= n ? '#f2b100' : 'var(--line)',
              }}
            >
              <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z" />
              </svg>
            </button>
          ))}
        </div>

        <Label>Title (optional)</Label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          data-testid="review-title"
          style={inputStyle}
        />

        <Label>Review (optional)</Label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          data-testid="review-body"
          style={{ ...inputStyle, resize: 'vertical' }}
        />

        {error && (
          <p
            style={{
              margin: '12px 0 0',
              fontSize: 13,
              color: '#c2321f',
            }}
          >
            {error}
          </p>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '8px 16px',
              background: 'transparent',
              border: '1px solid var(--line)',
              borderRadius: 8,
              fontSize: 13,
              color: 'var(--muted)',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={state === 'saving'}
            data-testid="review-submit"
            style={{
              padding: '8px 16px',
              background: 'var(--ink)',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
              opacity: state === 'saving' ? 0.6 : 1,
            }}
          >
            {state === 'saving' ? 'Saving...' : 'Post review'}
          </button>
        </div>
      </form>
    </div>
  );
}

function Stars({ value }: { value: number }) {
  const filled = Math.round(value);
  return (
    <span aria-label={`${value.toFixed(1)} out of 5 stars`} style={{ display: 'inline-flex', gap: 2 }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <svg
          key={n}
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill={n <= filled ? '#f2b100' : 'var(--line)'}
          aria-hidden="true"
        >
          <path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z" />
        </svg>
      ))}
    </span>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label
      style={{
        display: 'block',
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--muted)',
        marginBottom: 6,
        marginTop: 10,
      }}
    >
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  border: '1px solid var(--line)',
  borderRadius: 8,
  background: 'var(--card)',
  fontSize: 14,
  color: 'var(--ink)',
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};
