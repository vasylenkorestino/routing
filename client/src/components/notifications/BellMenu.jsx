import { useEffect, useRef, useState } from 'react';
import useStore from '../../store';
import { toast } from '../ui/Toast';

function relTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return '';
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Strips the "[ADD] AccountName: " / "[NEW] AccountName: " server prefix from the reason text. */
function cleanReason(reason) {
  if (!reason) return '';
  return reason.replace(/^\[(ADD|NEW)\][^:]*:\s*/i, '').trim();
}

/** Bell icon + unread badge + dropdown of recent triage recommendations. */
export default function BellMenu() {
  const notifications = useStore((s) => s.notifications);
  const unreadCount = useStore((s) => s.unreadCount);
  const markRead = useStore((s) => s.markRead);
  const markAllRead = useStore((s) => s.markAllRead);
  const selectRoute = useStore((s) => s.selectRoute);
  const isStreamConnected = useStore((s) => s.isStreamConnected);

  const [open, setOpen] = useState(false);
  const [expandedIds, setExpandedIds] = useState({});
  const containerRef = useRef(null);
  const lastSeenIdRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
    return undefined;
  }, [open]);

  useEffect(() => {
    if (!notifications.length) return;
    const newest = notifications[0];
    if (newest && !newest.readAt && newest.id !== lastSeenIdRef.current) {
      if (lastSeenIdRef.current !== null) {
        const label = newest.accountName || newest.caseNumber || 'New ticket';
        const target = newest.googleRouteName || (newest.googleRouteId ? 'an existing route' : 'a new route');
        toast.info(`Ticket triaged: ${label} → ${target}`);
      }
      lastSeenIdRef.current = newest.id;
    }
  }, [notifications]);

  const goToRoute = async (n) => {
    if (!n.readAt) await markRead(n.id);
    if (n.googleRouteId) selectRoute(n.googleRouteId);
    setOpen(false);
  };

  const toggleExpand = (id) =>
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));

  return (
    <div ref={containerRef} className="relative">
      <button
        className={`h-8 w-8 flex items-center justify-center rounded-lg border transition relative ${open ? 'border-ai bg-ai/10 text-ai' : 'border-border bg-surface text-txt-secondary hover:bg-bg hover:text-txt'}`}
        title={isStreamConnected ? 'Notifications (live)' : 'Notifications'}
        onClick={() => setOpen((p) => !p)}
        aria-label="Notifications"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold leading-4 text-center">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-10 w-[420px] max-h-[560px] overflow-hidden bg-surface border border-border rounded-xl shadow-2xl z-30 flex flex-col">
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold text-txt">Notifications</span>
              {unreadCount > 0 && (
                <span className="px-1.5 py-0.5 rounded-full bg-red-500/10 text-red-500 text-[10px] font-bold">
                  {unreadCount} new
                </span>
              )}
            </div>
            <button
              className="text-[11px] text-txt-secondary hover:text-primary disabled:opacity-50"
              onClick={() => markAllRead()}
              disabled={unreadCount === 0}
            >
              Mark all read
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {notifications.length === 0 && (
              <div className="px-4 py-10 text-center text-[12px] text-txt-secondary">
                No notifications yet.
              </div>
            )}
            {notifications.map((n) => (
              <NotificationItem
                key={n.id}
                n={n}
                expanded={!!expandedIds[n.id]}
                onToggle={() => toggleExpand(n.id)}
                onGoToRoute={() => goToRoute(n)}
                onMarkRead={() => markRead(n.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Single notification card — full reason text, route chip, primary "Open route" action. */
function NotificationItem({ n, expanded, onToggle, onGoToRoute, onMarkRead }) {
  const isAdd = n.type === 'Ticket Triage - Add To Route';
  const accent = isAdd ? 'text-emerald-600' : 'text-ai';
  const accentBg = isAdd ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-ai/10 border-ai/30 text-ai';
  const reason = cleanReason(n.reason);
  const showToggle = reason.length > 140;
  const routeLabel = n.googleRouteName || (n.googleRouteId ? 'Existing route' : 'New route');

  return (
    <div className={`px-3 py-2.5 border-b border-border transition ${n.readAt ? 'opacity-70' : 'bg-ai/[0.03]'}`}>
      <div className="flex items-start gap-2">
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.readAt ? 'bg-border' : 'bg-ai'}`} />

        <div className="flex-1 min-w-0">
          {/* Header row: action label, confidence, time */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`text-[11px] font-semibold uppercase tracking-wide ${accent}`}>
              {isAdd ? 'Add to route' : 'New route suggested'}
            </span>
            {n.confidence != null && (
              <span className="px-1.5 py-0.5 rounded-full bg-bg text-txt-secondary text-[10px] font-bold">
                {Math.round((Number(n.confidence) || 0) * 100)}%
              </span>
            )}
            <span className="ml-auto text-[10px] text-txt-secondary">
              {relTime(n.createdAt)}
            </span>
          </div>

          {/* Account / ticket */}
          <div className="mt-1 text-[13px] text-txt font-semibold break-words">
            {n.accountName || n.caseNumber || 'Ticket'}
          </div>
          {n.caseNumber && n.accountName && (
            <div className="text-[11px] text-txt-secondary">Case {n.caseNumber}</div>
          )}

          {/* Highlighted route chip */}
          <button
            type="button"
            onClick={onGoToRoute}
            className={`mt-2 inline-flex items-center gap-1.5 max-w-full px-2 py-1 rounded-md border text-[12px] font-medium transition hover:brightness-95 ${accentBg}`}
            title={n.googleRouteId ? 'Open route' : 'No route assigned yet'}
          >
            <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l5.447 2.724A1 1 0 0021 18.382V7.618a1 1 0 00-1.447-.894L15 9m0 8V9m0 0L9 7" />
            </svg>
            <span className="truncate">{routeLabel}</span>
            {n.googleRouteId && (
              <svg className="w-3 h-3 shrink-0 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            )}
          </button>

          {/* Full reason (expandable) */}
          {reason && (
            <div className="mt-2 text-[12px] text-txt-secondary leading-relaxed whitespace-pre-wrap break-words">
              {expanded || !showToggle ? reason : `${reason.slice(0, 140)}…`}
              {showToggle && (
                <button
                  type="button"
                  onClick={onToggle}
                  className="ml-1 text-[11px] font-medium text-primary hover:underline"
                >
                  {expanded ? 'Show less' : 'Show more'}
                </button>
              )}
            </div>
          )}

          {/* Actions row */}
          {!n.readAt && (
            <div className="mt-2 flex items-center gap-3">
              <button
                type="button"
                onClick={onMarkRead}
                className="text-[11px] text-txt-secondary hover:text-primary"
              >
                Mark as read
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
