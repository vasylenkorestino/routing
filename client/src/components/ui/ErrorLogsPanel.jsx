import { useState, useEffect, useRef, useCallback } from 'react';
import * as routingApi from '../../api/routing';
import Spinner from './Spinner';
import { toast } from './Toast';
import { getErrorMessage } from '../../utils/error';

const SEV_STYLE = {
  Error: 'bg-red-100 text-red-700',
  Warning: 'bg-amber-100 text-amber-700',
  Info: 'bg-blue-100 text-blue-700',
};

/** Floating error-logs panel — toggled from header */
export default function ErrorLogsPanel({ open, onClose }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const ref = useRef(null);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const data = await routingApi.getErrorLogs({ limit: 50 });
      setLogs(Array.isArray(data) ? data : []);
    } catch (err) { toast.error(getErrorMessage(err)); setLogs([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { if (open) fetchLogs(); }, [open, fetchLogs]);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, onClose]);

  if (!open) return null;

  const fmtDate = (d) => {
    if (!d) return '—';
    try { return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch { return d; }
  };

  return (
    <div ref={ref} className="absolute top-12 right-2 z-[999] w-[520px] max-h-[70vh] bg-surface border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden animate-slide-in">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-bg/50">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-error" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126z" />
          </svg>
          <span className="text-sm font-semibold text-txt">Error Logs</span>
          <span className="text-[10px] text-txt-secondary bg-border/60 px-1.5 py-0.5 rounded-full tabular-nums">{logs.length}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={fetchLogs} disabled={loading} className="text-txt-secondary hover:text-txt transition p-1 rounded" title="Refresh">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
            </svg>
          </button>
          <button onClick={onClose} className="text-txt-secondary hover:text-txt transition p-1 rounded" title="Close">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-12 gap-2">
            <Spinner size="md" />
            <span className="text-xs text-txt-secondary">Loading logs…</span>
          </div>
        ) : logs.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-sm text-txt-secondary">No error logs found</div>
        ) : (
          <div className="divide-y divide-border/50">
            {logs.map((log, i) => (
              <div key={log.Id || i} className="group">
                {/* Summary row */}
                <button
                  className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-bg/50 transition"
                  onClick={() => setExpanded(expanded === i ? null : i)}
                >
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${SEV_STYLE[log.Severity__c] || SEV_STYLE.Error}`}>
                    {log.Severity__c || 'Error'}
                  </span>
                  <span className="flex-1 text-[12px] text-txt font-medium truncate">{log.Error_Message__c || '—'}</span>
                  <span className="text-[10px] text-txt-secondary shrink-0 tabular-nums">{fmtDate(log.CreatedDate)}</span>
                  <svg className={`w-3 h-3 text-txt-secondary transition-transform ${expanded === i ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                  </svg>
                </button>

                {/* Detail */}
                {expanded === i && (
                  <div className="px-4 pb-3 pt-1 bg-bg/30 space-y-2 text-[11px]">
                    <Detail label="Type" value={log.Error_Type__c} />
                    <Detail label="Source" value={log.Source__c} />
                    <Detail label="User" value={log.User_Info__c} />
                    <Detail label="Log #" value={log.Name} />
                    {log.Error_Message__c && (
                      <div>
                        <span className="font-semibold text-txt-secondary">Message</span>
                        <pre className="mt-0.5 p-2 bg-surface border border-border rounded text-[11px] text-txt whitespace-pre-wrap break-words max-h-[120px] overflow-auto">{log.Error_Message__c}</pre>
                      </div>
                    )}
                    {log.Stack_Trace__c && (
                      <div>
                        <span className="font-semibold text-txt-secondary">Stack Trace</span>
                        <pre className="mt-0.5 p-2 bg-surface border border-border rounded text-[10px] text-error/80 whitespace-pre-wrap break-words max-h-[150px] overflow-auto font-mono">{log.Stack_Trace__c}</pre>
                      </div>
                    )}
                    {log.Request_Body__c && (
                      <div>
                        <span className="font-semibold text-txt-secondary">Request Body</span>
                        <pre className="mt-0.5 p-2 bg-surface border border-border rounded text-[10px] text-txt-secondary whitespace-pre-wrap break-words max-h-[120px] overflow-auto font-mono">{log.Request_Body__c}</pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Detail({ label, value }) {
  if (!value) return null;
  return (
    <div className="flex gap-2">
      <span className="font-semibold text-txt-secondary w-14 shrink-0">{label}</span>
      <span className="text-txt break-all">{value}</span>
    </div>
  );
}
