import { useEffect, useRef, useState } from 'react';
import useStore from '../../store';
import { toast } from '../ui/Toast';
import TicketDetailFields from '../shared/TicketDetailFields';

/** Friendly labels for the closed/started reasons surfaced by the Apex/Node skill. */
const LOCK_LABELS = {
  'Driver_Completed__c=true': 'Route is already completed',
  'isLocked__c=true': 'Route is locked',
  "CompletionStatus__c='In Progress'": 'Route completion in progress',
  "CompletionStatus__c='Completed'": 'Route is completed',
  "CompletionStatus__c='Failed'": 'Route completion failed',
  'a stop has Gallons_Collected__c set': 'A stop on this route is already serviced',
  'a stop has Notes2__c (Service Issues) set': 'A stop on this route has service issues',
  'a stop has Service_Completed__c=true': 'A stop on this route is already serviced',
  'a stop is marked Inactive__c=true': 'A stop on this route is inactive',
  'a stop already has a terminal Status__c': 'A stop on this route is already serviced',
  NOT_FOUND: 'Route was deleted',
};

function lockLabel(reason) {
  if (!reason) return 'Route locked';
  return LOCK_LABELS[reason] || `Route locked (${reason})`;
}

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
  const acceptNotification = useStore((s) => s.acceptNotification);
  const declineNotification = useStore((s) => s.declineNotification);
  const navigateFromNotification = useStore((s) => s.navigateFromNotification);
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
    setOpen(false);
    await navigateFromNotification(n);
  };

  const toggleExpand = (id) =>
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));

  const onAccept = async (n) => {
    const result = await acceptNotification(n.id);
    if (result.ok) {
      const target = n.googleRouteName || 'route';
      toast.success(`Ticket added to ${target}.`);
    } else if (result.lockedReason) {
      toast.error(`Cannot accept: ${lockLabel(result.lockedReason)}.`);
    } else {
      toast.error(result.message || 'Could not accept this recommendation.');
    }
  };

  const onDecline = async (n) => {
    const result = await declineNotification(n.id);
    if (result.ok) {
      toast.info('Recommendation declined. Searching for an alternative…');
    } else if (result.lockedReason) {
      toast.error(`Cannot decline: ${lockLabel(result.lockedReason)}.`);
    } else {
      toast.error(result.message || 'Could not decline this recommendation.');
    }
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
        <div className="fixed inset-x-2 top-14 w-auto max-h-[75vh] sm:absolute sm:inset-x-auto sm:right-0 sm:top-10 sm:w-[420px] sm:max-h-[560px] overflow-hidden bg-surface border border-border rounded-xl shadow-2xl z-[60] flex flex-col">
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
                onAccept={() => onAccept(n)}
                onDecline={() => onDecline(n)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Single notification card — reason text, route chip, accept/decline + read actions. */
function NotificationItem({ n, expanded, onToggle, onGoToRoute, onMarkRead, onAccept, onDecline }) {
  const isAdd = n.type === 'Ticket Triage - Add To Route';
  const accent = isAdd ? 'text-emerald-600' : 'text-ai';
  const accentBg = isAdd ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-ai/10 border-ai/30 text-ai';
  const reason = cleanReason(n.reason);
  const showToggle = reason.length > 140;
  const routeLabel = n.googleRouteName || (n.googleRouteId ? 'Existing route' : 'New route');
  const status = n.status || 'Proposed';
  const isProposed = status === 'Proposed';
  const isLocked = !!n._locked;
  const isPending = !!n._pending;
  const canAct = isProposed && !isLocked && !!n.googleRouteId;

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
          {n.caseNumber && (
            <div className="text-[11px] text-txt-secondary">Case {n.caseNumber}</div>
          )}
          <TicketDetailFields ticket={n} />

          {/* Highlighted route chip */}
          <button
            type="button"
            onClick={onGoToRoute}
            className={`mt-2 inline-flex items-center gap-1.5 max-w-full px-2 py-1 rounded-md border text-[12px] font-medium transition hover:brightness-95 ${accentBg}`}
            title="Open route and show this ticket on map"
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

          {/* Status pills (terminal states) */}
          {status === 'Accepted' && (
            <div className="mt-2 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 text-[10px] font-bold uppercase tracking-wide">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              Accepted{n.acceptedBy ? ` by ${n.acceptedBy}` : ''}
            </div>
          )}
          {status === 'Declined' && (
            <div className="mt-2 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-bg border border-border text-txt-secondary text-[10px] font-bold uppercase tracking-wide">
              Declined — re-triage in progress
            </div>
          )}
          {isProposed && isLocked && (
            <div
              className="mt-2 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700 text-[10px] font-bold uppercase tracking-wide"
              title={lockLabel(n._locked)}
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 11c-1.105 0-2 .895-2 2v3a2 2 0 104 0v-3c0-1.105-.895-2-2-2zm6-3V6a6 6 0 10-12 0v2H4v12h16V8h-2z" />
              </svg>
              {lockLabel(n._locked)}
            </div>
          )}

          {/* Actions row */}
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            {isProposed && !isLocked && canAct && (
              <>
                <button
                  type="button"
                  onClick={onAccept}
                  disabled={isPending}
                  className="px-2.5 py-1 rounded-md bg-emerald-600 text-white text-[11px] font-semibold hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {n._pending === 'accept' ? 'Accepting…' : 'Accept'}
                </button>
                <button
                  type="button"
                  onClick={onDecline}
                  disabled={isPending}
                  className="px-2.5 py-1 rounded-md border border-border text-txt text-[11px] font-semibold hover:bg-bg disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {n._pending === 'decline' ? 'Declining…' : 'Decline'}
                </button>
              </>
            )}
            {!n.readAt && (
              <button
                type="button"
                onClick={onMarkRead}
                className="text-[11px] text-txt-secondary hover:text-primary ml-auto"
              >
                Mark as read
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
