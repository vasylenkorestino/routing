import { useState, useEffect, useRef, useCallback } from 'react';
import * as routingApi from '../../api/routing';
import Spinner from './Spinner';
import { toast } from './Toast';
import { getErrorMessage } from '../../utils/error';

const STATUS_STYLE = {
  Success: 'bg-emerald-100 text-emerald-700',
  Error: 'bg-red-100 text-red-700',
  Pending: 'bg-amber-100 text-amber-700',
};

const TYPE_STYLE = {
  Skill: 'bg-indigo-100 text-indigo-700',
  SOQL: 'bg-sky-100 text-sky-700',
  'AI Call': 'bg-fuchsia-100 text-fuchsia-700',
  'Tool Use': 'bg-amber-100 text-amber-700',
  System: 'bg-slate-100 text-slate-700',
};

/** Floating + full-screen action-logs panel — toggled from header. */
export default function ActionLogsPanel({ open, onClose }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [maximized, setMaximized] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(null);
  const ref = useRef(null);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const data = await routingApi.getActionLogs({ limit: 50 });
      setLogs(Array.isArray(data) ? data : []);
    } catch (err) { toast.error(getErrorMessage(err)); setLogs([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { if (open) fetchLogs(); }, [open, fetchLogs]);

  useEffect(() => {
    if (!open || maximized) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, onClose, maximized]);

  useEffect(() => {
    if (maximized && selectedIdx == null && logs.length > 0) setSelectedIdx(0);
  }, [maximized, selectedIdx, logs]);

  if (!open) return null;

  const containerCls = maximized
    ? 'fixed inset-0 z-[1000] w-full h-full bg-surface flex flex-col overflow-hidden'
    : 'absolute top-12 right-2 z-[999] w-[560px] max-h-[70vh] bg-surface border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden animate-slide-in';

  const selectedLog = maximized && selectedIdx != null ? logs[selectedIdx] : null;

  return (
    <div ref={ref} className={containerCls}>
      <PanelHeader
        count={logs.length}
        loading={loading}
        maximized={maximized}
        onRefresh={fetchLogs}
        onToggleMaximize={() => setMaximized((m) => !m)}
        onClose={onClose}
      />

      {loading ? (
        <div className="flex flex-col items-center justify-center py-12 gap-2">
          <Spinner size="md" />
          <span className="text-xs text-txt-secondary">Loading logs…</span>
        </div>
      ) : logs.length === 0 ? (
        <div className="flex items-center justify-center py-12 text-sm text-txt-secondary">No action logs found</div>
      ) : maximized ? (
        <div className="flex-1 flex min-h-0">
          <div className="w-[360px] shrink-0 border-r border-border overflow-auto">
            <LogList
              logs={logs}
              activeIdx={selectedIdx}
              onSelect={setSelectedIdx}
            />
          </div>
          <div className="flex-1 overflow-auto">
            {selectedLog
              ? <LogDetail log={selectedLog} />
              : <div className="flex items-center justify-center h-full text-sm text-txt-secondary">Select a log to view details</div>}
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          <div className="divide-y divide-border/50">
            {logs.map((log, i) => (
              <div key={log.Id || i} className="group">
                <LogRow
                  log={log}
                  active={expanded === i}
                  onClick={() => setExpanded(expanded === i ? null : i)}
                />
                {expanded === i && (
                  <div className="px-4 pb-3 pt-1 bg-bg/30 space-y-2 text-[11px]">
                    <LogSummary log={log} />
                    <StepTimeline steps={getSteps(log)} />
                    <LegacyBlocks log={log} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Returns the child Routing_Action_Step__c records from a parent log record. */
function getSteps(log) {
  return log?.Routing_Action_Steps__r?.records || [];
}

/** Header row with title, count, refresh, maximize, close. */
function PanelHeader({ count, loading, maximized, onRefresh, onToggleMaximize, onClose }) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-bg/50">
      <div className="flex items-center gap-2">
        <svg className="w-4 h-4 text-ai" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15a2.25 2.25 0 012.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z" />
        </svg>
        <span className="text-sm font-semibold text-txt">Action Logs</span>
        <span className="text-[10px] text-txt-secondary bg-border/60 px-1.5 py-0.5 rounded-full tabular-nums">{count}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <button onClick={onRefresh} disabled={loading} className="text-txt-secondary hover:text-txt transition p-1 rounded" title="Refresh">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
          </svg>
        </button>
        <button onClick={onToggleMaximize} className="text-txt-secondary hover:text-txt transition p-1 rounded" title={maximized ? 'Restore' : 'Maximize'}>
          {maximized ? (
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M15 9V4.5M15 9h4.5M15 9l5.25-5.25M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 15v4.5M15 15h4.5M15 15l5.25 5.25" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
            </svg>
          )}
        </button>
        <button onClick={onClose} className="text-txt-secondary hover:text-txt transition p-1 rounded" title="Close">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/** Vertical list of logs used in the maximized left pane. */
function LogList({ logs, activeIdx, onSelect }) {
  return (
    <div className="divide-y divide-border/50">
      {logs.map((log, i) => (
        <button
          key={log.Id || i}
          onClick={() => onSelect(i)}
          className={`w-full text-left px-3 py-2 transition ${activeIdx === i ? 'bg-bg/70' : 'hover:bg-bg/40'}`}
        >
          <div className="flex items-center gap-2">
            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 ${STATUS_STYLE[log.Status__c] || STATUS_STYLE.Success}`}>
              {log.Status__c || 'Success'}
            </span>
            <span className="text-[12px] text-txt font-medium truncate">{log.Action__c || '—'}</span>
            <span className="flex-1" />
            {log.Duration_Ms__c != null && (
              <span className="text-[10px] text-txt-secondary tabular-nums">{formatDuration(log.Duration_Ms__c)}</span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-2 text-[10px] text-txt-secondary tabular-nums">
            <span className="truncate">{log.Source__c || '—'}</span>
            <span className="shrink-0">{fmtDate(log.CreatedDate)}</span>
          </div>
        </button>
      ))}
    </div>
  );
}

/** Clickable row in the floating (non-maximized) view. */
function LogRow({ log, active, onClick }) {
  return (
    <button
      className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-bg/50 transition"
      onClick={onClick}
    >
      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 ${STATUS_STYLE[log.Status__c] || STATUS_STYLE.Success}`}>
        {log.Status__c || 'Success'}
      </span>
      <span className="text-[12px] text-txt font-medium truncate">{log.Action__c || '—'}</span>
      {log.Duration_Ms__c != null && (
        <span className="text-[10px] text-txt-secondary bg-border/40 px-1.5 py-0.5 rounded tabular-nums shrink-0">{formatDuration(log.Duration_Ms__c)}</span>
      )}
      <span className="flex-1" />
      <span className="text-[10px] text-txt-secondary shrink-0 tabular-nums">{fmtDate(log.CreatedDate)}</span>
      <svg className={`w-3 h-3 text-txt-secondary transition-transform ${active ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
      </svg>
    </button>
  );
}

/** Right pane in maximized mode — full detail of one log. */
function LogDetail({ log }) {
  const steps = getSteps(log);
  return (
    <div className="p-5 space-y-4 text-[12px]">
      <div className="flex items-center gap-3 flex-wrap">
        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded ${STATUS_STYLE[log.Status__c] || STATUS_STYLE.Success}`}>
          {log.Status__c || 'Success'}
        </span>
        <span className="text-base font-semibold text-txt">{log.Action__c || '—'}</span>
        {log.Duration_Ms__c != null && (
          <span className="text-[11px] text-txt-secondary bg-border/40 px-2 py-0.5 rounded tabular-nums">{formatDuration(log.Duration_Ms__c)}</span>
        )}
        <span className="text-[11px] text-txt-secondary tabular-nums">{fmtDate(log.CreatedDate)}</span>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[12px]">
        <Detail label="Log #" value={log.Name} />
        <Detail label="Source" value={log.Source__c} />
        <Detail label="User" value={log.User_Info__c} />
        <Detail label="Duration" value={log.Duration_Ms__c != null ? `${log.Duration_Ms__c} ms` : null} />
        <Detail label="Steps" value={steps.length || null} />
        <Detail label="Google Route" value={log.Google_Route__c} />
      </div>

      <StepTimeline steps={steps} expanded />

      <details className="border border-border/60 rounded">
        <summary className="px-3 py-2 cursor-pointer text-[11px] font-semibold text-txt-secondary hover:text-txt">Raw payloads</summary>
        <div className="px-3 pb-3 pt-1 space-y-2">
          <LegacyBlocks log={log} />
        </div>
      </details>
    </div>
  );
}

/** Compact line of source / user / duration shown in collapsed (non-maximized) detail. */
function LogSummary({ log }) {
  return (
    <div className="grid grid-cols-2 gap-x-2 gap-y-1">
      <Detail label="Log #" value={log.Name} />
      <Detail label="Source" value={log.Source__c} />
      <Detail label="User" value={log.User_Info__c} />
      <Detail label="Duration" value={log.Duration_Ms__c != null ? `${log.Duration_Ms__c} ms` : null} />
    </div>
  );
}

/** Backwards-compatible request/response/AI prompt/response blocks for old logs (no steps). */
function LegacyBlocks({ log }) {
  return (
    <>
      <JsonBlock label="Request Body" value={log.Request_Body__c} />
      <JsonBlock label="Response Body" value={log.Response_Body__c} />
      <JsonBlock label="AI Prompt" value={log.AI_Prompt__c} />
      <JsonBlock label="AI Response" value={log.AI_Response__c} />
    </>
  );
}

/** Numbered chronological timeline of Routing_Action_Step__c records. */
function StepTimeline({ steps, expanded: defaultOpen = false }) {
  if (!steps || steps.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-semibold text-txt-secondary uppercase tracking-wide">Steps ({steps.length})</div>
      <ol className="space-y-1.5">
        {steps.map((s) => (
          <StepRow key={s.Id || s.Step_Number__c} step={s} defaultOpen={defaultOpen} />
        ))}
      </ol>
    </div>
  );
}

/** A single timeline entry showing skill, type, duration and expandable payloads. */
function StepRow({ step, defaultOpen }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const hasPayload = step.Prompt__c || step.Input__c || step.Output__c || step.Error_Message__c;
  return (
    <li className="border border-border/60 rounded bg-surface">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-bg/40 transition"
        onClick={() => hasPayload && setOpen((o) => !o)}
      >
        <span className="text-[10px] font-mono text-txt-secondary w-6 shrink-0 tabular-nums">#{step.Step_Number__c ?? '—'}</span>
        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 ${TYPE_STYLE[step.Type__c] || TYPE_STYLE.Skill}`}>
          {step.Type__c || 'Skill'}
        </span>
        <span className="text-[11px] text-txt font-medium truncate">{step.Skill__c || '—'}</span>
        <span className="flex-1" />
        {step.Duration_Ms__c != null && (
          <span className="text-[10px] text-txt-secondary tabular-nums shrink-0">{formatDuration(step.Duration_Ms__c)}</span>
        )}
        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 ${STATUS_STYLE[step.Status__c] || STATUS_STYLE.Success}`}>
          {step.Status__c || 'Success'}
        </span>
        {hasPayload && (
          <svg className={`w-3 h-3 text-txt-secondary transition-transform shrink-0 ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
        )}
      </button>
      {open && hasPayload && (
        <div className="px-2.5 pb-2 pt-0.5 space-y-1.5 border-t border-border/50">
          <JsonBlock label="Prompt" value={step.Prompt__c} />
          <JsonBlock label="Input" value={step.Input__c} />
          <JsonBlock label="Output" value={step.Output__c} />
          <JsonBlock label="Error" value={step.Error_Message__c} />
        </div>
      )}
    </li>
  );
}

function formatDuration(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return d; }
}

function Detail({ label, value }) {
  if (value == null || value === '') return null;
  return (
    <div className="flex gap-2 min-w-0">
      <span className="font-semibold text-txt-secondary w-20 shrink-0">{label}</span>
      <span className="text-txt break-all truncate">{value}</span>
    </div>
  );
}

/** Collapsible JSON/text block for large payloads. */
function JsonBlock({ label, value }) {
  const [open, setOpen] = useState(false);
  if (!value) return null;

  let formatted = value;
  try { formatted = JSON.stringify(JSON.parse(value), null, 2); } catch { /* keep raw */ }

  return (
    <div>
      <button
        className="flex items-center gap-1 font-semibold text-txt-secondary hover:text-txt transition"
        onClick={() => setOpen(!open)}
      >
        <svg className={`w-2.5 h-2.5 transition-transform ${open ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
        </svg>
        {label}
      </button>
      {open && (
        <pre className="mt-1 p-2 bg-surface border border-border rounded text-[10px] text-txt-secondary whitespace-pre-wrap break-words max-h-[400px] overflow-auto font-mono">{formatted}</pre>
      )}
    </div>
  );
}
