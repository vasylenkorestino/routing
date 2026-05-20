import client from './client';

/** POST /api/auth/login */
export const login = async (email, password) => {
  const { data } = await client.post('/auth/login', { email, password });
  localStorage.setItem('token', data.token);
  localStorage.setItem('driver', JSON.stringify(data.driver));
  return data;
};

/** POST /api/auth/register — set password from encrypted invite token */
export const register = (token, password) =>
  client.post('/auth/register', { token, password }).then((r) => r.data);

/** GET /api/auth/resolve-invite — decrypt invite token to get email */
export const resolveInvite = (token) =>
  client.get('/auth/resolve-invite', { params: { token } }).then((r) => r.data);

/** POST /api/auth/forgot-password */
export const forgotPassword = (email) =>
  client.post('/auth/forgot-password', { email }).then((r) => r.data);

/** POST /api/auth/reset-password */
export const resetPassword = (token, password) =>
  client.post('/auth/reset-password', { token, password }).then((r) => r.data);

/** GET /api/auth/me */
export const getMe = () => client.get('/auth/me').then((r) => r.data);

/** Clear local session */
export const logout = () => {
  localStorage.removeItem('token');
  localStorage.removeItem('driver');
};
