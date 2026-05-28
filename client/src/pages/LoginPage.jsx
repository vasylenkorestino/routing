import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import useStore from '../store';
import BrandLogo from '../components/ui/BrandLogo';

export default function LoginPage() {
  const navigate = useNavigate();
  const loginAction = useStore((s) => s.login);
  const token = useStore((s) => s.token);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  if (token) {
    navigate('/', { replace: true });
    return null;
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await loginAction(email, password);
      navigate('/');
    } catch (err) {
      setError(err.response?.data?.error || 'Invalid credentials');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-800 to-primary p-4">
      <div className="w-full max-w-sm bg-surface rounded-2xl shadow-xl overflow-hidden">
        <BrandLogo />
        <div className="p-10 pt-8">
        <div className="text-center mb-8">
          <h1 className="text-xl font-bold text-txt">UCO Routing System</h1>
          <p className="text-sm text-txt-secondary mt-1">Sign in to manage routes</p>
        </div>

        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          {error && (
            <div className="bg-error-bg text-error text-sm p-2.5 rounded-lg text-center font-medium">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-txt mb-1.5">Email</label>
            <input
              className="w-full h-11 px-3 rounded-lg border border-border bg-bg text-txt text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-light transition"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              required
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-txt mb-1.5">Password</label>
            <input
              className="w-full h-11 px-3 rounded-lg border border-border bg-bg text-txt text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-light transition"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full h-11 mt-2 rounded-lg bg-primary text-white text-[15px] font-semibold hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed transition shadow-md shadow-primary/20"
          >
            {loading ? 'Signing in…' : 'Sign In'}
          </button>

          <Link to="/forgot-password" className="text-xs text-center text-primary hover:underline mt-1">
            Forgot password?
          </Link>
        </form>
        </div>
      </div>
    </div>
  );
}
