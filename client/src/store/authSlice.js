import * as authApi from '../api/auth';

const getStoredDriver = () => {
  try { return JSON.parse(localStorage.getItem('driver')); } catch { return null; }
};

/** Auth slice — manages JWT token and driver profile */
const authSlice = (set, get) => ({
  driver: getStoredDriver(),
  token: localStorage.getItem('token') || null,
  get isAuthenticated() { return !!this.token; },

  login: async (email, password) => {
    const data = await authApi.login(email, password);
    set({ token: data.token, driver: data.driver });
    return data;
  },

  logout: () => {
    authApi.logout();
    set({ token: null, driver: null });
  },

  checkAuth: async () => {
    const token = get().token;
    if (!token) return;
    try {
      const data = await authApi.getMe();
      set({ driver: data.driver ?? data });
    } catch {
      set({ token: null, driver: null });
      localStorage.removeItem('token');
      localStorage.removeItem('driver');
    }
  },
});

export default authSlice;
