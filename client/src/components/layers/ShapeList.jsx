import { useState, useCallback, useMemo } from 'react';
import { getShapeAccounts, addPoint } from '../../api/routing';
import useStore from '../../store';
import EyeIcon from '../ui/EyeIcon';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';
import { isRouteCompleted } from '../../utils/route';

/** Shape regions list with lazy-loaded accounts + per-shape map visibility toggle */
export default function ShapeList({ shapes = [] }) {
  const [expanded, setExpanded] = useState(null);
  const [accounts, setAccounts] = useState({});
  const [loading, setLoading] = useState(null);
  const [addingId, setAddingId] = useState(null);
  const hiddenShapeIds = useStore((s) => s.hiddenShapeIds);
  const toggleShapeVisibility = useStore((s) => s.toggleShapeVisibility);
  const setShapeAccountLayer = useStore((s) => s.setShapeAccountLayer);
  const shapeAccountLayers = useStore((s) => s.shapeAccountLayers);
  const routeId = useStore((s) => s.routeId);
  const route = useStore((s) => s.route);
  const refreshRoutes = useStore((s) => s.refreshRoutes);

  /** Account Ids already on the selected route — omitted from the list. */
  const onRouteIds = useMemo(() => {
    const stops = route?.Routes__r?.records ?? route?.Routes__r ?? [];
    const ids = new Set();
    stops.forEach((s) => {
      const id = s.AccountId__c || s.Account__c;
      if (id) ids.add(id);
    });
    return ids;
  }, [route]);

  const toggle = useCallback(async (shape) => {
    const id = shape.Id;
    if (expanded === id) { setExpanded(null); return; }
    setExpanded(id);
    if (!accounts[id]) {
      setLoading(id);
      try {
        const data = await getShapeAccounts({ shapeId: id, shapeName: shape.Name || '' });
        setAccounts((prev) => ({ ...prev, [id]: Array.isArray(data) ? data : data.accounts ?? [] }));
      } catch { /* ignore */ }
      setLoading(null);
    }
  }, [expanded, accounts]);

  /** Adds an account from the shape list to the current route. */
  const handleAdd = useCallback(async (account) => {
    if (!routeId) {
      toast.info('Select a route first');
      return;
    }
    if (isRouteCompleted(route)) {
      toast.info('Route is completed — stops cannot be added');
      return;
    }
    setAddingId(account.Id);
    try {
      await addPoint({ accountId: account.Id, routeId, ticketType: '' });
      await refreshRoutes();
      toast.success(`Added ${account.Name || 'account'} to route`);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setAddingId(null);
    }
  }, [routeId, route, refreshRoutes]);

  /** Shows/hides this shape's account markers on the map (same as polygon menu). */
  const toggleMapAccounts = useCallback((shape) => {
    const current = shapeAccountLayers[shape.Id]?.visible;
    setShapeAccountLayer(shape.Id, { visible: !current, shape });
  }, [shapeAccountLayers, setShapeAccountLayer]);

  if (!shapes.length) {
    return <div className="text-txt-secondary text-sm text-center py-8">No shapes</div>;
  }

  return (
    <div className="divide-y divide-border">
      {shapes.map((sh, i) => {
        const open = expanded === sh.Id;
        const visible = !hiddenShapeIds[sh.Id];
        const accountsOnMap = !!shapeAccountLayers[sh.Id]?.visible;
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
            {open && (
              <div className="ml-7 mb-1">
                <button
                  type="button"
                  className="text-[11px] font-semibold text-primary hover:underline"
                  onClick={() => toggleMapAccounts(sh)}
                >
                  {accountsOnMap ? 'Hide accounts on map' : 'Show accounts on map'}
                </button>
              </div>
            )}
            {open && loading === sh.Id && (
              <div className="ml-7 py-1 text-xs text-txt-secondary animate-pulse">Loading…</div>
            )}
            {open && (accounts[sh.Id] ?? []).filter((a) => !onRouteIds.has(a.Id)).map((a, ai) => (
              <div key={a.Id ?? ai} className="ml-7 py-1 flex items-center gap-2 text-xs text-txt">
                <span className="flex-1 min-w-0 truncate">{a.Name ?? a.AccountName ?? '—'}</span>
                <button
                  type="button"
                  className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                  disabled={!routeId || addingId === a.Id}
                  onClick={() => handleAdd(a)}
                  title={routeId ? 'Add to current route' : 'Select a route first'}
                >
                  {addingId === a.Id ? '…' : 'Add'}
                </button>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
