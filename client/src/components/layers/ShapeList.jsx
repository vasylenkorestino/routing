import { useState, useCallback } from 'react';
import { getShapeAccounts } from '../../api/routing';

/** Shape regions list with lazy-loaded accounts */
export default function ShapeList({ shapes = [] }) {
  const [expanded, setExpanded] = useState(null);
  const [accounts, setAccounts] = useState({});
  const [loading, setLoading] = useState(null);

  const toggle = useCallback(async (shape) => {
    const id = shape.Id;
    if (expanded === id) { setExpanded(null); return; }
    setExpanded(id);
    if (!accounts[id]) {
      setLoading(id);
      try {
        const data = await getShapeAccounts({ shapeId: id });
        setAccounts((prev) => ({ ...prev, [id]: data.accounts ?? data }));
      } catch { /* ignore */ }
      setLoading(null);
    }
  }, [expanded, accounts]);

  if (!shapes.length) {
    return <div className="text-txt-secondary text-sm text-center py-8">No shapes</div>;
  }

  return (
    <div className="divide-y divide-border">
      {shapes.map((sh, i) => {
        const open = expanded === sh.Id;
        return (
          <div key={sh.Id ?? i} className="py-2">
            <button
              className="flex items-center gap-2 w-full text-left px-1 py-1 rounded hover:bg-bg transition"
              onClick={() => toggle(sh)}
            >
              <div className="w-3 h-3 rounded-sm shrink-0" style={{ background: sh.Color__c || '#2563eb' }} />
              <span className="flex-1 font-medium text-[13px] text-txt">{sh.Name ?? `Shape ${i + 1}`}</span>
              <span className="text-txt-secondary text-[10px] transition-transform duration-200" style={{ transform: open ? 'rotate(90deg)' : 'rotate(0)' }}>
                ▶
              </span>
            </button>
            {open && loading === sh.Id && (
              <div className="ml-5 py-1 text-xs text-txt-secondary animate-pulse">Loading…</div>
            )}
            {open && (accounts[sh.Id] ?? []).map((a, ai) => (
              <div key={a.Id ?? ai} className="ml-5 py-1 text-xs text-txt">
                {a.Name ?? a.AccountName ?? '—'}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
