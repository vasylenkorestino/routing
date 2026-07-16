import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import useStore from '../../store';
import * as routingApi from '../../api/routing';
import Spinner from '../ui/Spinner';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';
import LastServices from '../shared/LastServices';
import TankSensorData from '../shared/TankSensorData';
import AIProgressSteps from '../shared/AIProgressSteps';
import {
  FLAG_META,
  OUTCOME_LABEL,
  NEEDS_RESOLUTION,
  decide,
  parseReason,
} from '../../utils/routeLogFlags';

const FILTERS = [
  { key: 'ALL', label: 'All' },
  { key: 'ADD', label: 'Add' },
  { key: 'KEEP', label: 'Keep' },
  { key: 'REMOVE', label: 'Remove' },
  { key: 'FLAG', label: 'Flag' },
  { key: 'OVERFLOW', label: 'Overflow' },
];

const fmtDate = (d) => {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return d; }
};

/**
 * Reviews RouteLog__c entries for a route with bulk decisions. Renders either
 * inline on the page (variant="embedded", the default) or as a focused modal
 * (variant="modal"). Shows live AI Enhance progress when a job is running.
 */
export default function AILogsModal({ googleRouteId, routeName, variant = 'embedded', onTogglePop }) {
  const resolveRouteLogs = useStore((s) => s.resolveRouteLogs);
  const fetchRouteLogs = useStore((s) => s.fetchRouteLogs);
  const logs = useStore((s) => s.routeLogs);
  const loading = useStore((s) => s.routeLogsLoading);
  const approving = useStore((s) => s.routeLogsApproving);
  const summary = useStore((s) => s.routeLogsSummary);
  const setRouteLogsSummary = useStore((s) => s.setRouteLogsSummary);
  const clearRouteLogsSummary = useStore((s) => s.clearRouteLogsSummary);

  const setMapCenter = useStore((s) => s.setMapCenter);
  const setMapZoom = useStore((s) => s.setMapZoom);
  const route = useStore((s) => s.route);

  const aiJobType = useStore((s) => s.aiJobType);
  const aiJobStatus = useStore((s) => s.aiJobStatus);
  const aiJobMeta = useStore((s) => s.aiJobMeta);
  const aiJobSteps = useStore((s) => s.aiJobSteps);
  const aiJobFindings = useStore((s) => s.aiJobFindings);
  const aiJobProgress = useStore((s) => s.aiJobProgress);
  const aiJobResult = useStore((s) => s.aiJobResult);
  const aiJobError = useStore((s) => s.aiJobError);
  const aiJobPartialResults = useStore((s) => s.aiJobPartialResults);
  const clearAIJob = useStore((s) => s.clearAIJob);
  const refreshAIJob = useStore((s) => s.refreshAIJob);
  const aiJobId = useStore((s) => s.aiJobId);

  const isModal = variant === 'modal';
  const jobForRoute = aiJobType === 'enhance' && aiJobMeta?.googleRouteId === googleRouteId;
  const analyzing = jobForRoute && (aiJobStatus === 'running' || aiJobStatus === 'queued');
  const stopsReady = !!(analyzing && (aiJobPartialResults?.stopsSaved || aiJobPartialResults?.stage === 'stops_ready'));

  const routeAccountIds = useMemo(() => {
    const stops = route?.Routes__r?.records ?? route?.Routes__r ?? route?.points ?? [];
    const ids = new Set();
    (Array.isArray(stops) ? stops : []).forEach((s) => {
      if (s.AccountId__c) ids.add(s.AccountId__c);
      if (s.Account__c) ids.add(s.Account__c);
    });
    return ids;
  }, [route]);

  const [filter, setFilter] = useState('ALL');
  const [sortKey, setSortKey] = useState('flag');
  const [selected, setSelected] = useState(() => new Set());
  const [expandedComments, setExpandedComments] = useState({});
  const [detailLog, setDetailLog] = useState(null);
  const [detailTab, setDetailTab] = useState('services');
  const [collapsed, setCollapsed] = useState(true);
  const handledCompleteRef = useRef(null);
  const handledStopsReadyRef = useRef(null);

  useEffect(() => {
    fetchRouteLogs(googleRouteId);
    clearRouteLogsSummary();
    setSelected(new Set());
    setDetailLog(null);
    handledStopsReadyRef.current = null;
  }, [googleRouteId, fetchRouteLogs, clearRouteLogsSummary]);

  // Auto-expand while AI Enhance is analyzing this route.
  useEffect(() => {
    if (analyzing) setCollapsed(false);
  }, [analyzing]);

  // Stage 1 ready: load stop RouteLogs + summary while adds still run in the background.
  useEffect(() => {
    if (!jobForRoute || !aiJobId || !stopsReady) return;
    if (handledStopsReadyRef.current === aiJobId) return;
    handledStopsReadyRef.current = aiJobId;
    if (aiJobPartialResults?.summary) setRouteLogsSummary(aiJobPartialResults.summary);
    fetchRouteLogs(googleRouteId);
  }, [
    jobForRoute, aiJobId, stopsReady, aiJobPartialResults?.summary,
    googleRouteId, fetchRouteLogs, setRouteLogsSummary,
  ]);

  // On job complete: show summary, refresh logs, clear job tracking.
  useEffect(() => {
    if (!jobForRoute || !aiJobId) return;
    if (aiJobStatus === 'complete' && aiJobResult) {
      if (handledCompleteRef.current === aiJobId) return;
      handledCompleteRef.current = aiJobId;
      setRouteLogsSummary(aiJobResult.summary || '');
      fetchRouteLogs(googleRouteId);
      clearAIJob();
      setCollapsed(false);
      toast.success('AI Enhance complete');
    } else if (aiJobStatus === 'error') {
      if (handledCompleteRef.current === `err:${aiJobId}`) return;
      handledCompleteRef.current = `err:${aiJobId}`;
      toast.error(aiJobError || 'Analysis failed');
      clearAIJob();
    }
  }, [
    jobForRoute, aiJobId, aiJobStatus, aiJobResult, aiJobError,
    googleRouteId, fetchRouteLogs, setRouteLogsSummary, clearAIJob,
  ]);

  const decorated = useMemo(() => logs.map((l) => ({ ...l, ...parseReason(l.Reason__c) })), [logs]);

  const counts = useMemo(() => {
    const c = { ALL: decorated.length, ADD: 0, KEEP: 0, REMOVE: 0, FLAG: 0, OVERFLOW: 0 };
    decorated.forEach((l) => { c[l.flag] = (c[l.flag] || 0) + 1; });
    return c;
  }, [decorated]);

  const visible = useMemo(() => {
    let list = filter === 'ALL' ? decorated : decorated.filter((l) => l.flag === filter);
    const flagOrder = ['REMOVE', 'OVERFLOW', 'FLAG', 'ADD', 'KEEP'];
    list = [...list].sort((a, b) => {
      if (sortKey === 'flag') return flagOrder.indexOf(a.flag) - flagOrder.indexOf(b.flag);
      if (sortKey === 'confidence') return (b.Confidence__c || 0) - (a.Confidence__c || 0);
      return new Date(b.CreatedDate) - new Date(a.CreatedDate);
    });
    return list;
  }, [decorated, filter, sortKey]);

  const pendingVisible = useMemo(() => visible.filter((l) => l.Status__c === 'Proposed'), [visible]);
  const allSelected = pendingVisible.length > 0 && pendingVisible.every((l) => selected.has(l.Id));
  const pendingTotal = decorated.filter((l) => l.Status__c === 'Proposed').length;

  const toggleSelect = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const selectAll = () => setSelected(allSelected ? new Set() : new Set(pendingVisible.map((l) => l.Id)));
  const toggleComments = (id) => setExpandedComments((p) => ({ ...p, [id]: !p[id] }));

  /** Selecting a row focuses the account on the map and opens its Last Services detail. */
  const openLog = useCallback((log) => {
    setDetailLog((prev) => (prev?.Id === log.Id ? null : log));
    setDetailTab('services');
    const lat = Number(log.Account__r?.MALatitude__c);
    const lng = Number(log.Account__r?.MALongitude__c);
    if (!Number.isNaN(lat) && !Number.isNaN(lng) && (lat !== 0 || lng !== 0)) {
      setMapCenter({ lat, lng });
      setMapZoom(15);
    }
  }, [setMapCenter, setMapZoom]);

  const applyResolutions = useCallback(async (items) => {
    if (!items.length) return;
    try {
      await resolveRouteLogs(items);
      setSelected((prev) => {
        const n = new Set(prev);
        items.forEach((i) => n.delete(i.logId));
        return n;
      });
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }, [resolveRouteLogs]);

  const decideOne = (log, decision) => {
    const outcome = decide(log.flag, decision);
    if (!outcome) return;
    applyResolutions([{ logId: log.Id, outcome }]);
  };

  /**
   * Bulk approve/decline using the same per-flag semantics as each card
   * (e.g. REMOVE + Approve → remove stop; REMOVE + Decline → keep stop).
   */
  const bulkDecide = (decision) => {
    const targets = selected.size > 0 ? pendingVisible.filter((l) => selected.has(l.Id)) : pendingVisible;
    const items = targets.map((l) => {
      let outcome = decide(l.flag, decision);
      if (!outcome) {
        // FLAG / OVERFLOW — fall back to membership-based resolution.
        const inRoute = !!l.Account__c && routeAccountIds.has(l.Account__c);
        outcome = decision === 'approve' ? (inRoute ? 'keep' : 'add') : (inRoute ? 'remove' : 'ignore');
      }
      return { logId: l.Id, outcome };
    });
    applyResolutions(items);
  };

  const selectedCount = selected.size;
  const showBody = isModal || !collapsed;

  const header = (
    <div className="flex items-center justify-between px-3 py-1.5 border-b border-border shrink-0">
      <div className="flex items-center gap-1.5 min-w-0">
        {!isModal && (
          <button onClick={() => setCollapsed((c) => !c)} className="text-txt-secondary hover:text-txt transition" title={collapsed ? 'Expand' : 'Collapse'}>
            <svg className={`w-3 h-3 transition-transform ${collapsed ? '' : 'rotate-90'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
          </button>
        )}
        <span className="text-ai text-xs">✦</span>
        <h3 className="text-[12px] font-semibold text-txt">AI Logs</h3>
        {routeName && <span className="text-[10px] text-txt-secondary bg-bg px-1.5 py-0.5 rounded truncate">{routeName}</span>}
        {analyzing && !stopsReady && <span className="text-[10px] font-semibold text-ai bg-ai/10 px-1.5 py-0.5 rounded-full shrink-0">Analyzing…</span>}
        {analyzing && stopsReady && <span className="text-[10px] font-semibold text-ai bg-ai/10 px-1.5 py-0.5 rounded-full shrink-0">Finding adds…</span>}
        {!analyzing && pendingTotal > 0 && <span className="text-[10px] font-semibold text-warning bg-warning/10 px-1.5 py-0.5 rounded-full shrink-0">{pendingTotal} pending</span>}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={onTogglePop}
          className="w-7 h-7 flex items-center justify-center rounded-lg text-txt-secondary hover:text-txt hover:bg-bg transition"
          title={isModal ? 'Dock to page' : 'Pop out to modal'}
        >
          {isModal ? (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M15 9V4.5M15 9h4.5M15 9l5.25-5.25M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 15v4.5m0-4.5h4.5m-4.5 0l5.25 5.25" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M20.25 20.25v-4.5m0 4.5h-4.5m4.5 0L15 15M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75v4.5m0-4.5h-4.5m4.5 0L15 9" />
            </svg>
          )}
        </button>
        {isModal && (
          <button onClick={onTogglePop} className="w-7 h-7 flex items-center justify-center rounded-lg text-txt-secondary hover:text-txt hover:bg-bg transition text-lg leading-none" title="Dock to page">×</button>
        )}
      </div>
    </div>
  );

  const progressBanner = (
    <div className="px-3 py-2 border-b border-border shrink-0 space-y-2 bg-ai-bg/30">
      <AIProgressSteps
        steps={aiJobSteps}
        findings={stopsReady ? [] : aiJobFindings}
        progress={aiJobProgress}
        status={aiJobStatus}
        compact
      />
      <div className="flex items-center justify-between gap-2">
        <button type="button" className="text-[11px] text-txt-secondary hover:text-txt" onClick={() => refreshAIJob()}>
          Refresh progress
        </button>
        {stopsReady && (
          <span className="text-[10px] text-ai font-medium">
            Stop recommendations ready — you can review while adds continue
          </span>
        )}
      </div>
    </div>
  );

  const listBody = (
    <>
      {summary && (
        <div className="px-3 py-2 border-b border-border bg-ai-bg/40 shrink-0">
          <div className="text-[10px] font-semibold text-ai uppercase tracking-wider mb-0.5">AI Summary</div>
          <p className="text-[11px] text-txt leading-relaxed">{summary}</p>
        </div>
      )}

      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border shrink-0 flex-wrap">
        {FILTERS.map((f) => (
          <FilterChip key={f.key} flag={f.key} label={f.label} count={counts[f.key] || 0} active={filter === f.key} onClick={() => setFilter(f.key)} />
        ))}
        <div className="flex-1" />
        <label className="text-[10px] text-txt-secondary">Sort</label>
        <select
          className="h-6 text-[11px] rounded-md border border-border bg-surface px-1.5 focus:border-primary focus:outline-none"
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value)}
        >
          <option value="flag">Flag</option>
          <option value="newest">Newest</option>
          <option value="confidence">Confidence</option>
        </select>
      </div>

      {!loading && pendingVisible.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-bg/40 shrink-0">
          <Checkbox checked={allSelected} indeterminate={selectedCount > 0 && !allSelected} onChange={selectAll} />
          <button className="text-[11px] font-medium text-txt hover:text-primary transition" onClick={selectAll}>
            {allSelected ? 'Deselect all' : 'Select all'}
          </button>
          <span className="text-[10px] text-txt-secondary">{selectedCount} selected</span>
        </div>
      )}

      <div className={`overflow-auto p-2.5 ${isModal ? 'flex-1' : 'max-h-[40vh]'}`}>
        {loading ? (
          <div className="flex items-center justify-center py-10 gap-2"><Spinner size="sm" /><span className="text-[12px] text-txt-secondary">Loading logs…</span></div>
        ) : visible.length === 0 ? (
          <div className="text-[12px] text-txt-secondary text-center py-10">No AI logs{filter !== 'ALL' ? ' for this flag' : ' for this route'}.</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {visible.map((log) => (
              <LogCard
                key={log.Id}
                log={log}
                inRoute={!!log.Account__c && routeAccountIds.has(log.Account__c)}
                selected={selected.has(log.Id)}
                approving={!!approving[log.Id]}
                commentsOpen={!!expandedComments[log.Id]}
                detailOpen={detailLog?.Id === log.Id}
                detailTab={detailTab}
                onToggleSelect={() => toggleSelect(log.Id)}
                onDecide={(decision) => decideOne(log, decision)}
                onResolve={(outcome) => applyResolutions([{ logId: log.Id, outcome }])}
                onToggleComments={() => toggleComments(log.Id)}
                onOpen={() => openLog(log)}
                onDetailTab={setDetailTab}
              />
            ))}
          </div>
        )}
      </div>

      {!loading && pendingVisible.length > 0 && (
        <div className="flex items-center justify-between px-3 py-1.5 border-t border-border bg-bg/50 shrink-0">
          <span className="text-[10px] text-txt-secondary">
            {selectedCount > 0 ? `Acting on ${selectedCount} selected` : `Acting on all ${pendingVisible.length} visible pending`}
          </span>
          <div className="flex gap-1.5">
            <button
              className="h-7 px-3 rounded-md bg-success text-white text-[11px] font-medium hover:bg-success/90 transition disabled:opacity-40"
              disabled={pendingVisible.length === 0}
              onClick={() => bulkDecide('approve')}
            >
              Approve All{selectedCount > 0 ? ' (Selected)' : ''}
            </button>
            <button
              className="h-7 px-3 rounded-md bg-error text-white text-[11px] font-medium hover:bg-error/90 transition disabled:opacity-40"
              disabled={pendingVisible.length === 0}
              onClick={() => bulkDecide('decline')}
            >
              Decline All{selectedCount > 0 ? ' (Selected)' : ''}
            </button>
          </div>
        </div>
      )}
    </>
  );

  // Keep existing Route Logs visible during analysis; progress sits above the list.
  const body = analyzing
    ? (
      <>
        {progressBanner}
        {listBody}
      </>
    )
    : listBody;

  const inner = (
    <>
      {header}
      {showBody && body}
    </>
  );

  if (isModal) {
    return (
      <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/40" onClick={onTogglePop}>
        <div className="w-[820px] max-w-[96vw] max-h-[88vh] bg-surface rounded-xl shadow-2xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
          {inner}
        </div>
      </div>
    );
  }

  return <div className="bg-surface border border-border rounded-lg flex flex-col overflow-hidden">{inner}</div>;
}

const RESOLUTION_OPTIONS = {
  add: { o: 'add', label: 'Add', cls: 'text-ai border-ai/30 hover:bg-ai/10' },
  keep: { o: 'keep', label: 'Keep', cls: 'text-success border-success/30 hover:bg-success/10' },
  remove: { o: 'remove', label: 'Remove', cls: 'text-error border-error/30 hover:bg-error/10' },
  ignore: { o: 'ignore', label: 'Ignore', cls: 'text-txt-secondary border-border hover:bg-bg' },
};

function LogCard({ log, inRoute, selected, approving, commentsOpen, detailOpen, detailTab, onToggleSelect, onDecide, onResolve, onToggleComments, onOpen, onDetailTab }) {
  const meta = FLAG_META[log.flag] || FLAG_META.FLAG;
  const isPending = log.Status__c === 'Proposed';
  const needsResolution = NEEDS_RESOLUTION.has(log.flag);
  const approveOutcome = decide(log.flag, 'approve');
  const declineOutcome = decide(log.flag, 'decline');
  const clickable = !!log.Account__c;
  const resolutionKeys = inRoute ? ['keep', 'remove'] : ['add'];

  return (
    <div className={`rounded-lg border transition ${isPending ? 'border-border bg-surface' : 'border-border/60 bg-bg/40 opacity-70'} ${detailOpen ? 'ring-1 ring-primary/40' : selected ? 'ring-1 ring-primary/20' : ''}`}>
      <div
        className={`flex items-start gap-2 p-2 ${clickable ? 'cursor-pointer hover:bg-bg/40' : ''}`}
        onClick={() => clickable && onOpen()}
      >
        {isPending ? (
          <div className="pt-0.5" onClick={(e) => e.stopPropagation()}><Checkbox checked={selected} onChange={onToggleSelect} /></div>
        ) : (
          <div className="w-3.5" />
        )}

        <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded mt-px shrink-0 border ${meta.badge}`}>{meta.label}</span>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`text-[11px] font-medium text-txt ${clickable ? 'group-hover:text-primary' : ''}`}>{log.Account__r?.Name || log.Name}</span>
            {log.Confidence__c != null && (
              <span className="text-[9px] text-txt-secondary bg-bg px-1 py-0.5 rounded tabular-nums">{Math.round(log.Confidence__c * 100)}%</span>
            )}
            <span className="text-[9px] text-txt-secondary">{log.Name}</span>
            <span className="text-[9px] text-border tabular-nums">{fmtDate(log.CreatedDate)}</span>
          </div>
          <p className="text-[11px] text-txt-secondary mt-0.5 leading-snug">{log.text}</p>

          {isPending ? (
            !needsResolution ? (
              <div className="text-[9px] text-txt-secondary mt-1">
                Approve = <span className="font-semibold text-txt">{OUTCOME_LABEL[approveOutcome]}</span>
                <span className="mx-1">·</span>
                Decline = <span className="font-semibold text-txt">{OUTCOME_LABEL[declineOutcome]}</span>
              </div>
            ) : (
              <div className="text-[9px] text-warning mt-1 font-medium">Needs a manager decision</div>
            )
          ) : (
            <div className="text-[9px] text-txt-secondary mt-0.5 italic">
              {log._outcome ? `${OUTCOME_LABEL[log._outcome]} · ` : ''}
              {log.Status__c === 'Declined' ? 'Declined' : 'Approved'}
              {log.Accepted_By__c ? ` by ${log.Accepted_By__c}` : ''}
              {log.Accepted_Date__c ? ` · ${fmtDate(log.Accepted_Date__c)}` : ''}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          <CommentButton open={commentsOpen} count={log.CommentCount__c} onClick={onToggleComments} />
          {isPending && !needsResolution && (
            <>
              <button className="h-6 px-2 text-[10px] font-medium rounded-md bg-success/10 text-success border border-success/30 hover:bg-success/20 transition disabled:opacity-50" onClick={() => onDecide('approve')} disabled={approving}>
                {approving ? '…' : 'Approve'}
              </button>
              <button className="h-6 px-2 text-[10px] font-medium rounded-md bg-error/10 text-error border border-error/30 hover:bg-error/20 transition disabled:opacity-50" onClick={() => onDecide('decline')} disabled={approving}>
                Decline
              </button>
            </>
          )}
        </div>
      </div>

      {isPending && needsResolution && (
        <div className="flex items-center gap-1.5 px-2 pb-2 pl-10 flex-wrap">
          <span className="text-[9px] text-txt-secondary uppercase tracking-wide">Decide:</span>
          <span className="text-[9px] text-txt-secondary">{inRoute ? '(in route)' : '(not in route)'}</span>
          {resolutionKeys.map((k) => {
            const b = RESOLUTION_OPTIONS[k];
            return (
              <button
                key={b.o}
                className={`h-6 px-2 text-[10px] font-medium rounded-md border bg-surface transition disabled:opacity-50 ${b.cls}`}
                onClick={() => onResolve(b.o)}
                disabled={approving}
              >
                {b.label}
              </button>
            );
          })}
        </div>
      )}

      {commentsOpen && <LogCommentThread routeLogId={log.Id} />}

      {detailOpen && log.Account__c && (
        <div className="border-t border-border">
          <div className="flex items-center border-b border-border bg-bg/50">
            {[{ key: 'services', label: 'Last Services' }, { key: 'tanks', label: 'Tank & Sensor' }].map((t) => (
              <button
                key={t.key}
                className={`px-2.5 py-1 text-[10px] font-semibold transition border-b-2 ${detailTab === t.key ? 'border-primary text-primary' : 'border-transparent text-txt-secondary hover:text-txt'}`}
                onClick={() => onDetailTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
          {detailTab === 'services' && <LastServices accountId={log.Account__c} accountName={log.Account__r?.Name} />}
          {detailTab === 'tanks' && <TankSensorData accountId={log.Account__c} accountName={log.Account__r?.Name} />}
        </div>
      )}
    </div>
  );
}

function FilterChip({ flag, label, count, active, onClick }) {
  const meta = FLAG_META[flag];
  return (
    <button
      className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium border transition ${active ? 'bg-txt text-white border-txt' : 'bg-surface text-txt-secondary border-border hover:bg-bg'}`}
      onClick={onClick}
    >
      {meta && <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />}
      <span>{label}</span>
      <span className="font-bold tabular-nums">{count}</span>
    </button>
  );
}

function Checkbox({ checked, indeterminate, onChange }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = !!indeterminate; }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
      className="w-3.5 h-3.5 accent-primary rounded cursor-pointer"
    />
  );
}

function CommentButton({ open, count, onClick }) {
  return (
    <button
      className={`relative h-6 px-1.5 text-[10px] font-medium rounded-md border transition ${open ? 'bg-ai/10 text-ai border-ai/30' : 'bg-surface text-txt-secondary border-border hover:bg-bg'}`}
      onClick={onClick}
      title="Comments"
    >
      <svg className="w-3 h-3 inline-block" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
      </svg>
      {count > 0 && (
        <span className="absolute -top-1.5 -right-1.5 min-w-[15px] h-[15px] flex items-center justify-center text-[8px] font-bold rounded-full bg-ai text-white leading-none px-0.5">{count}</span>
      )}
    </button>
  );
}

function LogCommentThread({ routeLogId }) {
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [text, setText] = useState('');
  const bottomRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const data = await routingApi.getRouteLogComments(routeLogId);
        if (!cancelled) setComments(Array.isArray(data) ? data : []);
      } catch { if (!cancelled) setComments([]); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [routeLogId]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [comments.length]);

  const handleSend = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setText('');
    try {
      const { humanComment, aiReply } = await routingApi.addRouteLogComment(routeLogId, body);
      const now = new Date().toISOString();
      setComments((prev) => [
        ...prev,
        { ...humanComment, CreatedDate: now },
        ...(aiReply ? [{ ...aiReply, CreatedDate: now }] : []),
      ]);
    } catch (err) { toast.error(getErrorMessage(err)); }
    finally { setSending(false); }
  };

  const fmtTime = (d) => {
    if (!d) return '';
    try { return new Date(d).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
  };

  if (loading) return <div className="flex items-center gap-2 py-3 px-3 border-t border-border/50"><Spinner size="sm" /><span className="text-[10px] text-txt-secondary">Loading comments…</span></div>;

  return (
    <div className="bg-bg/60 border-t border-border/50 px-3 py-2">
      {comments.length === 0 && !sending && (
        <p className="text-[10px] text-txt-secondary mb-2">No comments yet. Start the discussion below.</p>
      )}
      <div className="max-h-48 overflow-auto space-y-1.5 mb-2">
        {comments.map((c, i) => (
          <div key={c.Id || i} className={`flex ${c.Is_AI__c ? 'justify-start' : 'justify-end'}`}>
            <div className={`max-w-[85%] rounded-lg px-2.5 py-1.5 ${c.Is_AI__c ? 'bg-ai/10 border border-ai/20' : 'bg-primary/10 border border-primary/20'}`}>
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className={`text-[9px] font-bold uppercase ${c.Is_AI__c ? 'text-ai' : 'text-primary'}`}>{c.Is_AI__c ? '✦ AI' : c.Author__c || 'You'}</span>
                <span className="text-[9px] text-txt-secondary">{fmtTime(c.CreatedDate)}</span>
              </div>
              <p className="text-[11px] text-txt leading-snug whitespace-pre-wrap">{c.Body__c}</p>
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex justify-start">
            <div className="bg-ai/10 border border-ai/20 rounded-lg px-2.5 py-1.5 flex items-center gap-1.5">
              <Spinner size="xs" /><span className="text-[10px] text-ai">AI is thinking…</span>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <div className="flex gap-1.5">
        <input
          className="flex-1 h-7 text-[11px] rounded border border-border bg-surface px-2 focus:border-primary focus:outline-none placeholder:text-txt-secondary/50"
          placeholder="Add a comment…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
          disabled={sending}
        />
        <button
          className="h-7 px-2.5 text-[10px] font-medium rounded bg-primary text-white hover:bg-primary/90 transition disabled:opacity-50"
          onClick={handleSend}
          disabled={!text.trim() || sending}
        >
          Send
        </button>
      </div>
    </div>
  );
}
