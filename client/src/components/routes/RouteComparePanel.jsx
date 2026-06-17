import { useState, useEffect, useCallback, useMemo } from 'react';
import useStore from '../../store';
import * as routingApi from '../../api/routing';
import Spinner from '../ui/Spinner';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';

/* ── helpers ─────────────────────────────────────────────────────────── */

/** Reads child stops whether Routes__r is an array or { records: [] }. */
function getStops(route) {
  const r = route?.Routes__r;
  if (!r) return route?.points ?? [];
  if (Array.isArray(r)) return r;
  return r.records ?? route?.points ?? [];
}

const acctId = (s) => s.AccountId__c || s.Account__c || null;

/** Normalized metrics for a route header (works for store + fetched records). */
function routeMetrics(route) {
  const stops = getStops(route);
  const distRaw = route?.Total_Distance__c;
  const distNum = parseFloat(distRaw);
  const distance = typeof distRaw === 'string' && distRaw.includes('mi')
    ? distRaw
    : (!Number.isNaN(distNum) ? `${distNum.toFixed(1)} mi` : '—');
  const gallons = stops.reduce((sum, p) => sum + (parseFloat(p.Gallons_Collected__c) || 0), 0);
  const completedStops = stops.filter((s) => s.Status__c === 'Completed' || s.Status__c === 'Complete').length;
  return {
    stops: stops.length,
    distance,
    time: route?.Total_Time__c || '—',
    gallons: gallons ? gallons.toFixed(1) : '—',
    date: route?.Service_Date__c || '—',
    driver: route?.DriverName__c || 'Unassigned',
    completed: route?.CompletionStatus__c === 'Complete' || route?.Driver_Completed__c === true,
    completion: stops.length ? `${completedStops}/${stops.length}` : '—',
  };
}

const fmtDateTime = (d) => {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return d; }
};

/* ── panel ───────────────────────────────────────────────────────────── */

/** Side-by-side route comparison shown in the right panel (map stays on the left). */
export default function RouteComparePanel() {
  const route = useStore((s) => s.route);
  const compareRoute = useStore((s) => s.compareRoute);
  const setCompareRoute = useStore((s) => s.setCompareRoute);
  const closeCompare = useStore((s) => s.closeCompare);

  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [filterName, setFilterName] = useState(route?.Name || '');
  const [searchText, setSearchText] = useState('');
  const [date, setDate] = useState('');

  const fetchRoutes = useCallback(async (params) => {
    setLoading(true);
    try {
      const data = await routingApi.getCompareRoutes({ excludeId: route?.Id, ...params });
      setList(Array.isArray(data) ? data : []);
    } catch (err) {
      toast.error(getErrorMessage(err));
      setList([]);
    } finally {
      setLoading(false);
    }
  }, [route?.Id]);

  // Default: completed routes with the same name, newest first.
  useEffect(() => { fetchRoutes({ routeName: route?.Name }); }, [fetchRoutes, route?.Name]);

  // Clear the map overlay when leaving compare mode.
  useEffect(() => () => setCompareRoute(null), [setCompareRoute]);

  const runSearch = () => fetchRoutes({
    routeName: filterName || undefined,
    search: searchText || undefined,
    date: date || undefined,
  });

  const resetSearch = () => {
    setFilterName(route?.Name || '');
    setSearchText('');
    setDate('');
    fetchRoutes({ routeName: route?.Name });
  };

  const current = useMemo(() => (route ? routeMetrics(route) : null), [route]);
  const compare = useMemo(() => (compareRoute ? routeMetrics(compareRoute) : null), [compareRoute]);

  const diff = useMemo(() => {
    if (!route || !compareRoute) return null;
    const curStops = getStops(route);
    const selStops = getStops(compareRoute);
    const curIds = new Set(curStops.map(acctId).filter(Boolean));
    const selIds = new Set(selStops.map(acctId).filter(Boolean));
    const nameOf = (s) => s.Account_Name__c || s.Name || acctId(s);
    return {
      both: curStops.filter((s) => selIds.has(acctId(s))).map(nameOf),
      onlyCurrent: curStops.filter((s) => !selIds.has(acctId(s))).map(nameOf),
      onlySelected: selStops.filter((s) => !curIds.has(acctId(s))).map(nameOf),
    };
  }, [route, compareRoute]);

  const currentColor = route?._color ?? '#2563eb';
  const compareColor = compareRoute?._color ?? '#db2777';
  const selectedId = compareRoute?.Id ?? compareRoute?.id ?? null;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border shrink-0 bg-surface">
        <div className="flex items-center gap-2 min-w-0">
          <svg className="w-4 h-4 text-txt-secondary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4M16 17H4m0 0l4 4m-4-4l4-4" />
          </svg>
          <h3 className="text-[14px] font-semibold text-txt shrink-0">Compare With</h3>
          <span className="text-[11px] text-txt-secondary bg-bg px-2 py-0.5 rounded truncate">{route?.Name}</span>
        </div>
        <button
          onClick={closeCompare}
          className="h-7 px-3 rounded-lg border border-border text-txt text-[11px] font-medium hover:bg-bg transition shrink-0"
        >
          Close
        </button>
      </div>

      <div className="flex-1 overflow-auto p-3 flex flex-col gap-3">
        {/* Candidate selector */}
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-border">
            <button
              className="flex items-center gap-1.5 text-[11px] font-medium text-txt-secondary hover:text-txt transition"
              onClick={() => setAdvancedOpen((o) => !o)}
            >
              <svg className={`w-3 h-3 transition-transform ${advancedOpen ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
              </svg>
              Search options
            </button>

            {advancedOpen && (
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Field label="Route Name">
                  <input className="input-field" value={filterName} onChange={(e) => setFilterName(e.target.value)} placeholder="Exact route name" />
                </Field>
                <Field label="Search (name contains)">
                  <input
                    className="input-field"
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && runSearch()}
                    placeholder="Any route name…"
                  />
                </Field>
                <Field label="Date">
                  <input type="date" className="input-field" value={date} onChange={(e) => setDate(e.target.value)} />
                </Field>
                <div className="flex items-end gap-2">
                  <button className="h-8 px-3 rounded-lg bg-primary text-white text-[12px] font-medium hover:bg-primary-hover transition" onClick={runSearch}>Search</button>
                  <button className="h-8 px-3 rounded-lg border border-border text-txt text-[12px] font-medium hover:bg-bg transition" onClick={resetSearch}>Reset</button>
                </div>
              </div>
            )}
          </div>

          <div className="max-h-56 overflow-auto">
            {loading ? (
              <div className="flex items-center justify-center py-8 gap-2"><Spinner size="sm" /><span className="text-[12px] text-txt-secondary">Loading…</span></div>
            ) : list.length === 0 ? (
              <div className="text-[12px] text-txt-secondary text-center py-8 px-4">No completed routes found.{!advancedOpen && ' Try the search options above.'}</div>
            ) : (
              list.map((r) => {
                const m = routeMetrics(r);
                const active = selectedId === r.Id;
                return (
                  <button
                    key={r.Id}
                    className={`w-full text-left border-b border-border/60 px-3 py-2 transition ${active ? 'bg-primary/5 ring-1 ring-inset ring-primary/30' : 'hover:bg-bg/50'}`}
                    onClick={() => setCompareRoute(active ? null : r)}
                  >
                    <div className="flex items-center gap-2">
                      {active && <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: compareColor }} />}
                      <span className="text-[12px] font-medium text-txt truncate flex-1">{r.Name}</span>
                      {m.completed && <span className="text-[9px] font-semibold text-success bg-success/10 px-1.5 py-0.5 rounded-full shrink-0">Completed</span>}
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-txt-secondary">
                      <span>{m.date}</span>
                      <span>· {m.stops} stops</span>
                      <span>· {m.distance}</span>
                      <span>· created {fmtDateTime(r.CreatedDate)}</span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Comparison */}
        {!compareRoute ? (
          <div className="flex-1 flex items-center justify-center text-[12px] text-txt-secondary text-center px-6">
            Select a route above to compare. Both routes will be drawn on the map.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <RouteColumn title="Current" name={route?.Name} metrics={current} color={currentColor} />
              <RouteColumn title="Comparison" name={compareRoute?.Name} metrics={compare} color={compareColor} />
            </div>

            <div className="border border-border rounded-lg overflow-hidden">
              <div className="px-3 py-1.5 bg-bg/50 border-b border-border text-[11px] font-semibold text-txt-secondary uppercase tracking-wide">Metrics</div>
              <table className="w-full text-[12px]">
                <tbody className="divide-y divide-border/50">
                  <MetricRow label="Stops" a={current.stops} b={compare.stops} />
                  <MetricRow label="Distance" a={current.distance} b={compare.distance} />
                  <MetricRow label="Total time" a={current.time} b={compare.time} />
                  <MetricRow label="Gallons" a={current.gallons} b={compare.gallons} />
                  <MetricRow label="Completion" a={current.completion} b={compare.completion} />
                  <MetricRow label="Date" a={current.date} b={compare.date} />
                  <MetricRow label="Driver" a={current.driver} b={compare.driver} />
                </tbody>
              </table>
            </div>

            {diff && (
              <div className="flex flex-col gap-2">
                <StopList title="In both" tone="text-txt" names={diff.both} />
                <StopList title="Only in current" tone="text-primary" dot={currentColor} names={diff.onlyCurrent} />
                <StopList title="Only in comparison" tone="text-ai" dot={compareColor} names={diff.onlySelected} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function RouteColumn({ title, name, metrics, color }) {
  return (
    <div className="rounded-lg border border-border bg-bg/30 p-2.5">
      <div className="flex items-center gap-1.5">
        <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: color }} />
        <span className="text-[10px] uppercase tracking-wide text-txt-secondary font-semibold">{title}</span>
      </div>
      <div className="text-[12px] font-semibold text-txt truncate mt-0.5">{name || '—'}</div>
      <div className="mt-2 grid grid-cols-2 gap-1.5 text-[11px]">
        <Stat label="Stops" value={metrics.stops} />
        <Stat label="Distance" value={metrics.distance} />
        <Stat label="Time" value={metrics.time} />
        <Stat label="Gallons" value={metrics.gallons} />
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="flex items-center justify-between bg-surface rounded px-2 py-1">
      <span className="text-txt-secondary">{label}</span>
      <span className="font-semibold text-txt tabular-nums">{value}</span>
    </div>
  );
}

function MetricRow({ label, a, b }) {
  const same = String(a) === String(b);
  return (
    <tr>
      <td className="px-3 py-1.5 text-txt-secondary w-1/3">{label}</td>
      <td className="px-3 py-1.5 text-txt tabular-nums">{a}</td>
      <td className={`px-3 py-1.5 tabular-nums ${same ? 'text-txt' : 'text-ai font-medium'}`}>{b}</td>
    </tr>
  );
}

function StopList({ title, tone, dot, names }) {
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="px-2.5 py-1.5 bg-bg/50 border-b border-border flex items-center justify-between">
        <span className={`flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide ${tone}`}>
          {dot && <span className="w-2 h-2 rounded-sm" style={{ background: dot }} />}
          {title}
        </span>
        <span className="text-[10px] text-txt-secondary tabular-nums">{names.length}</span>
      </div>
      <div className="max-h-32 overflow-auto divide-y divide-border/40">
        {names.length === 0 ? (
          <div className="text-[11px] text-txt-secondary px-2.5 py-2">None</div>
        ) : (
          names.map((n, i) => <div key={`${n}-${i}`} className="px-2.5 py-1 text-[11px] text-txt truncate">{n}</div>)
        )}
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[11px] font-medium text-txt-secondary">{label}</label>
      {children}
    </div>
  );
}
