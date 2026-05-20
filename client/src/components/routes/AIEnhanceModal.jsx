import { useState, useCallback } from 'react';
import useStore from '../../store';
import * as routingApi from '../../api/routing';
import { OverlaySpinner } from '../ui/Spinner';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';

const ACTION_STYLE = {
  keep: { bg: 'bg-success/10', border: 'border-success/30', text: 'text-success', label: 'Keep' },
  remove: { bg: 'bg-error/10', border: 'border-error/30', text: 'text-error', label: 'Remove' },
  flag: { bg: 'bg-warning/10', border: 'border-warning/30', text: 'text-warning', label: 'Review' },
  add: { bg: 'bg-ai/10', border: 'border-ai/30', text: 'text-ai', label: 'Add' },
};

export default function AIEnhanceModal() {
  const route = useStore((s) => s.route);
  const closeModal = useStore((s) => s.closeModal);
  const [phase, setPhase] = useState('idle');
  const [summary, setSummary] = useState('');
  const [existing, setExisting] = useState([]);
  const [additions, setAdditions] = useState([]);
  const [totalStops, setTotalStops] = useState(0);
  const [nearbyCount, setNearbyCount] = useState(0);
  const [approving, setApproving] = useState({});
  const [filter, setFilter] = useState(null);
  const [expandExisting, setExpandExisting] = useState(true);
  const [expandAdds, setExpandAdds] = useState(true);

  const allRecs = [...existing, ...additions];

  const handleAnalyze = useCallback(async () => {
    if (!route?.Id) return;
    setPhase('analyzing');
    setFilter(null);
    try {
      const data = await routingApi.enhanceRoute({ googleRouteId: route.Id });
      setSummary(data.summary || '');
      setExisting(data.existingStops || []);
      setAdditions(data.suggestedAdds || []);
      setTotalStops(data.totalStops || 0);
      setNearbyCount(data.nearbyCount || 0);
      setPhase('results');
    } catch (err) {
      toast.error(getErrorMessage(err));
      setPhase('idle');
    }
  }, [route]);

  const refreshRoutes = useStore((s) => s.refreshRoutes);

  const handleApprove = useCallback(async (logId, status) => {
    setApproving((p) => ({ ...p, [logId]: true }));
    try {
      const res = await routingApi.approveRouteLogs({ logIds: [logId], status });
      const update = (list) => list.map((r) => r.logId === logId ? { ...r, _status: status } : r);
      setExisting(update);
      setAdditions(update);
      if (res?.added?.length) refreshRoutes?.();
    } catch (err) { toast.error(getErrorMessage(err)); }
    finally { setApproving((p) => ({ ...p, [logId]: false })); }
  }, [refreshRoutes]);

  const handleApproveAll = useCallback(async () => {
    const pendingIds = allRecs.filter((r) => r.logId && r._status !== 'Accepted' && r._status !== 'Declined').map((r) => r.logId);
    if (!pendingIds.length) return;
    setApproving((p) => { const n = { ...p }; pendingIds.forEach((id) => { n[id] = true; }); return n; });
    try {
      const res = await routingApi.approveRouteLogs({ logIds: pendingIds, status: 'Accepted' });
      const update = (list) => list.map((r) => pendingIds.includes(r.logId) ? { ...r, _status: 'Accepted' } : r);
      setExisting(update);
      setAdditions(update);
      toast.success(`${pendingIds.length} approved`);
      if (res?.added?.length) refreshRoutes?.();
    } catch (err) { toast.error(getErrorMessage(err)); }
    finally { setApproving({}); }
  }, [allRecs, refreshRoutes]);

  const close = () => closeModal('isAIEnhance');

  const kept = existing.filter((r) => r.action === 'keep').length;
  const flagged = existing.filter((r) => r.action === 'remove' || r.action === 'flag').length;

  const applyFilter = (list) => {
    if (!filter) return list;
    if (filter === 'keep') return list.filter((r) => r.action === 'keep');
    if (filter === 'flagged') return list.filter((r) => r.action === 'remove' || r.action === 'flag');
    if (filter === 'add') return list.filter((r) => r.action === 'add');
    return list;
  };

  const filteredExisting = applyFilter(existing);
  const filteredAdds = filter === 'keep' || filter === 'flagged' ? [] : applyFilter(additions);
  const showExisting = filter !== 'add';
  const showAdds = filter !== 'keep' && filter !== 'flagged';

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40" onClick={close}>
      <div className="w-[720px] max-w-[95vw] max-h-[85vh] bg-surface rounded-xl shadow-2xl flex flex-col overflow-hidden relative" onClick={(e) => e.stopPropagation()}>
        {phase === 'analyzing' && <OverlaySpinner label="AI is analyzing your route…" />}

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-ai text-sm">✦</span>
            <h3 className="text-[15px] font-semibold text-txt">AI Route Analysis</h3>
            {route && <span className="text-xs text-txt-secondary bg-bg px-2 py-0.5 rounded">{route.Name}</span>}
          </div>
          <button onClick={close} className="text-txt-secondary hover:text-txt text-lg leading-none">×</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-5">
          {phase === 'idle' && (
            <div className="flex flex-col items-center justify-center py-12 gap-4 text-center">
              <div className="w-16 h-16 rounded-full bg-ai/10 flex items-center justify-center">
                <span className="text-ai text-2xl">✦</span>
              </div>
              <p className="text-sm font-medium text-txt">Analyze Route Stops</p>
              <p className="text-xs text-txt-secondary max-w-sm">
                AI will review each stop and recommend keeps, removals, and new accounts to add.
              </p>
              <button className="h-9 px-5 rounded-lg bg-ai text-white text-[13px] font-medium hover:bg-ai-hover transition" onClick={handleAnalyze}>
                Start Analysis
              </button>
            </div>
          )}

          {phase === 'results' && (
            <div className="flex flex-col gap-3">
              {summary && (
                <div className="p-3 bg-ai-bg border border-ai/20 rounded-lg">
                  <div className="text-[11px] font-semibold text-ai uppercase tracking-wider mb-1">AI Summary</div>
                  <p className="text-[13px] text-txt leading-relaxed">{summary}</p>
                </div>
              )}

              {/* Clickable filter chips */}
              <div className="flex gap-1.5 flex-wrap">
                <FilterChip label="All Stops" value={totalStops} active={filter === null} onClick={() => setFilter(null)} color="bg-bg text-txt" activeColor="bg-txt text-white" />
                <FilterChip label="Keep" value={kept} active={filter === 'keep'} onClick={() => setFilter(filter === 'keep' ? null : 'keep')} color="bg-success/10 text-success" activeColor="bg-success text-white" />
                <FilterChip label="Remove / Flag" value={flagged} active={filter === 'flagged'} onClick={() => setFilter(filter === 'flagged' ? null : 'flagged')} color="bg-error/10 text-error" activeColor="bg-error text-white" />
                <FilterChip label="Suggested Adds" value={additions.length} active={filter === 'add'} onClick={() => setFilter(filter === 'add' ? null : 'add')} color="bg-ai/10 text-ai" activeColor="bg-ai text-white" />
                <div className="flex items-center text-[10px] text-txt-secondary bg-bg px-2 py-1 rounded">
                  {nearbyCount} nearby scanned
                </div>
              </div>

              {/* Existing Stops — collapsible */}
              {showExisting && filteredExisting.length > 0 && (
                <Section
                  title="Existing Stops"
                  count={filteredExisting.length}
                  expanded={expandExisting}
                  onToggle={() => setExpandExisting((p) => !p)}
                >
                  {filteredExisting.map((rec, i) => (
                    <RecCard key={rec.logId || `e-${i}`} rec={rec} approving={approving} onApprove={handleApprove} />
                  ))}
                </Section>
              )}

              {/* Suggested Additions — collapsible */}
              {showAdds && filteredAdds.length > 0 && (
                <Section
                  title="✦ Suggested Additions"
                  count={filteredAdds.length}
                  expanded={expandAdds}
                  onToggle={() => setExpandAdds((p) => !p)}
                  accent
                >
                  {filteredAdds.map((rec, i) => (
                    <RecCard key={rec.logId || `a-${i}`} rec={rec} approving={approving} onApprove={handleApprove} />
                  ))}
                </Section>
              )}

              {showAdds && additions.length === 0 && nearbyCount > 0 && (
                <div className="text-xs text-txt-secondary text-center py-2">No additional accounts recommended</div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        {phase === 'results' && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-border bg-bg/50 shrink-0">
            <button className="h-8 px-4 rounded-lg bg-ai text-white text-[12px] font-medium hover:bg-ai-hover transition" onClick={handleAnalyze}>
              Re-analyze
            </button>
            <div className="flex gap-2">
              <button className="h-8 px-4 rounded-lg bg-success text-white text-[12px] font-medium hover:bg-success/90 transition" onClick={handleApproveAll}>
                Approve All
              </button>
              <button className="h-8 px-4 rounded-lg border border-border text-txt text-[12px] font-medium hover:bg-bg transition" onClick={close}>
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, count, expanded, onToggle, accent, children }) {
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button className="w-full flex items-center gap-2 px-3 py-2 bg-bg/50 hover:bg-bg transition" onClick={onToggle}>
        <svg className={`w-3 h-3 text-txt-secondary transition-transform ${expanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
        </svg>
        <span className={`text-[11px] font-semibold uppercase tracking-wider ${accent ? 'text-ai' : 'text-txt-secondary'}`}>{title}</span>
        <span className="text-[10px] text-txt-secondary bg-border/50 px-1.5 py-0.5 rounded-full tabular-nums">{count}</span>
      </button>
      {expanded && <div className="flex flex-col gap-1 p-2">{children}</div>}
    </div>
  );
}

function RecCard({ rec, approving, onApprove }) {
  const style = ACTION_STYLE[rec.action] || ACTION_STYLE.flag;
  const isDone = rec._status === 'Accepted' || rec._status === 'Declined';
  return (
    <div className={`flex items-start gap-3 p-2.5 rounded-lg border ${isDone ? 'border-border bg-bg/50 opacity-60' : style.border + ' ' + style.bg}`}>
      <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded mt-0.5 shrink-0 ${style.text} ${style.bg} border ${style.border}`}>
        {style.label}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] font-medium text-txt">{rec.accountName || '—'}</span>
          {rec.confidence != null && (
            <span className="text-[10px] text-txt-secondary bg-surface px-1.5 py-0.5 rounded tabular-nums">{rec.confidence}%</span>
          )}
          {rec.logName && <span className="text-[10px] text-txt-secondary">{rec.logName}</span>}
        </div>
        {rec.address && rec.action === 'add' && <div className="text-[11px] text-txt-secondary mt-0.5">{rec.address}</div>}
        <p className="text-[12px] text-txt-secondary mt-0.5 leading-relaxed">{rec.reason}</p>
      </div>
      {rec.logId && !isDone && (
        <div className="flex gap-1 shrink-0">
          <button className="h-6 px-2 text-[10px] font-medium rounded bg-success/10 text-success border border-success/30 hover:bg-success/20 transition disabled:opacity-50" onClick={() => onApprove(rec.logId, 'Accepted')} disabled={approving[rec.logId]}>
            {approving[rec.logId] ? '…' : 'Approve'}
          </button>
          <button className="h-6 px-2 text-[10px] font-medium rounded bg-error/10 text-error border border-error/30 hover:bg-error/20 transition disabled:opacity-50" onClick={() => onApprove(rec.logId, 'Declined')} disabled={approving[rec.logId]}>
            Decline
          </button>
        </div>
      )}
      {isDone && (
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded shrink-0 ${rec._status === 'Accepted' ? 'bg-success/10 text-success' : 'bg-error/10 text-error'}`}>
          {rec._status}
        </span>
      )}
    </div>
  );
}

function FilterChip({ label, value, active, onClick, color, activeColor }) {
  return (
    <button className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium transition ${active ? activeColor : color + ' hover:opacity-80'}`} onClick={onClick}>
      <span className="uppercase tracking-wider">{label}</span>
      <span className="font-bold tabular-nums">{value}</span>
    </button>
  );
}
