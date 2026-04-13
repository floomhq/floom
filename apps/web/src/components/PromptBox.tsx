import { useState, useRef, useEffect } from 'react';

interface Props {
  placeholder?: string;
  autoFocus?: boolean;
  onSubmit: (value: string) => void;
  size?: 'lg' | 'sm';
  disabled?: boolean;
  value?: string;
  onChange?: (v: string) => void;
}

export function PromptBox({
  placeholder = 'Try: find me cheap flights from Berlin to Lisbon next week',
  autoFocus = false,
  onSubmit,
  size = 'lg',
  disabled = false,
  value: controlledValue,
  onChange: controlledOnChange,
}: Props) {
  const [internalValue, setInternalValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const value = controlledValue ?? internalValue;
  const setValue = (v: string) => {
    if (controlledOnChange) controlledOnChange(v);
    else setInternalValue(v);
  };

  useEffect(() => {
    if (autoFocus && ref.current) ref.current.focus();
  }, [autoFocus]);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSubmit(trimmed);
    if (!controlledValue) setInternalValue('');
  };

  return (
    <div className={`prompt-box-wrap ${disabled ? 'prompt-disabled' : ''}`}>
      <textarea
        ref={ref}
        className={`prompt-box ${size === 'sm' ? 'prompt-box-sm' : ''}`}
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
          }
        }}
        aria-label="What do you want to do?"
      />
      <button
        type="button"
        className="prompt-box-run"
        aria-label="Run"
        onClick={handleSubmit}
        disabled={disabled}
      >
        Run
        <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path
            d="M3 8h10M9 4l4 4-4 4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );
}
