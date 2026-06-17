import { useMemo, useState } from 'react';
import useStore from '../../store';
import RoutePreviewMap from './RoutePreviewMap';
import RoutesOverviewMap, { routeColor } from './RoutesOverviewMap';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';

/** Formats minutes as "Xh Ym" (or "Ym"). */
function fmtDuration(min) {
  if (min == null) return '—';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Triggers a client-side file download. */
function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function routesToCsv(routes) {
  const headers = ['Route Name', 'Date', 'Record Type', 'Direction', 'Stops', 'Distance (mi)', 'Drive Time (min)', 'Service Time (min)', 'Total Duration (min)', 'Gallons', 'Optimization Score'];
  const rows = routes.map((r) => [
    r.routeName, r.serviceDate, r.recordType || '', r.direction, r.totalStops,
    r.totalDistanceMi, r.driveTimeMin, r.serviceTimeMin, r.totalDurationMin, r.totalGallons,
    r.optimizationScore != null ? `${r.optimizationScore}%` : '',
  ]);
  return [headers, ...rows].map((row) => row.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
}

/** Full-screen review of generated routes with map previews and commit actions. */
export default function GeneratedRoutesReview() {
  const result = useStore((s) => s.genResult);
  const summary = result?.summary;
  const routes = useMemo(() => result?.routes || [], [result]);
  const committing = useStore((s) => s.genCommitting);
  const close = useStore((s) => s.closeGenReview);
  const commit = useStore((s) => s.commitGeneratedRoutes);
  const refreshAfterAiCreate = useStore((s) => s.refreshAfterAiCreate);
  const regenerate = useStore((s) => s.regenerateRoutes);
  const combine = useStore((s) => s.combineGeneratedRoutes);
  const split = useStore((s) => s.splitGeneratedRoute);

  const [selectedId, setSelectedId] = useState(routes[0]?.id ?? null);
  const [checked, setChecked] = useState(() => new Set(routes.map((r) => r.id)));
  const [mapView, setMapView] = useState('overview'); // 'overview' | 'single'

  const selectedRoute = useMemo(() => routes.find((r) => r.id === selectedId) || routes[0] || null, [routes, selectedId]);
  const checkedRoutes = useMemo(() => routes.filter((r) => checked.has(r.id)), [routes, checked]);
  const allChecked = routes.length > 0 && checked.size === routes.length;

  const toggleCheck = (id) => setChecked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const toggleAll = () => setChecked(allChecked ? new Set() : new Set(routes.map((r) => r.id)));

  const doCommit = async (ids) => {
    try {
      const res = await commit(ids);
      if (res?.success) {
        toast.success(`Created ${res.created} route(s), ${res.totalStops} stop(s)`);
        if (res.skipped?.length) toast.error(`${res.skipped.length} route(s) skipped (already routed)`);
        close();
        if (res.googleRoutes?.length) {
          await refreshAfterAiCreate(res.googleRoutes);
        }
      }
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  const doRegenerate = async () => {
    try {
      await regenerate();
      close();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  const doCombine = () => {
    const mergedId = combine([...checked]);
    if (mergedId) {
      setChecked(new Set([mergedId]));
      setSelectedId(mergedId);
      toast.success('Routes combined');
    }
  };

  const doSplit = (id) => {
    const firstId = split(id);
    if (firstId) {
      setChecked((prev) => { const next = new Set(prev); next.delete(id); return next; });
      setSelectedId(firstId);
      toast.success('Route split into two');
    }
  };

  return (
    <div className="fixed inset-0 z-[1100] bg-surface flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-4 px-5 py-3 border-b border-border bg-bg/50 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-ai">✦</span>
          <h2 className="text-base font-semibold text-txt">Generated Routes</h2>
        </div>
        {summary && (
          <div className="flex items-center gap-4 text-[12px] text-txt-secondary">
            <span>{summary.date}</span>
            <span>·</span>
            <span>{summary.recordType || 'All record types'}</span>
            <span>·</span>
            <span className="text-txt font-medium">{routes.length} routes</span>
            <span>·</span>
            <span>{summary.totalStops} stops</span>
            <span>·</span>
            <span>{summary.totalDistanceMi} mi</span>
            <span>·</span>
            <span>{fmtDuration(summary.totalDurationMin)}</span>
          </div>
        )}
        <div className="flex-1" />
        <button onClick={close} className="text-txt-secondary hover:text-txt transition p-1.5 rounded" title="Close">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Action bar */}
      <div className="flex items-center gap-2 px-5 py-2.5 border-b border-border shrink-0 flex-wrap">
        <button
          className="h-8 px-3 rounded-lg bg-ai text-white text-[13px] font-medium hover:bg-ai-hover transition disabled:opacity-50"
          disabled={committing || routes.length === 0}
          onClick={() => doCommit(null)}
        >
          Create All Routes
        </button>
        <button
          className="h-8 px-3 rounded-lg bg-primary text-white text-[13px] font-medium hover:bg-primary-hover transition disabled:opacity-50"
          disabled={committing || checked.size === 0}
          onClick={() => doCommit([...checked])}
        >
          Create Selected ({checked.size})
        </button>
        <button
          className="h-8 px-3 rounded-lg border border-border text-txt text-[13px] font-medium hover:bg-bg transition disabled:opacity-50"
          disabled={committing || checked.size < 2}
          onClick={doCombine}
          title="Merge the selected routes into one"
        >
          Combine Selected ({checked.size})
        </button>
        <button
          className="h-8 px-3 rounded-lg border border-border text-txt text-[13px] font-medium hover:bg-bg transition disabled:opacity-50"
          disabled={committing || !selectedRoute || selectedRoute.totalStops < 2}
          onClick={() => selectedRoute && doSplit(selectedRoute.id)}
          title="Split the selected route into two"
        >
          Split Selected
        </button>
        <button
          className="h-8 px-3 rounded-lg border border-border text-txt text-[13px] font-medium hover:bg-bg transition disabled:opacity-50"
          disabled={committing}
          onClick={doRegenerate}
        >
          Regenerate
        </button>
        <div className="flex-1" />
        <button
          className="h-8 px-3 rounded-lg border border-border text-txt-secondary text-[13px] font-medium hover:bg-bg transition"
          onClick={() => download(`generated-routes-${summary?.date || 'preview'}.json`, JSON.stringify(result, null, 2), 'application/json')}
        >
          Download JSON
        </button>
        <button
          className="h-8 px-3 rounded-lg border border-border text-txt-secondary text-[13px] font-medium hover:bg-bg transition"
          onClick={() => download(`generated-routes-${summary?.date || 'preview'}.csv`, routesToCsv(routes), 'text/csv')}
        >
          Download CSV
        </button>
        {committing && <span className="text-[12px] text-ai animate-pulse">Creating…</span>}
      </div>

      {routes.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-txt-secondary text-sm">
          No routes were generated. {result?.warnings?.[0]}
        </div>
      ) : (
        <div className="flex-1 flex min-h-0">
          {/* Route list */}
          <div className="w-[420px] shrink-0 border-r border-border flex flex-col min-h-0">
            <label className="flex items-center gap-2.5 px-3 py-2 border-b border-border bg-bg/40 shrink-0 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={allChecked}
                ref={(el) => { if (el) el.indeterminate = checked.size > 0 && !allChecked; }}
                onChange={toggleAll}
              />
              <span className="text-[12px] font-medium text-txt">{allChecked ? 'Deselect all' : 'Select all'}</span>
              <span className="text-[11px] text-txt-secondary">· {checked.size}/{routes.length} selected</span>
            </label>
            <div className="flex-1 overflow-auto">
              {routes.map((r, i) => (
                <RouteListItem
                  key={r.id}
                  route={r}
                  color={mapView === 'overview' && checked.has(r.id) ? routeColor(checkedRoutes.findIndex((c) => c.id === r.id)) : null}
                  active={r.id === selectedRoute?.id}
                  checked={checked.has(r.id)}
                  onToggle={() => toggleCheck(r.id)}
                  onSelect={() => setSelectedId(r.id)}
                />
              ))}
            </div>
          </div>

          {/* Detail + map */}
          <div className="flex-1 flex flex-col min-h-0">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
              <div className="inline-flex rounded-lg border border-border overflow-hidden">
                <button
                  className={`h-7 px-3 text-[12px] font-medium transition border-none ${mapView === 'overview' ? 'bg-ai text-white' : 'bg-surface text-txt-secondary hover:bg-bg'}`}
                  onClick={() => setMapView('overview')}
                >
                  All selected ({checked.size})
                </button>
                <button
                  className={`h-7 px-3 text-[12px] font-medium transition border-none ${mapView === 'single' ? 'bg-ai text-white' : 'bg-surface text-txt-secondary hover:bg-bg'}`}
                  onClick={() => setMapView('single')}
                >
                  Single route
                </button>
              </div>
              <span className="text-[11px] text-txt-secondary truncate">
                {mapView === 'overview' ? 'All selected routes on the map' : selectedRoute?.routeName}
              </span>
            </div>

            <div className="h-[45%] min-h-[220px] border-b border-border">
              {mapView === 'overview'
                ? <RoutesOverviewMap routes={checkedRoutes} />
                : selectedRoute && <RoutePreviewMap route={selectedRoute} />}
            </div>
            <div className="flex-1 overflow-auto p-4">
              {selectedRoute && <RouteDetail route={selectedRoute} />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RouteListItem({ route, active, checked, color, onToggle, onSelect }) {
  return (
    <div className={`border-b border-border/60 transition ${active ? 'bg-bg/70' : 'hover:bg-bg/40'}`}>
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <input type="checkbox" className="mt-1" checked={checked} onChange={onToggle} onClick={(e) => e.stopPropagation()} />
        <button className="flex-1 text-left" onClick={onSelect}>
          <div className="flex items-center gap-2">
            {color && <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />}
            <span className="text-[13px] font-medium text-txt truncate">{route.routeName}</span>
            {route.optimizationScore != null && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700">{route.optimizationScore}%</span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-txt-secondary">
            <span>{route.direction}</span>
            <span>· {route.totalStops} stops</span>
            <span>· {route.totalDistanceMi} mi</span>
            <span>· {fmtDuration(route.totalDurationMin)}</span>
          </div>
        </button>
      </div>
    </div>
  );
}

function RouteDetail({ route }) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-txt">{route.routeName}</h3>
        <div className="text-[12px] text-txt-secondary">
          {route.direction} · {route.totalStops} stops · {route.totalDistanceMi} mi · {fmtDuration(route.totalDurationMin)}
        </div>
      </div>

      {/* Stops — account names + addresses, shown first */}
      <div>
        <div className="text-[11px] font-semibold text-txt-secondary uppercase tracking-wide mb-1.5">Stops ({route.stops.length})</div>
        <div className="border border-border/60 rounded-lg overflow-hidden">
          <table className="w-full text-[12px]">
            <thead className="bg-bg/50 text-txt-secondary">
              <tr>
                <th className="text-left px-3 py-1.5 font-medium w-8">#</th>
                <th className="text-left px-3 py-1.5 font-medium">Account</th>
                <th className="text-left px-3 py-1.5 font-medium">Address</th>
                <th className="text-right px-3 py-1.5 font-medium">Gallons</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {route.stops.map((s) => (
                <tr key={s.accountId} className="hover:bg-bg/30 align-top">
                  <td className="px-3 py-1.5 tabular-nums text-txt-secondary">{s.priority}</td>
                  <td className="px-3 py-1.5 text-txt font-medium">
                    {s.accountName || s.accountId}
                    {s.hasOpenTicket && <span className="ml-1.5 text-[9px] font-semibold px-1 py-0.5 rounded bg-amber-100 text-amber-700">TICKET</span>}
                  </td>
                  <td className="px-3 py-1.5 text-txt-secondary max-w-[320px]">{s.address || '—'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-txt-secondary">{s.estGallons}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Metric label="Date" value={route.serviceDate} />
        <Metric label="Record Type" value={route.recordType || '—'} />
        <Metric label="Region / Direction" value={route.direction} />
        <Metric label="Total Stops" value={route.totalStops} />
        <Metric label="Total Distance" value={`${route.totalDistanceMi} mi`} />
        <Metric label="Est. Drive Time" value={fmtDuration(route.driveTimeMin)} />
        <Metric label="Est. Service Time" value={fmtDuration(route.serviceTimeMin)} />
        <Metric label="Total Duration" value={fmtDuration(route.totalDurationMin)} />
        <Metric label="Est. Gallons" value={route.totalGallons} />
        <Metric label="Optimization Score" value={route.optimizationScore != null ? `${route.optimizationScore}%` : 'Manual'} />
        <Metric label="Service Location" value={route.depot?.name || '—'} />
      </div>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="rounded-lg border border-border/70 bg-bg/30 px-3 py-2">
      <div className="text-[10px] text-txt-secondary">{label}</div>
      <div className="text-[14px] font-semibold text-txt mt-0.5">{value}</div>
    </div>
  );
}
