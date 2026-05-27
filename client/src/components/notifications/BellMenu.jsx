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

/** Bell icon + unread badge + dropdown of recent triage recommendations. */
export default function BellMenu() {
  const notifications = useStore((s) => s.notifications);
  const unreadCount = useStore((s) => s.unreadCount);
  const markRead = useStore((s) => s.markRead);
  const markAllRead = useStore((s) => s.markAllRead);
  const selectRoute = useStore((s) => s.selectRoute);
  const isStreamConnected = useStore((s) => s.isStreamConnected);

  const [open, setOpen] = useState(false);
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

  const handleClick = async (n) => {
    if (!n.readAt) await markRead(n.id);
    if (n.googleRouteId) {
      selectRoute(n.googleRouteId);
    }
    setOpen(false);
  };

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
        <div className="absolute right-0 top-10 w-[360px] max-h-[480px] overflow-hidden bg-surface border border-border rounded-lg shadow-2xl z-30 flex flex-col">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <div className="text-[13px] font-semibold text-txt">Notifications</div>
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
              <div className="px-4 py-6 text-center text-[12px] text-txt-secondary">
                No notifications yet.
              </div>
            )}
            {notifications.map((n) => (
              <NotificationItem key={n.id} n={n} onClick={() => handleClick(n)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function NotificationItem({ n, onClick }) {
  const isAdd = n.type === 'Ticket Triage - Add To Route';
  const accent = isAdd ? 'text-emerald-600' : 'text-ai';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left px-3 py-2 border-b border-border hover:bg-bg transition ${n.readAt ? 'opacity-60' : ''}`}
    >
      <div className="flex items-start gap-2">
        <span className={`mt-0.5 h-2 w-2 rounded-full ${n.readAt ? 'bg-border' : 'bg-ai'}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`text-[11px] font-semibold ${accent}`}>
              {isAdd ? 'Add to route' : 'New route suggested'}
            </span>
            {n.confidence != null && (
              <span className="text-[10px] text-txt-secondary">
                {Math.round((Number(n.confidence) || 0) * 100)}%
              </span>
            )}
            <span className="ml-auto text-[10px] text-txt-secondary">
              {relTime(n.createdAt)}
            </span>
          </div>
          <div className="text-[13px] text-txt font-medium truncate">
            {n.accountName || n.caseNumber || 'Ticket'}
            {n.googleRouteName ? ` → ${n.googleRouteName}` : ''}
          </div>
          {n.reason && (
            <div className="text-[12px] text-txt-secondary line-clamp-2">
              {n.reason}
            </div>
          )}
        </div>
      </div>
    </button>
  );
}
