import { useState, useCallback } from 'react';
import { getShapeAccounts } from '../../api/routing';
import useStore from '../../store';
import EyeIcon from '../ui/EyeIcon';

/** Shape regions list with lazy-loaded accounts + per-shape map visibility toggle */
export default function ShapeList({ shapes = [] }) {
  const [expanded, setExpanded] = useState(null);
  const [accounts, setAccounts] = useState({});
  const [loading, setLoading] = useState(null);
  const hiddenShapeIds = useStore((s) => s.hiddenShapeIds);
  const toggleShapeVisibility = useStore((s) => s.toggleShapeVisibility);

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
        const visible = !hiddenShapeIds[sh.Id];
        return (
          <div key={sh.Id ?? i} className="py-2">
            <div className={`flex items-center gap-1.5 w-full px-1 py-1 ${visible ? '' : 'opacity-60'}`}>
              {/* Eye toggle — shows/hides this shape polygon on the map */}
              <button
                type="button"
                className={`w-6 h-6 flex items-center justify-center rounded-md shrink-0 transition ${
                  visible ? 'text-primary hover:bg-primary/10' : 'text-txt-secondary hover:bg-bg'
                }`}
                onClick={(e) => { e.stopPropagation(); if (sh.Id) toggleShapeVisibility(sh.Id); }}
                title={visible ? `Hide ${sh.Name ?? 'shape'} on map` : `Show ${sh.Name ?? 'shape'} on map`}
              >
                <EyeIcon open={visible} className="w-4 h-4" />
              </button>
              <button
                className="flex items-center gap-2 flex-1 min-w-0 text-left rounded hover:bg-bg transition py-1"
                onClick={() => toggle(sh)}
              >
                <div className="w-3 h-3 rounded-sm shrink-0" style={{ background: sh.Color__c || '#2563eb' }} />
                <span className="flex-1 font-medium text-[13px] text-txt truncate">{sh.Name ?? `Shape ${i + 1}`}</span>
                <span className="text-txt-secondary text-[10px] transition-transform duration-200 shrink-0" style={{ transform: open ? 'rotate(90deg)' : 'rotate(0)' }}>
                  ▶
                </span>
              </button>
            </div>
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
