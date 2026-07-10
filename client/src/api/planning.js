import client from './client';

/* ── AI Route Planning workspace API (separate from existing generation) ── */

/** Creates a new planning session. Returns { session }. */
export const createSession = (body) => client.post('/planning/sessions', body).then((r) => r.data);

/** Lists resumable (Planning) sessions. Returns { sessions }. */
export const listSessions = () => client.get('/planning/sessions').then((r) => r.data);

/** Loads a full session (header + mock routes). Returns { session, routes }. */
export const getSession = (id) => client.get(`/planning/sessions/${id}`).then((r) => r.data);

/** Autosaves mock routes / admin notes (optimistic version). Returns { editVersion, saved }. */
export const saveSession = (id, body) => client.patch(`/planning/sessions/${id}`, body).then((r) => r.data);

/** Archives a session. */
export const archiveSession = (id) => client.delete(`/planning/sessions/${id}`).then((r) => r.data);

/** Starts a planner run for a session. Returns { jobId }. */
export const startPlan = (id, body) => client.post(`/planning/sessions/${id}/plan`, body).then((r) => r.data);

/** Polls a planning run (SSE fallback). Returns the job view. */
export const getPlanJob = (id) => client.get(`/planning/jobs/${id}`).then((r) => r.data);

/** Regenerates a single route from a fixed account pool. Returns { route }. */
export const regenerateRoute = (id, body) => client.post(`/planning/sessions/${id}/regenerate-route`, body).then((r) => r.data);

/** Commits approved mock routes into real Google_Route__c / Route__c. */
export const commitSession = (id, body) => client.post(`/planning/sessions/${id}/commit`, body).then((r) => r.data);
