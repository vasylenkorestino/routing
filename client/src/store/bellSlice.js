import * as notifApi from '../api/notifications';
import { buildStreamUrl } from '../api/notifications';

const MAX_KEEP = 100;

/** Bell notifications: triage RouteLog__c records pushed live via SSE + REST seed. */
const bellSlice = (set, get) => ({
  notifications: [],
  unreadCount: 0,
  isStreamConnected: false,
  _eventSource: null,
  _reconnectTimer: null,

  loadInitial: async () => {
    try {
      const data = await notifApi.getNotifications();
      const list = data.notifications || [];
      set({ notifications: list, unreadCount: list.length });
    } catch (err) {
      console.warn('[bellSlice] loadInitial failed', err.message);
    }
  },

  addNotification: (n) => {
    if (!n || !n.id) return;
    set((s) => {
      if (s.notifications.some((x) => x.id === n.id)) return s;
      const next = [n, ...s.notifications].slice(0, MAX_KEEP);
      return { notifications: next, unreadCount: next.filter((x) => !x.readAt).length };
    });
  },

  markRead: async (id) => {
    set((s) => {
      const next = s.notifications.map((n) =>
        n.id === id && !n.readAt ? { ...n, readAt: new Date().toISOString() } : n
      );
      return { notifications: next, unreadCount: next.filter((x) => !x.readAt).length };
    });
    try {
      await notifApi.markNotificationRead(id);
    } catch (err) {
      console.warn('[bellSlice] markRead failed', err.message);
    }
  },

  markAllRead: async () => {
    set((s) => {
      const ts = new Date().toISOString();
      const next = s.notifications.map((n) => (n.readAt ? n : { ...n, readAt: ts }));
      return { notifications: next, unreadCount: 0 };
    });
    try {
      await notifApi.markAllNotificationsRead();
    } catch (err) {
      console.warn('[bellSlice] markAllRead failed', err.message);
    }
  },

  /**
   * Accept a triage proposal — server adds the ticket to the suggested route.
   * Optimistically updates status; on a 409 (route closed/started) the item is
   * marked locked so the UI can show a lock pill instead of action buttons.
   * Returns { ok, lockedReason } so the caller can toast a precise message.
   */
  acceptNotification: async (id) => {
    const ts = new Date().toISOString();
    set((s) => ({
      notifications: s.notifications.map((n) =>
        n.id === id ? { ...n, status: 'Accepted', readAt: n.readAt || ts, _pending: 'accept' } : n,
      ),
    }));
    try {
      const data = await notifApi.acceptNotification(id);
      set((s) => ({
        notifications: s.notifications.map((n) =>
          n.id === id
            ? { ...n, status: 'Accepted', acceptedBy: data.acceptedBy || null, _pending: null }
            : n,
        ),
        unreadCount: s.notifications.filter((x) => !x.readAt && x.id !== id).length,
      }));
      return { ok: true };
    } catch (err) {
      const data = err?.response?.data || {};
      const lockedReason = data.code === 'ROUTE_CLOSED' ? data.reason || data.error : null;
      set((s) => ({
        notifications: s.notifications.map((n) =>
          n.id === id
            ? { ...n, status: 'Proposed', _pending: null, _locked: lockedReason || n._locked }
            : n,
        ),
      }));
      return { ok: false, lockedReason, message: data.error || err.message };
    }
  },

  /**
   * Decline a triage proposal — server marks Declined and queues a re-triage
   * that excludes the declined route. Same locking semantics as accept.
   */
  declineNotification: async (id) => {
    const ts = new Date().toISOString();
    set((s) => ({
      notifications: s.notifications.map((n) =>
        n.id === id ? { ...n, status: 'Declined', readAt: n.readAt || ts, _pending: 'decline' } : n,
      ),
    }));
    try {
      await notifApi.declineNotification(id);
      set((s) => ({
        notifications: s.notifications.map((n) =>
          n.id === id ? { ...n, status: 'Declined', _pending: null } : n,
        ),
        unreadCount: s.notifications.filter((x) => !x.readAt && x.id !== id).length,
      }));
      return { ok: true };
    } catch (err) {
      const data = err?.response?.data || {};
      const lockedReason = data.code === 'ROUTE_CLOSED' ? data.reason || data.error : null;
      set((s) => ({
        notifications: s.notifications.map((n) =>
          n.id === id
            ? { ...n, status: 'Proposed', _pending: null, _locked: lockedReason || n._locked }
            : n,
        ),
      }));
      return { ok: false, lockedReason, message: data.error || err.message };
    }
  },

  connectStream: () => {
    if (get()._eventSource) return;
    if (typeof window === 'undefined' || !('EventSource' in window)) return;

    const open = () => {
      const url = buildStreamUrl();
      const es = new EventSource(url);

      es.addEventListener('ready', () => {
        set({ isStreamConnected: true });
      });

      es.addEventListener('sf-changed', (e) => {
        try {
          const payload = JSON.parse(e.data);
          const applyServerPatch = get().applyServerPatch;
          if (typeof applyServerPatch === 'function') {
            applyServerPatch(payload);
          }
        } catch (err) {
          console.warn('[bellSlice] failed to parse sf-changed message', err.message);
        }
      });

      es.addEventListener('generation-progress', (e) => {
        try {
          const payload = JSON.parse(e.data);
          const handler = get().onGenerationProgress;
          if (typeof handler === 'function') handler(payload);
        } catch (err) {
          console.warn('[bellSlice] failed to parse generation-progress message', err.message);
        }
      });

      es.addEventListener('planning-progress', (e) => {
        try {
          const payload = JSON.parse(e.data);
          const handler = get().onPlanningProgress;
          if (typeof handler === 'function') handler(payload);
        } catch (err) {
          console.warn('[bellSlice] failed to parse planning-progress message', err.message);
        }
      });

      es.addEventListener('ai-progress', (e) => {
        try {
          const payload = JSON.parse(e.data);
          const handler = get().onAIProgress;
          if (typeof handler === 'function') handler(payload);
        } catch (err) {
          console.warn('[bellSlice] failed to parse ai-progress message', err.message);
        }
      });

      es.addEventListener('ticket-triaged', (e) => {
        try {
          const payload = JSON.parse(e.data);
          get().addNotification({
            id: payload.id,
            createdAt: payload.createdAt,
            readAt: null,
            status: 'Proposed',
            type: payload.type,
            skill: 'Ticket Triage',
            confidence: payload.confidence ? payload.confidence / 100 : null,
            reason: payload.reason,
            accountId: payload.accountId,
            accountName: payload.accountName,
            accountLat: payload.accountLat ?? null,
            accountLng: payload.accountLng ?? null,
            googleRouteId: payload.googleRouteId,
            googleRouteName: payload.googleRouteName || null,
            routeServiceDate: payload.routeServiceDate || null,
            routeRecordType: payload.routeRecordType || null,
            suggestedDate: payload.suggestedDate || null,
            ticketId: payload.ticketId,
            caseNumber: payload.caseNumber,
            ticketSubject: null,
            ticketType: payload.ticketType || null,
            caseRecordType: payload.caseRecordType || null,
            ticketOpenedAt: payload.ticketOpenedAt || null,
            parentLogId: payload.parentLogId || null,
          });
        } catch (err) {
          console.warn('[bellSlice] failed to parse SSE message', err.message);
        }
      });

      es.onerror = () => {
        set({ isStreamConnected: false });
        es.close();
        const t = setTimeout(open, 5000);
        set({ _eventSource: null, _reconnectTimer: t });
      };

      set({ _eventSource: es, _reconnectTimer: null });
    };

    open();
  },

  disconnectStream: () => {
    const { _eventSource, _reconnectTimer } = get();
    if (_eventSource) _eventSource.close();
    if (_reconnectTimer) clearTimeout(_reconnectTimer);
    set({ _eventSource: null, _reconnectTimer: null, isStreamConnected: false });
  },
});

export default bellSlice;
