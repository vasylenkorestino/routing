import { useState, useRef, useEffect, useCallback } from 'react';

/**
 * Custom dropdown select with search support.
 * `onOpen` fires each time the menu transitions from closed to open (e.g. to
 * refresh options in the background).
 * @param {{ value, onChange, options: {value,label}[], placeholder?, searchable?, className?, onOpen? }} props
 */
export default function Select({ value, onChange, options = [], placeholder = 'Select…', searchable = false, className = '', onOpen }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef(null);
  const inputRef = useRef(null);

  const selected = options.find((o) => o.value === value);

  const filtered = searchable && search
    ? options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase()))
    : options;

  const handleSelect = useCallback((val) => {
    onChange(val);
    setOpen(false);
    setSearch('');
  }, [onChange]);

  const toggleOpen = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      if (next) onOpen?.();
      return next;
    });
  }, [onOpen]);

  useEffect(() => {
    if (!open) return;
    if (searchable) inputRef.current?.focus();
    const handleClickOutside = (e) => {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open, searchable]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e) => {
      if (e.key === 'Escape') { setOpen(false); setSearch(''); }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open]);

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        className={`h-8 w-full flex items-center gap-1.5 px-2.5 rounded-lg border text-[13px] text-left transition outline-none ${
          open
            ? 'border-primary ring-2 ring-primary-light bg-surface'
            : 'border-border bg-surface hover:border-txt-secondary/40'
        }`}
        onClick={toggleOpen}
      >
        <span className={`flex-1 truncate ${selected ? 'text-txt' : 'text-txt-secondary'}`}>
          {selected?.label ?? placeholder}
        </span>
        <svg className={`w-3.5 h-3.5 text-txt-secondary shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-full min-w-[160px] bg-surface border border-border rounded-lg shadow-lg z-50 overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150">
          {searchable && (
            <div className="p-1.5 border-b border-border">
              <input
                ref={inputRef}
                className="w-full h-7 px-2 rounded border border-border bg-bg text-txt text-xs outline-none focus:border-primary transition placeholder:text-txt-secondary/60"
                placeholder="Search…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          )}
          <div className="max-h-56 overflow-y-auto py-1">
            {filtered.length === 0 && (
              <div className="px-3 py-2 text-xs text-txt-secondary text-center">No results</div>
            )}
            {filtered.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-left transition-colors ${
                  opt.value === value
                    ? 'bg-primary-light text-primary font-medium'
                    : 'text-txt hover:bg-bg'
                }`}
                onClick={() => handleSelect(opt.value)}
              >
                {opt.value === value && (
                  <svg className="w-3.5 h-3.5 text-primary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                )}
                <span className={opt.value === value ? '' : 'ml-5.5'}>{opt.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
