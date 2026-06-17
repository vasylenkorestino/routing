import { useState, useEffect, useCallback, useMemo } from 'react';
import useStore from '../../store';
import * as routingApi from '../../api/routing';
import Spinner from '../ui/Spinner';
import LastServices from '../shared/LastServices';
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
const acctName = (s) => s.Account_Name__c || s.Name || acctId(s);

/** Normalized headline metrics for a route (works for store + fetched records). */
function routeMetrics(route) {
  const stops = getStops(route);
  const distRaw = route?.Total_Distance__c;
  const distNum = parseFloat(distRaw);
  const distance = typeof distRaw === 'string' && distRaw.includes('mi')
    ? distRaw
    : (!Number.isNaN(distNum) ? `${distNum.toFixed(1)} mi` : '—');
  const gallons = stops.reduce((sum, p) => sum + (parseFloat(p.Gallons_Collected__c) || 0), 0);
  const done = stops.filter((s) => s.Status__c === 'Completed' || s.Status__c === 'Complete').length;
  return {
    stops: stops.length,
    distance,
    time: route?.Total_Time__c || '—',
    gallons: gallons ? gallons.toFixed(1) : '—',
    completion: stops.length ? `${done}/${stops.length}` : '—',
    date: route?.Service_Date__c || '—',
    driver: route?.DriverName__c || 'Unassigned',
  };
}

const fmtDateTime = (d) => {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return d; }
};

const CURRENT_KEY = '__current__';

/* ── panel ───────────────────────────────────────────────────────────── */

/** Multi-route side-by-side comparison shown in the right panel (map stays on the left). */
export default function RouteComparePanel() {
  const route = useStore((s) => s.route);
  const compareRoutes = useStore((s) => s.compareRoutes);
  const toggleCompareRoute = useStore((s) => s.toggleCompareRoute);
  const setCompareRoutes = useStore((s) => s.setCompareRoutes);
  const closeCompare = useStore((s) => s.closeCompare);
  const compareDetail = useStore((s) => s.compareDetail);
  const setCompareDetail = useStore((s) => s.setCompareDetail);

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

  useEffect(() => { fetchRoutes({ routeName: route?.Name }); }, [fetchRoutes, route?.Name]);

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

  const selectedIds = useMemo(() => new Set(compareRoutes.map((r) => r.Id ?? r.id)), [compareRoutes]);
  const currentColor = route?._color ?? '#2563eb';

  // All routes in the comparison (current first), each with a stable key + colour.
  const allRoutes = useMemo(() => ([
    { key: CURRENT_KEY, name: route?.Name, color: currentColor, route, isCurrent: true },
    ...compareRoutes.map((r) => ({ key: r.Id ?? r.id, name: r.Name, color: r._color, route: r })),
  ]), [route, currentColor, compareRoutes]);

  // Account → which routes contain it (by key), with display name.
  const accountIndex = useMemo(() => {
    const idx = new Map();
    allRoutes.forEach(({ key, route: r }) => {
      getStops(r).forEach((s) => {
        const id = acctId(s);
        if (!id) return;
        if (!idx.has(id)) idx.set(id, { id, name: acctName(s), keys: new Set() });
        idx.get(id).keys.add(key);
      });
    });
    return idx;
  }, [allRoutes]);

  const sections = useMemo(() => {
    const total = allRoutes.length;
    const inAll = [], onlyCurrent = [], onlyComparison = [], partial = [];
    for (const a of accountIndex.values()) {
      if (a.keys.size === total) inAll.push(a);
      else {
        if (a.keys.size === 1 && a.keys.has(CURRENT_KEY)) onlyCurrent.push(a);
        else if (!a.keys.has(CURRENT_KEY)) onlyComparison.push(a);
        partial.push(a);
      }
    }
    const byName = (x, y) => x.name.localeCompare(y.name);
    return {
      inAll: inAll.sort(byName),
      onlyCurrent: onlyCurrent.sort(byName),
      onlyComparison: onlyComparison.sort(byName),
      partial: partial.sort(byName),
    };
  }, [accountIndex, allRoutes]);

  const hasComparison = compareRoutes.length > 0;
  const openDetail = (a) => setCompareDetail({ accountId: a.id, accountName: a.name });

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
          {hasComparison && <span className="text-[10px] text-txt-secondary shrink-0">{compareRoutes.length} selected</span>}
        </div>
        <button onClick={closeCompare} className="h-7 px-3 rounded-lg border border-border text-txt text-[11px] font-medium hover:bg-bg transition shrink-0">Close</button>
      </div>

      <div className="flex-1 overflow-auto p-3 flex flex-col gap-3">
        {/* Candidate selector */}
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-2">
            <button
              className="flex items-center gap-1.5 text-[11px] font-medium text-txt-secondary hover:text-txt transition"
              onClick={() => setAdvancedOpen((o) => !o)}
            >
              <svg className={`w-3 h-3 transition-transform ${advancedOpen ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
              </svg>
              Search options
            </button>
            <div className="flex items-center gap-2 text-[11px]">
              <button className="text-primary hover:underline" onClick={() => setCompareRoutes(list)} disabled={!list.length}>Select all</button>
              <span className="text-border">|</span>
              <button className="text-txt-secondary hover:underline" onClick={() => setCompareRoutes([])} disabled={!hasComparison}>Deselect all</button>
            </div>
          </div>

          {advancedOpen && (
            <div className="px-3 py-2 border-b border-border grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Field label="Route Name">
                <input className="input-field" value={filterName} onChange={(e) => setFilterName(e.target.value)} placeholder="Exact route name" />
              </Field>
              <Field label="Search (name contains)">
                <input className="input-field" value={searchText} onChange={(e) => setSearchText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} placeholder="Any route name…" />
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

          <div className="max-h-48 overflow-auto">
            {loading ? (
              <div className="flex items-center justify-center py-8 gap-2"><Spinner size="sm" /><span className="text-[12px] text-txt-secondary">Loading…</span></div>
            ) : list.length === 0 ? (
              <div className="text-[12px] text-txt-secondary text-center py-8 px-4">No completed routes found.{!advancedOpen && ' Try the search options above.'}</div>
            ) : (
              list.map((r) => {
                const m = routeMetrics(r);
                const checked = selectedIds.has(r.Id ?? r.id);
                const color = compareRoutes.find((c) => (c.Id ?? c.id) === (r.Id ?? r.id))?._color;
                return (
                  <label key={r.Id} className={`flex items-start gap-2 border-b border-border/60 px-3 py-2 cursor-pointer transition ${checked ? 'bg-primary/5' : 'hover:bg-bg/50'}`}>
                    <input type="checkbox" className="mt-0.5 accent-primary" checked={checked} onChange={() => toggleCompareRoute(r)} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        {checked && color && <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: color }} />}
                        <span className="text-[12px] font-medium text-txt truncate flex-1">{r.Name}</span>
                        {m.completion !== '—' && <span className="text-[9px] font-semibold text-success bg-success/10 px-1.5 py-0.5 rounded-full shrink-0">Completed</span>}
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-txt-secondary">
                        <span>{m.date}</span><span>· {m.stops} stops</span><span>· {m.distance}</span><span>· created {fmtDateTime(r.CreatedDate)}</span>
                      </div>
                    </div>
                  </label>
                );
              })
            )}
          </div>
        </div>

        {!hasComparison ? (
          <div className="flex-1 flex items-center justify-center text-[12px] text-txt-secondary text-center px-6">
            Select one or more routes above to compare. Every selected route is drawn on the map in its own colour.
          </div>
        ) : (
          <>
            {/* Single summary table — one row per route, metrics shown once */}
            <Section title="Summary">
              <div className="overflow-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wide text-txt-secondary border-b border-border/60">
                      <th className="text-left font-semibold px-3 py-1.5">Route</th>
                      <th className="text-right font-semibold px-2 py-1.5">Stops</th>
                      <th className="text-right font-semibold px-2 py-1.5">Distance</th>
                      <th className="text-right font-semibold px-2 py-1.5">Time</th>
                      <th className="text-right font-semibold px-2 py-1.5">Gallons</th>
                      <th className="text-right font-semibold px-2 py-1.5">Done</th>
                      <th className="text-right font-semibold px-2 py-1.5">Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {allRoutes.map(({ key, name, color, isCurrent }) => {
                      const m = routeMetrics(key === CURRENT_KEY ? route : compareRoutes.find((c) => (c.Id ?? c.id) === key));
                      return (
                        <tr key={key} className={isCurrent ? 'bg-primary/5' : ''}>
                          <td className="px-3 py-1.5">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: color }} />
                              <span className="truncate text-txt font-medium">{name}</span>
                              {isCurrent && <span className="text-[9px] text-primary font-semibold shrink-0">(current)</span>}
                            </div>
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-txt">{m.stops}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-txt">{m.distance}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-txt">{m.time}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-txt">{m.gallons}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-txt">{m.completion}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-txt-secondary">{m.date}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Section>

            {/* Difference sections — side by side on larger screens, stacked on mobile */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <AccountSection title="In all selected routes" tone="text-success" accounts={sections.inAll} onPick={openDetail} />
              <AccountSection title="Only in current route" tone="text-primary" dot={currentColor} accounts={sections.onlyCurrent} onPick={openDetail} />
              <AccountSection title="Only in comparison routes" tone="text-ai" accounts={sections.onlyComparison} onPick={openDetail} />
            </div>

            {/* Route-specific breakdown */}
            {sections.partial.length > 0 && (
              <Section title="Route-specific differences" count={sections.partial.length}>
                <div className="max-h-64 overflow-auto divide-y divide-border/40">
                  {sections.partial.map((a) => (
                    <div key={a.id} className="flex items-center gap-2 px-3 py-1.5">
                      <button className="text-[11px] text-txt hover:text-primary hover:underline truncate flex-1 text-left" onClick={() => openDetail(a)}>{a.name}</button>
                      <div className="flex flex-wrap gap-1 justify-end shrink-0">
                        {allRoutes.filter((r) => a.keys.has(r.key)).map((r) => (
                          <span key={r.key} className="inline-flex items-center gap-1 text-[9px] font-medium text-txt-secondary bg-bg rounded px-1.5 py-0.5 max-w-[120px]" title={r.name}>
                            <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: r.color }} />
                            <span className="truncate">{r.isCurrent ? 'Current' : r.name}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </>
        )}

        {/* Last Services for a clicked account/stop */}
        {compareDetail?.accountId && (
          <div className="border border-border rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-3 py-1.5 bg-bg/50 border-b border-border">
              <span className="text-[11px] font-semibold text-txt-secondary uppercase tracking-wide">Service history</span>
              <button className="text-txt-secondary hover:text-error text-sm leading-none" onClick={() => setCompareDetail(null)}>×</button>
            </div>
            <LastServices accountId={compareDetail.accountId} accountName={compareDetail.accountName} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Collapsible section wrapper — header toggles the body; expanded by default. */
function Section({ title, tone = 'text-txt-secondary', dot, count, children }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        className={`w-full flex items-center justify-between px-3 py-1.5 bg-bg/50 ${open ? 'border-b border-border' : ''}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide ${tone}`}>
          <svg className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
          {dot && <span className="w-2 h-2 rounded-sm" style={{ background: dot }} />}
          {title}
        </span>
        {count != null && <span className="text-[10px] text-txt-secondary tabular-nums">{count}</span>}
      </button>
      {open && children}
    </div>
  );
}

/** A labelled, collapsible, scrollable list of clickable account names. */
function AccountSection({ title, tone, dot, accounts, onPick }) {
  return (
    <Section title={title} tone={tone} dot={dot} count={accounts.length}>
      <div className="max-h-40 overflow-auto divide-y divide-border/40">
        {accounts.length === 0 ? (
          <div className="text-[11px] text-txt-secondary px-3 py-2">None</div>
        ) : (
          accounts.map((a) => (
            <button key={a.id} className="w-full text-left px-3 py-1 text-[11px] text-txt hover:text-primary hover:bg-bg/50 hover:underline truncate transition" onClick={() => onPick(a)}>
              {a.name}
            </button>
          ))
        )}
      </div>
    </Section>
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
