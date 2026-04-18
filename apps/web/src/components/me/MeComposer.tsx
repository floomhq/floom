// v15.1 inline composer pinned to the bottom of the right thread pane.
// Submitting navigates to /me/a/<slug>/run?prompt=<text>; MeAppRunPage reads
// the prefill and hands it to <FloomApp initialInputs={{ prompt }} />.

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router-dom';

export interface MeComposerHandle {
  focus: () => void;
}

interface Props {
  targetSlug: string | null;
  targetName?: string;
}

export const MeComposer = forwardRef<MeComposerHandle, Props>(function MeComposer(
  { targetSlug, targetName },
  ref,
) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const navigate = useNavigate();
  const disabled = !targetSlug;

  useImperativeHandle(
    ref,
    () => ({
      focus: () => textareaRef.current?.focus(),
    }),
    [],
  );

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const submit = useCallback(() => {
    if (disabled || !targetSlug) return;
    const trimmed = value.trim();
    const qs = trimmed ? `?prompt=${encodeURIComponent(trimmed)}` : '';
    navigate(`/me/a/${targetSlug}/run${qs}`);
  }, [disabled, targetSlug, value, navigate]);

  return (
    <form
      data-testid="me-composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      style={{
        borderTop: '1px solid var(--line)',
        background: 'var(--card)',
        padding: '14px 20px 16px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 10,
          border: '1px solid var(--line)',
          borderRadius: 12,
          background: 'var(--bg)',
          padding: '10px 12px',
        }}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder={
            disabled
              ? 'Pick an app to start a new thread…'
              : targetName
                ? `Message ${targetName}…`
                : 'Type a message…'
          }
          disabled={disabled}
          data-testid="me-composer-textarea"
          style={{
            flex: 1,
            resize: 'none',
            border: 'none',
            outline: 'none',
            background: 'transparent',
            color: 'var(--ink)',
            fontSize: 14,
            lineHeight: 1.5,
            fontFamily: 'inherit',
            maxHeight: 200,
            minHeight: 22,
          }}
        />
        <button
          type="submit"
          disabled={disabled || !value.trim()}
          data-testid="me-composer-send"
          style={{
            padding: '8px 14px',
            borderRadius: 8,
            border: '1px solid var(--ink)',
            background: 'var(--ink)',
            color: '#fff',
            fontSize: 13,
            fontWeight: 600,
            cursor: disabled || !value.trim() ? 'not-allowed' : 'pointer',
            opacity: disabled || !value.trim() ? 0.5 : 1,
            fontFamily: 'inherit',
          }}
        >
          Send
        </button>
      </div>
      <div
        style={{
          fontSize: 11,
          color: 'var(--muted)',
          marginTop: 8,
          paddingLeft: 4,
        }}
      >
        {disabled
          ? 'Open an app first — the composer sends into that app.'
          : 'Enter to send · Shift+Enter for newline'}
      </div>
    </form>
  );
});
