import client from './client';

/** GET /api/admin/users */
export const getUsers = () => client.get('/admin/users').then((r) => r.data);

/** POST /api/admin/users */
export const createUser = (body) => client.post('/admin/users', body).then((r) => r.data);

/** PATCH /api/admin/users/:id */
export const updateUser = (id, body) => client.patch(`/admin/users/${id}`, body).then((r) => r.data);

/** DELETE /api/admin/users/:id */
export const deleteUser = (id) => client.delete(`/admin/users/${id}`).then((r) => r.data);

/** POST /api/admin/users/:id/regenerate-invite */
export const regenerateInvite = (id) => client.post(`/admin/users/${id}/regenerate-invite`).then((r) => r.data);

/** POST /api/admin/users/:id/reset-password */
export const resetUserPassword = (id, password) =>
  client.post(`/admin/users/${id}/reset-password`, password ? { password } : {}).then((r) => r.data);
