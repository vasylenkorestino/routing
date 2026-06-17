import client from './client';

/* ── Data & lists ────────────────────────────────────────── */
export const getRoutingData = (params) => client.get('/routing/data', { params }).then((r) => r.data);
export const getRoutes = (params) => client.get('/routing/routes', { params }).then((r) => r.data);
export const getDrivers = () => client.get('/routing/drivers').then((r) => r.data);
export const getServiceLocations = (params) => client.get('/routing/service-locations', { params }).then((r) => r.data);
export const getRouteByDriver = (params) => client.get('/routing/route-by-driver', { params }).then((r) => r.data);
export const getCompareRoutes = (params) => client.get('/routing/compare-routes', { params }).then((r) => r.data);

/* ── Route mutations ─────────────────────────────────────── */
export const updateRoute = (body) => client.post('/routing/update-route', body).then((r) => r.data);
export const deleteRoute = (id) => client.delete(`/routing/delete-route/${id}`).then((r) => r.data);
export const optimizeRoute = (body) => client.post('/routing/optimize-route', body).then((r) => r.data);
export const localOptimize = (body) => client.post('/routing/local-optimize', body).then((r) => r.data);
export const smartOptimize = (body) => client.post('/routing/smart-optimize', body).then((r) => r.data);
export const splitRoute = (body) => client.post('/routing/split-route', body).then((r) => r.data);
export const combineRoutes = (body) => client.post('/routing/combine-routes', body).then((r) => r.data);
export const completeRoute = (body) => client.post('/routing/complete-route', body).then((r) => r.data);
export const createRoutes = (body) => client.post('/routing/create-routes', body).then((r) => r.data);

/* ── Point mutations ─────────────────────────────────────── */
export const updatePoint = (body) => client.post('/routing/update-point', body).then((r) => r.data);
export const deletePoint = (id) => client.delete(`/routing/delete-point/${id}`).then((r) => r.data);
export const addPoint = (body) => client.post('/routing/add-point', body).then((r) => r.data);

/* ── Shapes & templates ──────────────────────────────────── */
export const getShapes = (params) => client.get('/routing/shapes', { params }).then((r) => r.data);
export const getShapeAccounts = (params) => client.get('/routing/shape-accounts', { params }).then((r) => r.data);
export const getCustomRoutes = (params) => client.get('/routing/custom-routes', { params }).then((r) => r.data);
export const getGoogleRouteTemplates = (params) => client.get('/routing/google-route-templates', { params }).then((r) => r.data);
export const generateRouteByShape = (body) => client.post('/routing/generate-route-by-shape', body).then((r) => r.data);

/* ── Lookup / search ─────────────────────────────────────── */
export const getLastServices = (accountId) => client.get(`/routing/last-services/${accountId}`).then((r) => r.data);
export const getTankSensorData = (accountId) => client.get(`/routing/tank-sensor-data/${accountId}`).then((r) => r.data);
export const searchAccounts = (params) => client.get('/routing/search-accounts', { params }).then((r) => r.data);
export const getWaypoints = (params) => client.get('/routing/waypoints', { params }).then((r) => r.data);
export const getMapData = (params) => client.get('/routing/map-data', { params }).then((r) => r.data);
export const getTickets = (params) => client.get('/routing/tickets', { params }).then((r) => r.data);

/* ── Error logs ──────────────────────────────────────────── */
export const getErrorLogs = (params) => client.get('/routing/error-logs', { params }).then((r) => r.data);

/* ── Action logs ─────────────────────────────────────────── */
export const getActionLogs = (params) => client.get('/routing/action-logs', { params }).then((r) => r.data);

/* ── Salesforce metadata ─────────────────────────────────── */
export const getSfInstanceUrl = () => client.get('/routing/sf-instance-url').then((r) => r.data.instanceUrl);

/* ── AI ──────────────────────────────────────────────────── */
export const getAIPending = (params) => client.get('/routing/ai-pending', { params }).then((r) => r.data);
export const approveAIRoutes = (body) => client.post('/routing/ai-approve', body).then((r) => r.data);
export const declineAIRoutes = (body) => client.post('/routing/ai-decline', body).then((r) => r.data);
export const chat = (body) => client.post('/chat', body).then((r) => r.data);
export const chatAsync = (body) => client.post('/chat/async', body).then((r) => r.data);
export const enhanceRoute = (body) => client.post('/enhance-route', body).then((r) => r.data);
export const enhanceRouteAsync = (body) => client.post('/enhance-route/async', body).then((r) => r.data);
export const getAIJob = (id) => client.get(`/ai-jobs/${id}`).then((r) => r.data);
export const approveRouteLogs = (body) => client.post('/enhance-route/approve', body).then((r) => r.data);
export const getRouteLogs = (googleRouteId) => client.get(`/routing/route-logs/${googleRouteId}`).then((r) => r.data);
export const getRouteLogComments = (routeLogId) => client.get(`/routing/route-log-comments/${routeLogId}`).then((r) => r.data);
export const addRouteLogComment = (routeLogId, body) => client.post('/routing/route-log-comments', { routeLogId, body }).then((r) => r.data);
export const generateRoutes = (body) => client.post('/generate-routes', body).then((r) => r.data);

/* ── AI Generate by Service Location ─────────────────────── */
export const generateRoutesByLocation = (body) => client.post('/generate-routes/by-location', body).then((r) => r.data);
export const getGenerationJob = (id) => client.get(`/generate-routes/jobs/${id}`).then((r) => r.data);
export const commitGeneratedRoutes = (id, body) => client.post(`/generate-routes/jobs/${id}/commit`, body).then((r) => r.data);

/* ── AI route edit proposals (manager approval) ──────────── */
export const getRouteEditProposal = (id) => client.get(`/route-edit/proposals/${id}`).then((r) => r.data);
export const approveRouteEditProposal = (id) => client.post(`/route-edit/proposals/${id}/approve`).then((r) => r.data);
export const declineRouteEditProposal = (id) => client.post(`/route-edit/proposals/${id}/decline`).then((r) => r.data);
