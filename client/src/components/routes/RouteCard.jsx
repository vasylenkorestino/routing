import { useMemo, useState, useCallback } from 'react';
import useStore from '../../store';
import * as routingApi from '../../api/routing';
import AccountTicketSearch from '../shared/AccountTicketSearch';
import { OverlaySpinner } from '../ui/Spinner';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';
import { isRouteCompleted } from '../../utils/route';
import { computeRouteDurations, fmtDuration } from '../../utils/routeDuration';
import useRouteTimeline from '../../hooks/useRouteTimeline';

/** Route header card — shows key metrics and action buttons for the selected route */
export default function RouteCard({ route }) {
  const openModal = useStore((st) => st.openModal);
  const openCompare = useStore((st) => st.openCompare);
  const selectRoute = useStore((st) => st.selectRoute);
  const refreshRoutes = useStore((st) => st.refreshRoutes);
  const drivers = useStore((st) => st.drivers);
  const [optimizing, setOptimizing] = useState(false);
  // Next-stop ETA + last actual completion (in-progress routes only). Shares the
  // Directions cache with the timeline/map layer for the selected route.
  const { nextStopEta, lastCompletedAt } = useRouteTimeline(route);

  const driverName = useMemo(() => {
    if (route?.Driver__c) {
      const d = drivers.find((d) => d.Id === route.Driver__c);
      if (d) return d.Name;
    }
    return route?.DriverName__c || null;
  }, [route?.Driver__c, route?.DriverName__c, drivers]);

  const handleOptimize = useCallback(async () => {
    if (!route?.Id) return;
    setOptimizing(true);
    try {
      const stops = route.Routes__r?.records ?? route.Routes__r ?? [];
      const routePoints = stops.map((w, i) => ({
        Id: w.Id || null,
        AccountId__c: w.AccountId__c || w.Account__c || null,
        Fixed_point__c: w.Fixed_point__c || false,
        Priority__c: i + 1,
        Google_Route_Id__c: route.Id,
        GRoute_Id__c: route.Id,
      }));
      await routingApi.optimizeRoute({ googleRoute: { Id: route.Id, Driver__c: route.Driver__c || null, Service_Location_Start__c: route.Service_Location_Start__c, Service_Location_End__c: route.Service_Location_End__c }, routePoints });
      await refreshRoutes();
      toast.success('Done! Route optimized.');
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setOptimizing(false);
    }
  }, [route, refreshRoutes]);

  const metrics = useMemo(() => {
    if (!route) return [];
    const stops = route.Routes__r?.records ?? route.Routes__r ?? [];
    const totalGallons = stops.reduce((sum, p) => sum + (parseFloat(p.Gallons_Collected__c) || 0), 0);
    const distRaw = route.Total_Distance__c;
    const distNum = parseFloat(distRaw);
    const distStr = typeof distRaw === 'string' && distRaw.includes('mi') ? distRaw : (!isNaN(distNum) ? `${distNum.toFixed(1)} mi` : '—');
    // Drive Time = Google optimization result; Total Time = drive + on-site service per stop.
    const { driveTimeLabel, totalDurationMin } = computeRouteDurations(route);
    return [
      { label: 'Distance', value: distStr },
      { label: 'Drive Time', value: driveTimeLabel || '—' },
      { label: 'Total Time', value: fmtDuration(totalDurationMin) },
      { label: 'Stops', value: stops.length },
      { label: 'Gallons', value: totalGallons ? totalGallons.toFixed(1) : '—' },
      { label: 'Date', value: route.Service_Date__c || '—' },
    ];
  }, [route]);

  if (!route) return null;

  const color = route._color ?? '#2563eb';
  const routeCompleted = isRouteCompleted(route);
  const completionInProgress = route.CompletionStatus__c === 'In Progress';

  return (
    <div className="flex flex-col gap-2.5 p-4 bg-surface border border-border rounded-xl shadow-sm relative">
      {optimizing && <OverlaySpinner label="Optimizing…" />}

      {/* Header row */}
      <div className="flex items-center gap-3">
        <button
          className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-bg text-txt-secondary hover:text-primary transition"
          onClick={() => selectRoute(null)}
          title="Back to list"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
        </button>
        <div className="w-3 h-3 rounded-sm shrink-0" style={{ background: color }} />
        <h3 className="text-[15px] font-semibold text-txt flex-1 truncate">{route.Name}</h3>
        {route.isAI__c && (
          <span className="inline-flex items-center gap-1 text-[10px] font-bold text-white bg-ai rounded-full px-2 py-0.5">✦ AI</span>
        )}
        {routeCompleted ? (
          <span
            className="inline-flex items-center gap-1 h-7 px-3 rounded-lg bg-success-bg border border-success/30 text-success text-[11px] font-semibold shrink-0"
            title={route.Comment__c || 'Route is already completed'}
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            Route Completed
          </span>
        ) : completionInProgress ? (
          <span className="inline-flex items-center gap-1 h-7 px-3 rounded-lg bg-warning-bg border border-warning/30 text-warning text-[11px] font-semibold shrink-0">
            <span className="w-2 h-2 rounded-full bg-warning animate-pulse" />
            Completing…
          </span>
        ) : (
          <button
            className="h-7 px-3 rounded-lg border border-success/40 text-success text-[11px] font-medium hover:bg-success-bg transition shrink-0"
            onClick={() => openModal('isComplete')}
          >
            Complete
          </button>
        )}
      </div>

      {/* Driver + Date row */}
      <div className="flex items-center gap-3 text-xs text-txt-secondary ml-10">
        <span className="flex items-center gap-1">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0" />
          </svg>
          {driverName || 'Unassigned'}
        </span>
        <span className="flex items-center gap-1">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5" />
          </svg>
          {route.Service_Date__c || '—'}
        </span>
      </div>

      {/* Metrics — row 1: route stats; row 2: live completion / ETA */}
      <div className="flex flex-col gap-1.5 ml-10">
        <div className="flex flex-wrap items-center gap-1.5">
          {metrics.filter((m) => m.label !== 'Date').map((m) => (
            <div key={m.label} className="flex items-center gap-1.5 bg-bg rounded-lg px-2.5 py-1.5">
              <span className="text-[10px] uppercase tracking-wider text-txt-secondary font-medium">{m.label}</span>
              <span className="text-xs font-bold text-txt tabular-nums">{m.value}</span>
            </div>
          ))}
        </div>
        {!routeCompleted && (lastCompletedAt || nextStopEta) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {lastCompletedAt && (
              <div className="flex items-center gap-1.5 bg-bg rounded-lg px-2.5 py-1.5">
                <span className="text-[10px] uppercase tracking-wider text-txt-secondary font-medium">Last Completed</span>
                <span className="text-xs font-bold text-success tabular-nums">{lastCompletedAt}</span>
              </div>
            )}
            {nextStopEta && (
              <div className="flex items-center gap-1.5 bg-bg rounded-lg px-2.5 py-1.5">
                <span className="text-[10px] uppercase tracking-wider text-txt-secondary font-medium">Next Stop ETA</span>
                <span className="text-xs font-bold text-primary tabular-nums">{nextStopEta}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Actions — edit actions hidden once the route is completed; Compare always available */}
      <div className="flex flex-wrap gap-1.5 ml-10">
        {!routeCompleted && (
          <>
            <ActionBtn variant="primary" onClick={() => openModal('isEdit')} icon={ICONS.edit}>Edit</ActionBtn>
            <ActionBtn variant="ai" onClick={handleOptimize} disabled={optimizing} icon={ICONS.optimize}>Optimize</ActionBtn>
            <ActionBtn onClick={() => openModal('isCombine')}>Combine</ActionBtn>
            <ActionBtn onClick={() => openModal('isSplit')}>Split</ActionBtn>
          </>
        )}
        <ActionBtn onClick={openCompare} icon={ICONS.compare} title="Compare with another route">Compare</ActionBtn>
        {!routeCompleted && (
          <ActionBtn variant="ai" onClick={() => openModal('isAIEnhance')} icon={<span className="text-[10px] leading-none">✦</span>}>AI Enhance</ActionBtn>
        )}
      </div>

      {!routeCompleted && (
        <div className="ml-10">
          <AccountTicketSearch mode="add" />
        </div>
      )}

      {routeCompleted && route.Comment__c && (
        <div className="ml-10 text-xs text-txt-secondary bg-bg rounded-lg px-3 py-2 border border-border">
          <span className="font-medium text-txt-secondary">Note: </span>
          {route.Comment__c}
        </div>
      )}
    </div>
  );
}

const BTN_VARIANTS = {
  primary: 'bg-primary text-white hover:bg-primary-hover shadow-sm',
  ai: 'bg-ai text-white hover:bg-ai-hover shadow-sm',
  ghost: 'bg-bg text-txt border border-border hover:bg-border/50',
};

/** Shared route-action button — consistent sizing, icon slot, and colour variants. */
function ActionBtn({ variant = 'ghost', icon, children, className = '', ...props }) {
  return (
    <button
      className={`h-8 px-3 rounded-lg text-xs font-medium transition inline-flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50 ${BTN_VARIANTS[variant]} ${className}`}
      {...props}
    >
      {icon}
      {children}
    </button>
  );
}

const ICON_CLS = 'w-3.5 h-3.5';
const ICONS = {
  edit: (
    <svg className={ICON_CLS} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
    </svg>
  ),
  optimize: (
    <svg className={ICON_CLS} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
    </svg>
  ),
  compare: (
    <svg className={ICON_CLS} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4M16 17H4m0 0l4 4m-4-4l4-4" />
    </svg>
  ),
};
