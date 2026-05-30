/**
 * InlineEditField.tsx
 * Click-to-edit text field. Saves on Enter/blur, cancels on Escape.
 */

import React, { useState, useRef, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../../utils';

interface InlineEditFieldProps {
  value: string;
  onSave: (value: string) => Promise<void>;
  onError?: (error: Error) => void;
  validate?: (value: string) => string | null;
  className?: string;
  inputClassName?: string;
  placeholder?: string;
}

export const InlineEditField: React.FC<InlineEditFieldProps> = ({
  value,
  onSave,
  onError,
  validate,
  className = '',
  inputClassName = '',
  placeholder,
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commit = async () => {
    const trimmed = draft.trim();
    if (trimmed === value) {
      setEditing(false);
      setError(null);
      return;
    }
    if (validate) {
      const err = validate(trimmed);
      if (err) {
        setError(err);
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmed);
      setEditing(false);
    } catch (e) {
      setEditing(false);
      setDraft(value);
      const err = e instanceof Error ? e : new Error('Save failed');
      onError?.(err);
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    setDraft(value);
    setError(null);
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };

  const handleBlur = () => {
    commit();
  };

  if (editing) {
    return (
      <div className="relative inline-flex items-center gap-1.5">
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          disabled={saving}
          placeholder={placeholder}
          className={cn(
            'bg-slate-900 border rounded px-1.5 py-0.5 text-sm outline-none transition-colors',
            'focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/30',
            error ? 'border-red-500' : 'border-slate-600',
            inputClassName
          )}
        />
        {saving && <Loader2 className="w-3 h-3 animate-spin text-cyan-400" />}
        {error && (
          <span className="absolute left-0 top-full mt-0.5 text-[10px] text-red-400 whitespace-nowrap z-10">
            {error}
          </span>
        )}
      </div>
    );
  }

  return (
    <span
      onClick={() => {
        setDraft(value);
        setError(null);
        setEditing(true);
      }}
      className={cn(
        'cursor-pointer hover:bg-slate-700/50 rounded px-1 -mx-1 transition-colors',
        className
      )}
      title="Click to edit"
    >
      {value || placeholder ? (
        value || placeholder
      ) : (
        <span className="text-slate-500 italic">Empty</span>
      )}
    </span>
  );
};
