interface Props {
  isSignedIn?: boolean;
  onSignIn?: () => void;
  onBrowsePublic?: () => void;
}

export function MyAppsResponse({ isSignedIn = false, onSignIn, onBrowsePublic }: Props) {
  if (isSignedIn) {
    return (
      <div className="assistant-turn">
        <p className="assistant-preamble">
          Your saved and deployed apps will appear here once you've run some.
        </p>
      </div>
    );
  }
  return (
    <div className="assistant-turn">
      <div className="app-expanded-card">
        <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6 }}>
          You don't have any apps yet.{' '}
          <button
            type="button"
            onClick={onSignIn}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--accent)',
              fontWeight: 600,
              cursor: 'pointer',
              padding: 0,
              fontFamily: 'inherit',
              fontSize: 'inherit',
            }}
          >
            Sign in with GitHub
          </button>{' '}
          to see your saved and deployed apps. Or{' '}
          <button
            type="button"
            onClick={onBrowsePublic}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--accent)',
              cursor: 'pointer',
              padding: 0,
              fontFamily: 'inherit',
              fontSize: 'inherit',
            }}
          >
            browse public apps
          </button>
          .
        </p>
      </div>
    </div>
  );
}
