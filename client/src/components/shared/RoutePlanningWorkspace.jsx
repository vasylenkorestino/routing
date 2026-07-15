import { useEffect, useMemo, useRef, useState } from 'react';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import useStore from '../../store';
import RoutesOverviewMap, { routeColor } from './RoutesOverviewMap';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';
import { fmtDuration } from '../../utils/routeDuration';

/** Full-screen AI Route Planning workspace: live build, DnD editing, commit. */
export default function RoutePlanningWorkspace() {
  const status = useStore((s) => s.planningStatus);
  const progress = useStore((s) => s.planningProgress);
  const session = useStore((s) => s.planningSession);
  const summary = useStore((s) => s.planningSummary);
  const routes = useStore((s) => s.planningRoutes);
  const tray = useStore((s) => s.planningTray);
  const trace = useStore((s) => s.planningTrace);
  const saving = useStore((s) => s.planningSaving);
  const dirty = useStore((s) => s.planningDirty);
  const committing = useStore((s) => s.planningCommitting);
  const error = useStore((s) => s.planningError);
  const selectedDay = useStore((s) => s.planningSelectedDay);

  const setSelectedDay = useStore((s) => s.setPlanningSelectedDay);
  const closePlanning = useStore((s) => s.closePlanning);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const reorderRouteStop = useStore((s) => s.reorderRouteStop);
  const moveStopBetweenRoutes = useStore((s) => s.moveStopBetweenRoutes);
  const combineRoutes = useStore((s) => s.combineRoutes);
  const splitRoute = useStore((s) => s.splitRoute);
  const removeStopToTray = useStore((s) => s.removeStopToTray);
  const addStopFromTray = useStore((s) => s.addStopFromTray);
  const regenerateSingleRoute = useStore((s) => s.regenerateSingleRoute);
  const setRouteAdminNotes = useStore((s) => s.setRouteAdminNotes);
  const toggleRouteKeepOrder = useStore((s) => s.toggleRouteKeepOrder);
  const setSessionAdminNotes = useStore((s) => s.setSessionAdminNotes);
  const commitPlanning = useStore((s) => s.commitPlanning);
  const refreshPlanJob = useStore((s) => s.refreshPlanJob);
  const regeneratePlan = useStore((s) => s.regeneratePlan);

  const [selectedId, setSelectedId] = useState(null);
  const [checked, setChecked] = useState(() => new Set());
  const [mapView, setMapView] = useState('overview'); // overview | single | playback
  const [playing, setPlaying] = useState(false);
  const [playIndex, setPlayIndex] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const isRunning = status === 'running';

  // SSE fallback: poll the job while running in case SSE is unavailable.
  useEffect(() => {
    if (!isRunning) return undefined;
    const t = setInterval(() => refreshPlanJob(), 4000);
    return () => clearInterval(t);
  }, [isRunning, refreshPlanJob]);

  // Distinct service days across the plan.
  const days = useMemo(() => [...new Set(routes.map((r) => r.serviceDate).filter(Boolean))].sort(), [routes]);
  const activeDay = selectedDay && days.includes(selectedDay) ? selectedDay : days[0] || null;
  const dayRoutes = useMemo(
    () => (days.length > 1 ? routes.filter((r) => r.serviceDate === activeDay) : routes),
    [routes, days, activeDay],
  );

  // Fallback to the first route for the detail panel only; the map highlights
  // (dims others) only when the user has explicitly selected a route.
  const selectedRoute = useMemo(() => routes.find((r) => r.id === selectedId) || dayRoutes[0] || null, [routes, selectedId, dayRoutes]);
  const checkedRoutes = useMemo(() => dayRoutes.filter((r) => checked.has(r.id)), [dayRoutes, checked]);

  // In Single mode, show only the selected route but pin its Day-view color.
  const singleRoute = useMemo(() => {
    if (!selectedRoute) return null;
    const idx = dayRoutes.findIndex((r) => r.id === selectedRoute.id);
    return { ...selectedRoute, _color: routeColor(idx >= 0 ? idx : 0) };
  }, [selectedRoute, dayRoutes]);

  // Trace playback ticker.
  useEffect(() => {
    if (!playing || mapView !== 'playback' || trace.length === 0) return undefined;
    const t = setInterval(() => {
      setPlayIndex((i) => {
        if (i >= trace.length - 1) { setPlaying(false); return i; }
        return i + 1;
      });
    }, 700);
    return () => clearInterval(t);
  }, [playing, mapView, trace.length]);

  const toggleCheck = (id) => setChecked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const onDragEnd = (res) => {
    const { source, destination, draggableId } = res;
    if (!destination) return;
    const accountId = draggableId.split('::')[1];
    if (source.droppableId === destination.droppableId) {
      if (source.droppableId === 'tray') return;
      reorderRouteStop(source.droppableId, source.index, destination.index);
      return;
    }
    if (source.droppableId === 'tray') {
      addStopFromTray(accountId, destination.droppableId, destination.index);
    } else if (destination.droppableId === 'tray') {
      removeStopToTray(source.droppableId, accountId);
    } else {
      moveStopBetweenRoutes(source.droppableId, destination.droppableId, accountId, destination.index);
    }
  };

  const doCombine = () => {
    const ids = [...checked].filter((id) => dayRoutes.some((r) => r.id === id));
    const merged = combineRoutes(ids);
    if (merged) { setChecked(new Set([merged])); setSelectedId(merged); toast.success('Routes combined'); }
    else toast.error('Select at least two routes on the same day');
  };

  const doSplit = () => {
    if (!selectedRoute || selectedRoute.totalStops < 2) return;
    const first = splitRoute(selectedRoute.id);
    if (first) { setSelectedId(first); toast.success('Route split into two'); }
  };

  const doRegenerate = async () => {
    if (!selectedRoute) return;
    try { await regenerateSingleRoute(selectedRoute.id); toast.success('Route regenerated'); }
    catch (err) { toast.error(getErrorMessage(err)); }
  };

  const doRegeneratePlan = async (newParams, keepEdited) => {
    setSettingsOpen(false);
    setChecked(new Set());
    setSelectedId(null);
    try { await regeneratePlan(newParams, { keepEdited }); }
    catch (err) { toast.error(getErrorMessage(err)); }
  };

  const doCommit = async (ids) => {
    try {
      const res = await commitPlanning(ids);
      if (res?.success) {
        toast.success(`Created ${res.created} route(s), ${res.totalStops} stop(s)`);
        if (res.skipped?.length) toast.error(`${res.skipped.length} route(s) skipped (already routed)`);
        if (res.sessionCommitted) closePlanning();
      }
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  const uncommitted = routes.filter((r) => !r.committed);

  return (
    <div className="fixed inset-0 z-[1100] bg-surface flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-4 px-5 py-3 border-b border-border bg-bg/50 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-ai">✦</span>
          <h2 className="text-base font-semibold text-txt">Route Planning</h2>
        </div>
        {session && (
          <div className="flex items-center gap-3 text-[12px] text-txt-secondary">
            <span>{session.serviceLocationName || 'All Locations'}</span>
            <span>·</span>
            <span>{session.dateFrom}{session.dateTo && session.dateTo !== session.dateFrom ? ` → ${session.dateTo}` : ''}</span>
            <span>·</span>
            <span className="text-txt font-medium">{routes.length} route(s)</span>
            {session.status === 'Committed' && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700">COMMITTED</span>}
          </div>
        )}
        <div className="flex-1" />
        <span className="text-[11px] text-txt-secondary">
          {saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'All changes saved'}
        </span>
        <button onClick={closePlanning} className="text-txt-secondary hover:text-txt transition p-1.5 rounded" title="Close (keeps your session to resume later)">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {isRunning ? (
        <RunningView progress={progress} error={error} />
      ) : (
        <>
          {/* Action bar */}
          <div className="flex items-center gap-2 px-5 py-2.5 border-b border-border shrink-0 flex-wrap">
            <button className="h-8 px-3 rounded-lg bg-ai text-white text-[13px] font-medium hover:bg-ai-hover transition disabled:opacity-50" disabled={committing || uncommitted.length === 0} onClick={() => doCommit(null)}>
              Approve &amp; Create All ({uncommitted.length})
            </button>
            <button className="h-8 px-3 rounded-lg bg-primary text-white text-[13px] font-medium hover:bg-primary-hover transition disabled:opacity-50" disabled={committing || checked.size === 0} onClick={() => doCommit([...checked])}>
              Create Selected ({checked.size})
            </button>
            <div className="w-px h-5 bg-border mx-1" />
            <IconBtn label="Undo" onClick={undo} />
            <IconBtn label="Redo" onClick={redo} />
            <button className="h-8 px-3 rounded-lg border border-border text-txt text-[13px] font-medium hover:bg-bg transition disabled:opacity-50" disabled={checked.size < 2} onClick={doCombine}>Combine</button>
            <button className="h-8 px-3 rounded-lg border border-border text-txt text-[13px] font-medium hover:bg-bg transition disabled:opacity-50" disabled={!selectedRoute || selectedRoute.totalStops < 2} onClick={doSplit}>Split</button>
            <button className="h-8 px-3 rounded-lg border border-border text-txt text-[13px] font-medium hover:bg-bg transition disabled:opacity-50" disabled={!selectedRoute} onClick={doRegenerate}>Regenerate route</button>
            <div className="w-px h-5 bg-border mx-1" />
            <button
              className={`h-8 px-3 rounded-lg border text-[13px] font-medium transition ${settingsOpen ? 'border-ai bg-ai/10 text-ai' : 'border-border text-txt hover:bg-bg'}`}
              disabled={session?.status === 'Committed'}
              onClick={() => setSettingsOpen((v) => !v)}
              title="Change planning settings and re-plan the whole set"
            >
              ⚙ Settings &amp; regenerate
            </button>
            {trace.length > 0 && (
              <button
                className={`h-8 px-3 rounded-lg border text-[13px] font-medium transition ${mapView === 'playback' ? 'border-ai bg-ai/10 text-ai' : 'border-border text-txt hover:bg-bg'}`}
                onClick={() => { setMapView('playback'); setPlayIndex(0); setPlaying(true); }}
              >
                ▶ Replay build
              </button>
            )}
            {committing && <span className="text-[12px] text-ai animate-pulse">Creating…</span>}
          </div>

          {settingsOpen && (
            <PlanSettingsPanel
              caps={summary?.caps || session?.params || {}}
              onClose={() => setSettingsOpen(false)}
              onRegenerate={doRegeneratePlan}
            />
          )}

          {/* Day strip */}
          {days.length > 1 && (
            <div className="flex items-center gap-2 px-5 py-2 border-b border-border shrink-0 overflow-auto">
              {days.map((d) => {
                const count = routes.filter((r) => r.serviceDate === d).length;
                return (
                  <button
                    key={d}
                    className={`h-7 px-3 rounded-lg border text-[12px] font-medium whitespace-nowrap transition ${d === activeDay ? 'border-ai bg-ai/10 text-ai' : 'border-border text-txt-secondary hover:bg-bg'}`}
                    onClick={() => { setSelectedDay(d); setSelectedId(null); }}
                  >
                    {d} · {count}
                  </button>
                );
              })}
            </div>
          )}

          {routes.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-txt-secondary text-sm text-center px-6">
              No routes were planned for this range. You can close and try a different date or location.
            </div>
          ) : (
            <DragDropContext onDragEnd={onDragEnd}>
              <div className="flex-1 flex min-h-0">
                {/* Left: route list with DnD stops + tray */}
                <div className="w-[440px] shrink-0 border-r border-border flex flex-col min-h-0">
                  <div className="flex-1 overflow-auto p-2 space-y-2">
                    {dayRoutes.map((r, i) => (
                      <RouteCard
                        key={r.id}
                        route={r}
                        color={routeColor(i)}
                        active={r.id === selectedRoute?.id}
                        checked={checked.has(r.id)}
                        onToggle={() => toggleCheck(r.id)}
                        onSelect={() => setSelectedId(r.id)}
                        onRemoveStop={(accountId) => removeStopToTray(r.id, accountId)}
                      />
                    ))}
                  </div>
                  <TrayDroppable tray={tray} />
                </div>

                {/* Right: map + detail */}
                <div className="flex-1 flex flex-col min-h-0">
                  <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
                    <div className="inline-flex rounded-lg border border-border overflow-hidden">
                      {['overview', 'single', ...(trace.length ? ['playback'] : [])].map((v) => (
                        <button
                          key={v}
                          className={`h-7 px-3 text-[12px] font-medium transition border-none ${mapView === v ? 'bg-ai text-white' : 'bg-surface text-txt-secondary hover:bg-bg'}`}
                          onClick={() => setMapView(v)}
                        >
                          {v === 'overview' ? `Day (${dayRoutes.length})` : v === 'single' ? 'Single' : 'Replay'}
                        </button>
                      ))}
                    </div>
                    {mapView === 'playback' && (
                      <PlaybackControls
                        trace={trace}
                        index={playIndex}
                        playing={playing}
                        onToggle={() => setPlaying((p) => !p)}
                        onScrub={(i) => { setPlaying(false); setPlayIndex(i); }}
                      />
                    )}
                    <span className="text-[11px] text-txt-secondary truncate ml-auto">
                      {mapView === 'single' ? selectedRoute?.routeName : mapView === 'playback' ? trace[playIndex]?.label : `${dayRoutes.length} route(s) on the map`}
                    </span>
                  </div>

                  <div className="h-[45%] min-h-[220px] border-b border-border">
                    {/* One persistent map for all views: toggling only shows/hides
                        routes, so the viewport (center/zoom) is preserved. */}
                    <RoutesOverviewMap
                      routes={
                        mapView === 'playback'
                          ? (trace[playIndex]?.routes || [])
                          : mapView === 'single'
                            ? (singleRoute ? [singleRoute] : [])
                            : dayRoutes
                      }
                      selectedId={mapView === 'overview' ? selectedId : null}
                      onSelectRoute={(id) => setSelectedId(id)}
                    />
                  </div>
                  <div className="flex-1 overflow-auto p-4">
                    {selectedRoute && (
                      <RouteDetail
                        route={selectedRoute}
                        onNotes={(v) => setRouteAdminNotes(selectedRoute.id, v)}
                        onToggleKeepOrder={() => toggleRouteKeepOrder(selectedRoute.id)}
                      />
                    )}
                  </div>
                </div>
              </div>
            </DragDropContext>
          )}

          {/* Session-level admin notes */}
          <div className="px-5 py-2 border-t border-border shrink-0 flex items-center gap-2">
            <label className="text-[11px] font-medium text-txt-secondary shrink-0">Session notes</label>
            <input
              className="input-field h-8 flex-1"
              placeholder="Admin notes (optional)…"
              value={session?.adminNotes || ''}
              onChange={(e) => setSessionAdminNotes(e.target.value)}
            />
          </div>
        </>
      )}
    </div>
  );
}

/* ── Sub-components ────────────────────────────────────────── */

function RunningView({ progress, error }) {
  const overviewRoutes = progress?.routes || [];
  return (
    <div className="flex-1 flex min-h-0">
      <div className="w-[380px] shrink-0 border-r border-border p-6 flex flex-col">
        <div className="text-sm font-semibold text-txt mb-1">Watching the AI plan…</div>
        <div className="text-[12px] text-txt-secondary mb-4">{progress?.label || 'Working'}</div>
        <div className="h-2 rounded-full bg-bg overflow-hidden mb-4">
          <div className="h-full bg-ai transition-all duration-300" style={{ width: `${progress?.percent || 0}%` }} />
        </div>
        <div className="grid grid-cols-2 gap-2 text-[12px]">
          <Counter label="Accounts found" value={progress?.counters?.accountsFound} />
          <Counter label="Planned" value={progress?.counters?.accountsPlanned} />
          <Counter label="Routes" value={progress?.counters?.routesPlanned} />
          <Counter label="Days" value={progress?.counters?.daysPlanned} />
        </div>
        {error && <div className="mt-4 text-[12px] text-error">{error}</div>}
      </div>
      <div className="flex-1">
        <RoutesOverviewMap routes={overviewRoutes} />
      </div>
    </div>
  );
}

function Counter({ label, value }) {
  return (
    <div className="rounded-lg border border-border/70 bg-bg/30 px-3 py-2">
      <div className="text-[10px] text-txt-secondary">{label}</div>
      <div className="text-[16px] font-semibold text-txt mt-0.5 tabular-nums">{value ?? 0}</div>
    </div>
  );
}

function IconBtn({ label, onClick }) {
  return (
    <button className="h-8 px-2.5 rounded-lg border border-border text-txt-secondary text-[13px] font-medium hover:bg-bg hover:text-txt transition" onClick={onClick}>
      {label}
    </button>
  );
}

function RouteCard({ route, color, active, checked, onToggle, onSelect, onRemoveStop }) {
  const ref = useRef(null);
  // Bring the selected route into view when it's chosen from the map or actions.
  useEffect(() => {
    if (active && ref.current) ref.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [active]);
  return (
    <div ref={ref} className={`rounded-lg border transition ${active ? 'border-ai bg-ai/5 ring-1 ring-ai/40' : 'border-border/70 hover:border-border'}`}>
      <div className="flex items-start gap-2 px-2.5 py-2 border-b border-border/50">
        <input type="checkbox" className="mt-1" checked={checked} onChange={onToggle} onClick={(e) => e.stopPropagation()} />
        <button className="flex-1 text-left min-w-0" onClick={onSelect}>
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
            <span className="text-[13px] font-medium text-txt truncate">{route.routeName}</span>
            {route.committed && <span className="text-[9px] font-semibold px-1 py-0.5 rounded bg-emerald-100 text-emerald-700">DONE</span>}
            {route.keepOrder && <span className="text-[9px] font-semibold px-1 py-0.5 rounded bg-indigo-100 text-indigo-700">KEEP ORDER</span>}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-txt-secondary">
            <span>{route.totalStops} stops</span>
            <span>· {route.totalDistanceMi} mi</span>
            <span>· {fmtDuration(route.totalDurationMin)}</span>
            <span>· {route.totalGallons} gal</span>
          </div>
        </button>
      </div>
      <Droppable droppableId={route.id} type="STOP">
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={`px-2 py-1.5 min-h-[36px] space-y-1 ${snapshot.isDraggingOver ? 'bg-ai/5' : ''}`}
          >
            {route.stops.map((s, i) => (
              <Draggable key={s.accountId} draggableId={`${route.id}::${s.accountId}`} index={i}>
                {(dp, ds) => (
                  <div
                    ref={dp.innerRef}
                    {...dp.draggableProps}
                    {...dp.dragHandleProps}
                    className={`flex items-start gap-2 px-2 py-1 rounded-md text-[12px] border ${ds.isDragging ? 'bg-surface border-ai shadow' : 'bg-bg/40 border-border/50'}`}
                  >
                    <span className="w-4 text-right tabular-nums text-txt-secondary pt-0.5">{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-txt">{s.accountName || s.accountId}</span>
                        {s.hasOpenTicket && <span className="text-[8px] font-semibold px-1 py-0.5 rounded bg-amber-100 text-amber-700 shrink-0">TICKET</span>}
                      </div>
                      <div className="flex items-center gap-1.5 text-[10px] text-txt-secondary">
                        {s.address && <span className="truncate" title={s.address}>{s.address}</span>}
                        {s.lastServiceDate && <span className="shrink-0" title="Last UCO service date">· Last: {s.lastServiceDate}</span>}
                      </div>
                    </div>
                    <span className="tabular-nums text-txt-secondary shrink-0 pt-0.5" title="Estimated gallons to collect at this stop">~{s.estGallons} gal</span>
                    <button className="text-txt-secondary hover:text-error px-1" title="Remove to tray" onClick={() => onRemoveStop(s.accountId)}>×</button>
                  </div>
                )}
              </Draggable>
            ))}
            {provided.placeholder}
          </div>
        )}
      </Droppable>
    </div>
  );
}

function TrayDroppable({ tray }) {
  return (
    <Droppable droppableId="tray" type="STOP">
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.droppableProps}
          className={`border-t border-border shrink-0 max-h-[140px] overflow-auto p-2 ${snapshot.isDraggingOver ? 'bg-amber-50' : 'bg-bg/30'}`}
        >
          <div className="text-[11px] font-semibold text-txt-secondary uppercase tracking-wide mb-1">Unassigned ({tray.length})</div>
          {tray.length === 0 && <div className="text-[11px] text-txt-secondary italic">Drag stops here to unassign them.</div>}
          <div className="space-y-1">
            {tray.map((s, i) => (
              <Draggable key={s.accountId} draggableId={`tray::${s.accountId}`} index={i}>
                {(dp, ds) => (
                  <div
                    ref={dp.innerRef}
                    {...dp.draggableProps}
                    {...dp.dragHandleProps}
                    className={`flex items-start gap-2 px-2 py-1 rounded-md text-[12px] border ${ds.isDragging ? 'bg-surface border-ai shadow' : 'bg-surface border-border/50'}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-txt">{s.accountName || s.accountId}</span>
                        {s.hasOpenTicket && <span className="text-[8px] font-semibold px-1 py-0.5 rounded bg-amber-100 text-amber-700 shrink-0">TICKET</span>}
                      </div>
                      {s.address && <div className="text-[10px] text-txt-secondary truncate" title={s.address}>{s.address}</div>}
                    </div>
                    <span className="tabular-nums text-txt-secondary shrink-0 pt-0.5" title="Estimated gallons to collect at this stop">~{s.estGallons} gal</span>
                  </div>
                )}
              </Draggable>
            ))}
          </div>
          {provided.placeholder}
        </div>
      )}
    </Droppable>
  );
}

function PlaybackControls({ trace, index, playing, onToggle, onScrub }) {
  return (
    <div className="flex items-center gap-2">
      <button className="h-7 w-7 rounded-lg border border-border text-txt hover:bg-bg transition" onClick={onToggle}>
        {playing ? '❚❚' : '▶'}
      </button>
      <input
        type="range"
        min={0}
        max={Math.max(0, trace.length - 1)}
        value={index}
        onChange={(e) => onScrub(Number(e.target.value))}
        className="w-40"
      />
      <span className="text-[11px] text-txt-secondary tabular-nums">{index + 1}/{trace.length}</span>
    </div>
  );
}

/**
 * Modal to adjust planner guidance and re-run the whole plan. Settings act as
 * recommendations; "keep manual routes" preserves hand-edited/committed routes.
 */
function PlanSettingsPanel({ caps = {}, onClose, onRegenerate }) {
  const [form, setForm] = useState({
    minStopsPerRoute: caps.minStopsPerRoute ?? 5,
    maxStops: caps.maxStops ?? 25,
    maxGallons: caps.maxGallons ?? '',
    serviceTimeMin: caps.serviceTimeMin ?? 15,
    maxDurationMin: caps.maxDurationMin ?? '',
    maxRadiusMiles: caps.maxRadiusMiles ?? '',
  });
  const [keepEdited, setKeepEdited] = useState(true);

  const num = (v) => (v === '' || v == null ? null : Number(v));
  const upd = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = () => {
    onRegenerate(
      {
        minStopsPerRoute: num(form.minStopsPerRoute),
        maxStops: num(form.maxStops),
        maxGallons: num(form.maxGallons),
        serviceTimeMin: num(form.serviceTimeMin),
        maxDurationMin: num(form.maxDurationMin),
        maxRadiusMiles: num(form.maxRadiusMiles),
      },
      keepEdited,
    );
  };

  return (
    <div className="fixed inset-0 z-[1200] flex items-start justify-center bg-black/30 pt-24" onClick={onClose}>
      <div className="w-[440px] rounded-xl bg-surface border border-border shadow-xl p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-semibold text-txt">Planning settings</h3>
          <button className="text-txt-secondary hover:text-txt" onClick={onClose}>✕</button>
        </div>
        <p className="text-[12px] text-txt-secondary mb-4">
          These are recommendations, not hard limits. Regenerating re-evaluates every route with the new settings.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Min stops / route" value={form.minStopsPerRoute} onChange={upd('minStopsPerRoute')} />
          <Field label="Max stops / route" value={form.maxStops} onChange={upd('maxStops')} />
          <Field label="Max gallons / route" value={form.maxGallons} onChange={upd('maxGallons')} placeholder="No cap" />
          <Field label="Service time / stop (min)" value={form.serviceTimeMin} onChange={upd('serviceTimeMin')} />
          <Field label="Max duration (min)" value={form.maxDurationMin} onChange={upd('maxDurationMin')} placeholder="Flexible" />
          <Field label="Max radius (mi)" value={form.maxRadiusMiles} onChange={upd('maxRadiusMiles')} placeholder="Auto" />
        </div>

        <label className="flex items-center gap-2 mt-4 text-[12px] text-txt cursor-pointer select-none">
          <input type="checkbox" checked={keepEdited} onChange={(e) => setKeepEdited(e.target.checked)} />
          Keep manually edited routes (only re-plan the rest)
        </label>

        <div className="flex items-center justify-end gap-2 mt-5">
          <button className="h-8 px-3 rounded-lg border border-border text-txt text-[13px] font-medium hover:bg-bg transition" onClick={onClose}>Cancel</button>
          <button className="h-8 px-4 rounded-lg bg-ai text-white text-[13px] font-medium hover:bg-ai-hover transition" onClick={submit}>Regenerate plan</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder }) {
  return (
    <label className="block">
      <span className="text-[11px] font-medium text-txt-secondary">{label}</span>
      <input
        type="number"
        min={0}
        className="input-field h-8 w-full mt-0.5"
        value={value}
        placeholder={placeholder}
        onChange={onChange}
      />
    </label>
  );
}

function RouteDetail({ route, onNotes, onToggleKeepOrder }) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-txt">{route.routeName}</h3>
        <div className="text-[12px] text-txt-secondary">
          {route.serviceDate} · {route.totalStops} stops · {route.totalDistanceMi} mi · {fmtDuration(route.totalDurationMin)} · {route.totalGallons} gal
        </div>
      </div>

      {(route.chips?.length || route.explanation) && (
        <div>
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {(route.chips || []).map((c, i) => (
              <span key={i} className="text-[11px] px-2 py-0.5 rounded-full bg-bg border border-border/60 text-txt-secondary">{c}</span>
            ))}
          </div>
          {route.explanation && <p className="text-[12px] text-txt-secondary">{route.explanation}</p>}
        </div>
      )}

      <label className="flex items-center gap-2 text-[12px] text-txt cursor-pointer select-none">
        <input type="checkbox" checked={!!route.keepOrder} onChange={onToggleKeepOrder} />
        Keep my manual order on create (pin stops, skip re-optimization)
      </label>

      <div>
        <div className="text-[11px] font-semibold text-txt-secondary uppercase tracking-wide mb-1">Route notes</div>
        <textarea
          className="input-field w-full text-[12px]"
          rows={2}
          placeholder="Notes for this route (optional)…"
          value={route.adminNotes || ''}
          onChange={(e) => onNotes(e.target.value)}
        />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Metric label="Date" value={route.serviceDate} />
        <Metric label="Service Location" value={route.depot?.name || '—'} />
        <Metric label="Direction" value={route.direction || route.sectorLabel || '—'} />
        <Metric label="Drive Time" value={fmtDuration(route.driveTimeMin)} />
        <Metric label="Service Time" value={fmtDuration(route.serviceTimeMin)} />
        <Metric label="Optimization" value={route.optimizationScore != null ? `${route.optimizationScore}%` : 'Manual'} />
      </div>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="rounded-lg border border-border/70 bg-bg/30 px-3 py-2">
      <div className="text-[10px] text-txt-secondary">{label}</div>
      <div className="text-[14px] font-semibold text-txt mt-0.5 truncate">{value}</div>
    </div>
  );
}
