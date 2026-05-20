import { useState, useEffect, useCallback, useRef } from 'react';
import useStore from '../../store';
import * as routingApi from '../../api/routing';
import Spinner from '../ui/Spinner';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';
import LastServices from '../shared/LastServices';
import TankSensorData from '../shared/TankSensorData';

const STATUS_STYLE = {
  Proposed: 'bg-warning/10 text-warning border-warning/30',
  Accepted: 'bg-success/10 text-success border-success/30',
  Declined: 'bg-error/10 text-error border-error/30',
};

/** Threaded comment section for a single RouteLog__c entry */
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

  if (loading) return <div className="flex items-center gap-2 py-3 px-2"><Spinner size="sm" /><span className="text-[10px] text-txt-secondary">Loading comments…</span></div>;

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
                <span className={`text-[9px] font-bold uppercase ${c.Is_AI__c ? 'text-ai' : 'text-primary'}`}>
                  {c.Is_AI__c ? '✦ AI' : c.Author__c || 'You'}
                </span>
                <span className="text-[9px] text-txt-secondary">{fmtTime(c.CreatedDate)}</span>
              </div>
              <p className="text-[11px] text-txt leading-snug whitespace-pre-wrap">{c.Body__c}</p>
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex justify-start">
            <div className="bg-ai/10 border border-ai/20 rounded-lg px-2.5 py-1.5 flex items-center gap-1.5">
              <Spinner size="xs" />
              <span className="text-[10px] text-ai">AI is thinking…</span>
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
          className="h-7 px-2.5 text-[10px] font-medium rounded bg-primary text-white hover:bg-primary/90 transition disabled:opacity-50 cursor-pointer"
          onClick={handleSend}
          disabled={!text.trim() || sending}
        >
          Send
        </button>
      </div>
    </div>
  );
}

/** Collapsible panel showing RouteLog__c history for a route */
export default function RouteLogsPanel({ googleRouteId }) {
  const refreshRoutes = useStore((s) => s.refreshRoutes);
  const driverName = useStore((s) => s.driver?.name) || 'You';
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [approving, setApproving] = useState({});
  const [expandedComments, setExpandedComments] = useState({});
  const [selectedLog, setSelectedLog] = useState(null);
  const [detailTab, setDetailTab] = useState('services');

  const toggleComments = useCallback((logId) => {
    setExpandedComments((prev) => ({ ...prev, [logId]: !prev[logId] }));
  }, []);

  const fetchLogs = useCallback(async () => {
    if (!googleRouteId) return;
    setLoading(true);
    try {
      const data = await routingApi.getRouteLogs(googleRouteId);
      setLogs(Array.isArray(data) ? data : []);
    } catch { setLogs([]); }
    finally { setLoading(false); }
  }, [googleRouteId]);

  useEffect(() => { if (open) fetchLogs(); }, [open, googleRouteId, fetchLogs]);

  const handleApprove = useCallback(async (logId, status) => {
    setApproving((p) => ({ ...p, [logId]: true }));
    try {
      const res =       await routingApi.approveRouteLogs({ logIds: [logId], status });
      const now = new Date().toISOString();
      setLogs((prev) => prev.map((l) => l.Id === logId ? { ...l, Status__c: status, Accepted_By__c: driverName, Accepted_Date__c: now } : l));
      if (res?.added?.length) refreshRoutes?.();
    } catch (err) { toast.error(getErrorMessage(err)); }
    finally { setApproving((p) => ({ ...p, [logId]: false })); }
  }, [refreshRoutes]);

  const handleApproveAll = useCallback(async () => {
    const pendingIds = logs.filter((l) => l.Status__c === 'Proposed').map((l) => l.Id);
    if (!pendingIds.length) return;
    setApproving((p) => { const n = { ...p }; pendingIds.forEach((id) => { n[id] = true; }); return n; });
    try {
      const res =       await routingApi.approveRouteLogs({ logIds: pendingIds, status: 'Accepted' });
      const now = new Date().toISOString();
      setLogs((prev) => prev.map((l) => pendingIds.includes(l.Id) ? { ...l, Status__c: 'Accepted', Accepted_By__c: driverName, Accepted_Date__c: now } : l));
      toast.success(`${pendingIds.length} logs approved`);
      if (res?.added?.length) refreshRoutes?.();
    } catch (err) { toast.error(getErrorMessage(err)); }
    finally { setApproving({}); }
  }, [logs, refreshRoutes]);

  const pending = logs.filter((l) => l.Status__c === 'Proposed').length;

  const fmtDate = (d) => {
    if (!d) return '';
    try { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch { return d; }
  };

  const parseReason = (reason) => {
    if (!reason) return { action: '', text: reason || '' };
    const match = reason.match(/^\[(\w+)\]\s*(.*)$/s);
    if (match) return { action: match[1], text: match[2] };
    return { action: '', text: reason };
  };

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-surface">
      <button className="w-full flex items-center gap-2 px-3 py-2 bg-bg/50 hover:bg-bg transition" onClick={() => setOpen((p) => !p)}>
        <svg className={`w-3 h-3 text-txt-secondary transition-transform ${open ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
        </svg>
        <span className="text-[11px] font-semibold text-ai uppercase tracking-wider">✦ AI Logs</span>
        {logs.length > 0 && <span className="text-[10px] text-txt-secondary bg-border/50 px-1.5 py-0.5 rounded-full tabular-nums">{logs.length}</span>}
        {pending > 0 && <span className="text-[10px] font-semibold text-warning bg-warning/10 px-1.5 py-0.5 rounded-full tabular-nums">{pending} pending</span>}
      </button>

      {open && (
        <div className="border-t border-border">
          {loading ? (
            <div className="flex items-center justify-center py-6 gap-2">
              <Spinner size="sm" /><span className="text-xs text-txt-secondary">Loading…</span>
            </div>
          ) : logs.length === 0 ? (
            <div className="text-xs text-txt-secondary text-center py-4">No AI logs for this route</div>
          ) : (
            <>
              {pending > 0 && (
                <div className="flex items-center justify-between px-3 py-1.5 bg-warning/5 border-b border-border">
                  <span className="text-[11px] text-warning font-medium">{pending} pending review</span>
                  <button className="h-6 px-2.5 text-[10px] font-medium rounded bg-success text-white hover:bg-success/90 transition" onClick={handleApproveAll}>
                    Approve All
                  </button>
                </div>
              )}
              <div className="max-h-[300px] overflow-auto divide-y divide-border/50">
                {logs.map((log) => {
                  const { action, text } = parseReason(log.Reason__c);
                  const stStyle = STATUS_STYLE[log.Status__c] || STATUS_STYLE.Proposed;
                  const isPending = log.Status__c === 'Proposed';
                  const commentsOpen = expandedComments[log.Id];
                  const isSelected = selectedLog?.Id === log.Id;
                  return (
                    <div key={log.Id}>
                      <div
                        className={`flex items-start gap-2.5 px-3 py-2 transition-colors ${isPending ? '' : 'opacity-70'} ${log.Account__c ? 'cursor-pointer' : ''} ${isSelected ? 'bg-primary/5 ring-1 ring-inset ring-primary/20' : log.Account__c ? 'hover:bg-bg/40' : ''}`}
                        onClick={() => { if (log.Account__c) setSelectedLog(isSelected ? null : log); }}
                      >
                        <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded mt-0.5 shrink-0 border ${stStyle}`}>
                          {log.Status__c}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            {action && <span className="text-[10px] font-semibold text-txt-secondary bg-bg px-1.5 py-0.5 rounded uppercase">{action}</span>}
                            <span className="text-[10px] text-txt-secondary">{log.Name}</span>
                            {log.Confidence__c != null && (
                              <span className="text-[10px] text-txt-secondary tabular-nums">{Math.round(log.Confidence__c * 100)}%</span>
                            )}
                            <span className="text-[10px] text-border tabular-nums">{fmtDate(log.CreatedDate)}</span>
                          </div>
                          <p className="text-[12px] text-txt mt-0.5 leading-snug">{text}</p>
                          {log.Accepted_By__c && (
                            <div className="text-[10px] text-txt-secondary mt-0.5 italic">
                              {log.Status__c === 'Declined' ? 'Declined' : 'Approved'} by {log.Accepted_By__c}{log.Accepted_Date__c ? ` · ${fmtDate(log.Accepted_Date__c)}` : ''}
                            </div>
                          )}
                        </div>
                        <div className="flex gap-1 shrink-0 items-start">
                          <button
                            className={`relative h-5 px-1.5 text-[9px] font-medium rounded border transition cursor-pointer ${commentsOpen ? 'bg-ai/10 text-ai border-ai/30' : 'bg-bg text-txt-secondary border-border hover:bg-bg/80'}`}
                            onClick={() => toggleComments(log.Id)}
                            title="Comments"
                          >
                            <svg className="w-3 h-3 inline-block" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
                            </svg>
                            {log.CommentCount__c > 0 && (
                              <span className="absolute -top-1.5 -right-1.5 min-w-[14px] h-[14px] flex items-center justify-center text-[8px] font-bold rounded-full bg-ai text-white leading-none px-0.5">
                                {log.CommentCount__c}
                              </span>
                            )}
                          </button>
                          {isPending && (
                            <>
                              <button className="h-5 px-1.5 text-[9px] font-medium rounded bg-success/10 text-success border border-success/30 hover:bg-success/20 transition disabled:opacity-50 cursor-pointer" onClick={() => handleApprove(log.Id, 'Accepted')} disabled={approving[log.Id]}>
                                {approving[log.Id] ? '…' : '✓'}
                              </button>
                              <button className="h-5 px-1.5 text-[9px] font-medium rounded bg-error/10 text-error border border-error/30 hover:bg-error/20 transition disabled:opacity-50 cursor-pointer" onClick={() => handleApprove(log.Id, 'Declined')} disabled={approving[log.Id]}>
                                ✗
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      {commentsOpen && <LogCommentThread routeLogId={log.Id} />}
                    </div>
                  );
                })}
              </div>

              {/* Account detail panel for selected log */}
              {selectedLog?.Account__c && (
                <div className="border-t border-border">
                  <div className="flex items-center border-b border-border bg-bg/50">
                    {[{ key: 'services', label: 'Last Services' }, { key: 'tanks', label: 'Tank & Sensor' }].map((tab) => (
                      <button
                        key={tab.key}
                        className={`px-3 py-1.5 text-[11px] font-semibold transition border-b-2 ${detailTab === tab.key ? 'border-primary text-primary' : 'border-transparent text-txt-secondary hover:text-txt'}`}
                        onClick={() => setDetailTab(tab.key)}
                      >
                        {tab.label}
                      </button>
                    ))}
                    <button
                      className="ml-auto mr-2 w-5 h-5 flex items-center justify-center rounded-full text-txt-secondary hover:text-error hover:bg-border text-xs transition"
                      onClick={() => setSelectedLog(null)}
                    >×</button>
                  </div>
                  {detailTab === 'services' && (
                    <LastServices accountId={selectedLog.Account__c} accountName={selectedLog.Account__r?.Name} />
                  )}
                  {detailTab === 'tanks' && (
                    <TankSensorData accountId={selectedLog.Account__c} accountName={selectedLog.Account__r?.Name} />
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
