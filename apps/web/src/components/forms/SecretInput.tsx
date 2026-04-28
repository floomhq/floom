import {
  forwardRef,
  useState,
  type CSSProperties,
  type InputHTMLAttributes,
} from 'react';
import { Eye, EyeOff } from 'lucide-react';

export type SecretInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

/**
 * Password-style input with an optional reveal toggle. Used for BYOK keys,
 * bearer tokens, client secrets, and other credentials.
 */
export const SecretInput = forwardRef<HTMLInputElement, SecretInputProps>(
  function SecretInput(
    {
      className: inputClassName,
      style,
      autoComplete = 'off',
      spellCheck = false,
      ...rest
    },
    ref,
  ) {
    const [revealed, setRevealed] = useState(false);

    const mergedStyle: CSSProperties | undefined =
      inputClassName === 'input-field'
        ? style
        : { boxSizing: 'border-box', ...style, paddingRight: 40 };

    return (
      <div className="input-with-icon" style={{ width: '100%' }}>
        <input
          ref={ref}
          {...rest}
          className={inputClassName}
          style={mergedStyle}
          type={revealed ? 'text' : 'password'}
          autoComplete={autoComplete}
          spellCheck={spellCheck}
        />
        <button
          type="button"
          onClick={() => setRevealed((v) => !v)}
          aria-label={revealed ? 'Hide secret' : 'Show secret'}
          aria-pressed={revealed}
          tabIndex={0}
          style={{
            position: 'absolute',
            right: 2,
            top: '50%',
            transform: 'translateY(-50%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 34,
            height: 34,
            padding: 0,
            border: 'none',
            borderRadius: 6,
            background: 'transparent',
            color: 'var(--muted)',
            cursor: 'pointer',
          }}
        >
          {revealed ? (
            <EyeOff size={18} strokeWidth={1.75} />
          ) : (
            <Eye size={18} strokeWidth={1.75} />
          )}
        </button>
      </div>
    );
  },
);

SecretInput.displayName = 'SecretInput';
