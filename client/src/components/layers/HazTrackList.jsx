import { useMemo, useState } from 'react';
import useStore from '../../store';
import {
  HAZTRACK_STATUS_COLORS,
  volumePercent,
  tankCoords,
  tankTitle,
} from '../../utils/haztrack';

/**
 * Searchable HazTrack tank list for the map overlay panel.
 * Row click focuses the tank on the map and opens the detail panel.
 */
export default function HazTrackList({ tanks = [] }) {
  const [query, setQuery] = useState('');
  const selectedHazTrackId = useStore((s) => s.selectedHazTrackId);
  const selectHazTrack = useStore((s) => s.selectHazTrack);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tanks;
    return tanks.filter((t) => {
      const hay = [
        t.Name, t.AccountName, t.LevelStatus,
        t.ShippingStreet, t.ShippingCity, t.ShippingState,
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [tanks, query]);

  return (
    <div className="flex flex-col gap-2">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search tanks..."
        className="w-full px-2.5 py-1.5 text-xs rounded-md border border-border bg-surface text-txt placeholder:text-txt-secondary focus:outline-none focus:ring-1 focus:ring-primary"
      />
      <div className="text-[11px] text-txt-secondary px-0.5">
        {filtered.length} of {tanks.length} tanks
      </div>
      <ul className="space-y-0.5">
        {filtered.map((tank) => {
          const status = tank.LevelStatus || 'Issue';
          const color = HAZTRACK_STATUS_COLORS[status] || HAZTRACK_STATUS_COLORS.Issue;
          const pct = volumePercent(tank);
          const active = selectedHazTrackId === tank.Id;
          const hasLoc = !!tankCoords(tank);
          return (
            <li key={tank.Id}>
              <button
                type="button"
                onClick={() => selectHazTrack(tank)}
                className={`w-full text-left flex items-start gap-2 px-2 py-1.5 rounded-md transition ${
                  active ? 'bg-primary/10 ring-1 ring-primary/40' : 'hover:bg-bg'
                } ${hasLoc ? '' : 'opacity-60'}`}
                title={hasLoc ? tankTitle(tank) : `${tankTitle(tank)} (no location)`}
              >
                <span
                  className="w-2.5 h-2.5 rounded-full mt-1 shrink-0 border border-white shadow-sm"
                  style={{ background: color }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] font-medium text-txt truncate">{tankTitle(tank)}</span>
                  <span className="block text-[10px] text-txt-secondary">
                    Volume (%): {pct != null ? `${Math.round(pct)}%` : '—'}
                    {!hasLoc ? ' · no location' : ''}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
        {filtered.length === 0 && (
          <li className="text-xs text-txt-secondary text-center py-6">No tanks match</li>
        )}
      </ul>
    </div>
  );
}
