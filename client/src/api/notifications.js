import client from './client';

/* ── Bell notifications ───────────────────────────────────── */
export const getNotifications = (params) =>
  client.get('/notifications', { params }).then((r) => r.data);

export const markNotificationRead = (id) =>
  client.post(`/notifications/${id}/read`).then((r) => r.data);

export const markAllNotificationsRead = () =>
  client.post('/notifications/read-all').then((r) => r.data);

/** Builds the SSE URL with the JWT in the query string (EventSource cannot send headers). */
export function buildStreamUrl() {
  const base = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '');
  const token = encodeURIComponent(localStorage.getItem('token') || '');
  return `${base}/notifications/stream?token=${token}`;
}
