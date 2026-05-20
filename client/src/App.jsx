import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import useStore from './store';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import RoutingPage from './pages/RoutingPage';
import AdminPage from './pages/AdminPage';
import ToastContainer from './components/ui/Toast';

/** Guards routes — redirects to /login when unauthenticated */
function ProtectedRoute({ children }) {
  const token = useStore((s) => s.token);
  if (!token) return <Navigate to="/login" replace />;
  return children;
}

/** Guards admin routes — redirects non-admins to / */
function AdminRoute({ children }) {
  const token = useStore((s) => s.token);
  const driver = useStore((s) => s.driver);
  if (!token) return <Navigate to="/login" replace />;
  if (!driver?.isAdmin) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  const checkAuth = useStore((s) => s.checkAuth);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  return (
    <>
      <ToastContainer />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route
          path="/admin"
          element={
            <AdminRoute>
              <AdminPage />
            </AdminRoute>
          }
        />
        <Route
          path="/*"
          element={
            <ProtectedRoute>
              <RoutingPage />
            </ProtectedRoute>
          }
        />
      </Routes>
    </>
  );
}
