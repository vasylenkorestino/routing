import { useMemo, useState, useCallback } from 'react';
import useStore from '../../store';
import * as routingApi from '../../api/routing';
import AccountTicketSearch from '../shared/AccountTicketSearch';
import { OverlaySpinner } from '../ui/Spinner';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';

/** Route header card — shows key metrics and action buttons for the selected route */
export default function RouteCard({ route }) {
  const openModal = useStore((st) => st.openModal);
  const openCompare = useStore((st) => st.openCompare);
  const selectRoute = useStore((st) => st.selectRoute);
  const refreshRoutes = useStore((st) => st.refreshRoutes);
  const drivers = useStore((st) => st.drivers);
  const [optimizing, setOptimizing] = useState(false);

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
    const timeStr = route.Total_Time__c || '—';
    return [
      { label: 'Distance', value: distStr },
      { label: 'Time', value: timeStr },
      { label: 'Stops', value: stops.length },
      { label: 'Gallons', value: totalGallons ? totalGallons.toFixed(1) : '—' },
      { label: 'Date', value: route.Service_Date__c || '—' },
    ];
  }, [route]);

  if (!route) return null;

  const color = route._color ?? '#2563eb';
  const routeCompleted = !!route.Driver_Completed__c;
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

      {/* Metrics */}
      <div className="flex items-center gap-1 ml-10">
        {metrics.filter((m) => m.label !== 'Date').map((m) => (
          <div key={m.label} className="flex items-center gap-1.5 bg-bg rounded-lg px-2.5 py-1.5">
            <span className="text-[10px] uppercase tracking-wider text-txt-secondary font-medium">{m.label}</span>
            <span className="text-xs font-bold text-txt tabular-nums">{m.value}</span>
          </div>
        ))}
        <button
          className="h-7 px-3 rounded-lg border border-border text-txt text-[11px] font-medium hover:bg-bg transition ml-auto flex items-center gap-1"
          onClick={openCompare}
          title="Compare with another route"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4M16 17H4m0 0l4 4m-4-4l4-4" />
          </svg>
          Compare
        </button>
      </div>

      {/* Actions — disabled once the route is completed (matches LWC routingApplication.routeCompleted) */}
      {!routeCompleted && (
        <>
          <div className="flex gap-1.5 flex-wrap ml-10">
            <button className="h-7 px-3 rounded-lg bg-primary text-white text-[11px] font-semibold hover:bg-primary-hover transition" onClick={() => openModal('isEdit')}>Edit</button>
            <button className="h-7 px-3 rounded-lg bg-ai text-white text-[11px] font-medium hover:bg-ai-hover transition" onClick={handleOptimize} disabled={optimizing}>Optimize</button>
            <button className="h-7 px-3 rounded-lg border border-border text-txt text-[11px] font-medium hover:bg-bg transition" onClick={() => openModal('isCombine')}>Combine</button>
            <button className="h-7 px-3 rounded-lg border border-border text-txt text-[11px] font-medium hover:bg-bg transition" onClick={() => openModal('isSplit')}>Split</button>
            <button className="h-7 px-3 rounded-lg bg-ai text-white text-[11px] font-medium hover:bg-ai-hover transition flex items-center gap-1" onClick={() => openModal('isAIEnhance')}>
              <span className="text-[9px]">✦</span> AI Enhance
            </button>
          </div>

          <div className="ml-10">
            <AccountTicketSearch mode="add" />
          </div>
        </>
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
