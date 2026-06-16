import { useEffect } from 'react';
import useStore from '../../store';

const STEP_LABELS = {
  queued: 'Queued',
  discovering: 'Analyzing accounts',
  loading_depots: 'Loading service locations',
  assigning: 'Assigning to depots',
  clustering: 'Clustering by direction',
  optimizing: 'Optimizing routes',
  finalizing: 'Finalizing',
  complete: 'Complete',
  error: 'Error',
  idle: 'Idle',
};

/**
 * Collapsible live progress panel for "Generate by Service Location".
 * The job runs server-side, so closing the panel only hides it — generation
 * continues and the panel rehydrates from the server when reopened.
 */
export default function GenerationProgressPanel() {
  const open = useStore((s) => s.genPanelOpen);
  const status = useStore((s) => s.genStatus);
  const progress = useStore((s) => s.genProgress);
  const result = useStore((s) => s.genResult);
  const error = useStore((s) => s.genError);
  const commitResult = useStore((s) => s.genCommitResult);
  const history = useStore((s) => s.genHistory);
  const jobId = useStore((s) => s.genJobId);

  const hide = useStore((s) => s.hideGenPanel);
  const refresh = useStore((s) => s.refreshGenJob);
  const openReview = useStore((s) => s.openGenReview);

  // On reopen, pull the latest snapshot in case SSE events were missed while hidden.
  useEffect(() => {
    if (open && jobId) refresh();
  }, [open, jobId, refresh]);

  if (!open) return null;

  const counters = progress?.counters || {};
  const percent = Math.max(0, Math.min(100, progress?.percent ?? 0));
  const stepLabel = progress?.label || STEP_LABELS[progress?.step] || '—';
  const routeCount = result?.routes?.length ?? 0;

  return (
    <div className="absolute top-12 right-2 z-[999] w-[400px] max-h-[78vh] bg-surface border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden animate-slide-in">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-bg/50">
        <div className="flex items-center gap-2">
          <span className="text-ai text-sm">✦</span>
          <span className="text-sm font-semibold text-txt">AI Generation</span>
          <StatusPill status={status} />
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={() => refresh()} className="text-txt-secondary hover:text-txt transition p-1 rounded" title="Refresh">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
            </svg>
          </button>
          <button onClick={hide} className="text-txt-secondary hover:text-txt transition p-1 rounded" title="Hide (generation keeps running)">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* Current step + progress bar */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[13px] font-medium text-txt flex items-center gap-2">
              {status === 'running' && <Spinner />}
              {stepLabel}
            </span>
            <span className="text-[11px] text-txt-secondary tabular-nums">{percent}%</span>
          </div>
          <div className="h-2 rounded-full bg-border/60 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${status === 'error' ? 'bg-red-500' : 'bg-ai'}`}
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>

        {error && (
          <div className="text-[12px] text-red-700 bg-red-50 border border-red-200 rounded-lg p-2.5">{error}</div>
        )}

        {/* Live counters */}
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Accounts analyzed" value={counters.accountsAnalyzed} />
          <Stat label="Eligible accounts" value={counters.eligibleFound} />
          <Stat label="Service locations" value={counters.serviceLocationsProcessed} />
          <Stat label="Clusters built" value={counters.clustersBuilt} />
          <Stat label="Routes optimized" value={counters.routesOptimized} sub={counters.routesPlanned != null ? `of ${counters.routesPlanned}` : null} />
          <Stat label="Excluded (radius)" value={counters.accountsExcluded} />
        </div>

        {/* Warnings */}
        {result?.warnings?.length > 0 && (
          <div className="space-y-1">
            {result.warnings.map((w, i) => (
              <div key={i} className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">{w}</div>
            ))}
          </div>
        )}

        {/* Creation progress (after commit) */}
        {commitResult && (
          <div className="text-[12px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg p-2.5">
            Created {commitResult.created} route(s), {commitResult.totalStops} stop(s).
            {commitResult.skipped?.length > 0 && ` ${commitResult.skipped.length} skipped.`}
          </div>
        )}

        {/* Complete → open review */}
        {status === 'complete' && (
          <button
            className="w-full h-9 rounded-lg bg-ai text-white text-[13px] font-medium hover:bg-ai-hover transition"
            onClick={openReview}
          >
            Review {routeCount} generated route{routeCount === 1 ? '' : 's'}
          </button>
        )}

        {/* History */}
        {history.length > 0 && (
          <div>
            <div className="text-[11px] font-semibold text-txt-secondary uppercase tracking-wide mb-1.5">History</div>
            <div className="space-y-1">
              {history.map((h) => (
                <div key={h.jobId} className="flex items-center gap-2 text-[11px] text-txt-secondary px-2 py-1.5 rounded bg-bg/40">
                  <StatusPill status={h.status} small />
                  <span className="text-txt">{h.date}</span>
                  <span>·</span>
                  <span>{h.recordType}</span>
                  <span className="flex-1" />
                  {h.routeCount != null && <span className="tabular-nums">{h.routeCount} routes</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div className="rounded-lg border border-border/70 bg-bg/30 px-3 py-2">
      <div className="text-[18px] font-semibold text-txt tabular-nums leading-tight">
        {value ?? 0}{sub && <span className="text-[11px] text-txt-secondary font-normal ml-1">{sub}</span>}
      </div>
      <div className="text-[10px] text-txt-secondary mt-0.5">{label}</div>
    </div>
  );
}

function StatusPill({ status, small }) {
  const map = {
    running: 'bg-ai/15 text-ai',
    complete: 'bg-emerald-100 text-emerald-700',
    error: 'bg-red-100 text-red-700',
    idle: 'bg-slate-100 text-slate-600',
  };
  const cls = map[status] || map.idle;
  return <span className={`${small ? 'text-[9px] px-1' : 'text-[10px] px-1.5'} py-0.5 rounded-full font-semibold ${cls}`}>{status}</span>;
}

function Spinner() {
  return <span className="w-3.5 h-3.5 border-2 border-ai border-t-transparent rounded-full animate-spin inline-block" />;
}
