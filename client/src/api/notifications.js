import client from './client';

/* ── Bell notifications ───────────────────────────────────── */
export const getNotifications = (params) =>
  client.get('/notifications', { params }).then((r) => r.data);

export const markNotificationRead = (id) =>
  client.post(`/notifications/${id}/read`).then((r) => r.data);

export const markAllNotificationsRead = () =>
  client.post('/notifications/read-all').then((r) => r.data);

/** Accept a triage proposal — adds the ticket to the suggested route. */
export const acceptNotification = (id) =>
  client.post(`/notifications/${id}/accept`).then((r) => r.data);

/** Decline a triage proposal — kicks off a re-triage that skips the declined route. */
export const declineNotification = (id) =>
  client.post(`/notifications/${id}/decline`).then((r) => r.data);

/** Builds the SSE URL with the JWT in the query string (EventSource cannot send headers). */
export function buildStreamUrl() {
  const base = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '');
  const token = encodeURIComponent(localStorage.getItem('token') || '');
  return `${base}/notifications/stream?token=${token}`;
}
