import { useCallback } from 'react';
import useStore from '../store';

/** Convenience hook for auth actions and state */
const useAuth = () => {
  const driver = useStore((s) => s.driver);
  const token = useStore((s) => s.token);
  const loginFn = useStore((s) => s.login);
  const logoutFn = useStore((s) => s.logout);
  const checkAuthFn = useStore((s) => s.checkAuth);

  const isAuthenticated = !!token;

  const login = useCallback((email, pw) => loginFn(email, pw), [loginFn]);
  const logout = useCallback(() => logoutFn(), [logoutFn]);
  const checkAuth = useCallback(() => checkAuthFn(), [checkAuthFn]);

  return { driver, token, isAuthenticated, login, logout, checkAuth };
};

export default useAuth;
