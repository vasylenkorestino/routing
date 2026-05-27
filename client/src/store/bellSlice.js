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

  connectStream: () => {
    if (get()._eventSource) return;
    if (typeof window === 'undefined' || !('EventSource' in window)) return;

    const open = () => {
      const url = buildStreamUrl();
      const es = new EventSource(url);

      es.addEventListener('ready', () => {
        set({ isStreamConnected: true });
      });

      es.addEventListener('ticket-triaged', (e) => {
        try {
          const payload = JSON.parse(e.data);
          get().addNotification({
            id: payload.id,
            createdAt: payload.createdAt,
            readAt: null,
            type: payload.type,
            skill: 'Ticket Triage',
            confidence: payload.confidence ? payload.confidence / 100 : null,
            reason: payload.reason,
            accountId: payload.accountId,
            accountName: payload.accountName,
            googleRouteId: payload.googleRouteId,
            googleRouteName: null,
            ticketId: payload.ticketId,
            caseNumber: payload.caseNumber,
            ticketSubject: null,
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
