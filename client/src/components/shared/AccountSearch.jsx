import { useState, useRef, useCallback, useEffect } from 'react';
import { searchAccounts } from '../../api/routing';

/** Account search input with 300ms debounced autocomplete */
export default function AccountSearch({ onSelect, placeholder = 'Search accounts…' }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const timer = useRef(null);

  const handleChange = useCallback((e) => {
    const val = e.target.value;
    setQuery(val);
    clearTimeout(timer.current);
    if (val.length < 2) { setResults([]); setOpen(false); return; }
    timer.current = setTimeout(async () => {
      try {
        const data = await searchAccounts({ q: val });
        setResults(data.accounts ?? data);
        setOpen(true);
      } catch { setResults([]); }
    }, 300);
  }, []);

  const handleSelect = useCallback((account) => {
    setQuery(account.Name ?? '');
    setOpen(false);
    onSelect?.(account);
  }, [onSelect]);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <div className="relative">
      <input
        className="input-field w-full"
        value={query}
        onChange={handleChange}
        placeholder={placeholder}
        onFocus={() => results.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && results.length > 0 && (
        <div className="absolute top-9 left-0 right-0 bg-surface border border-border rounded-lg shadow-lg max-h-52 overflow-y-auto z-50 divide-y divide-border">
          {results.map((a, i) => (
            <button
              key={a.Id ?? i}
              className="w-full text-left px-3 py-2 text-sm hover:bg-primary-light/50 transition"
              onMouseDown={() => handleSelect(a)}
            >
              <div className="font-medium text-txt">{a.Name}</div>
              {a.Address && <div className="text-[11px] text-txt-secondary">{a.Address}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
