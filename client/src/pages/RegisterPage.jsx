import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import * as authApi from '../api/auth';
import BrandLogo from '../components/ui/BrandLogo';

export default function RegisterPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') || '';

  const [email, setEmail] = useState('');
  const [resolving, setResolving] = useState(true);
  const [invalid, setInvalid] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) { setResolving(false); setInvalid(true); return; }
    authApi.resolveInvite(token)
      .then((data) => { setEmail(data.email); setResolving(false); })
      .catch(() => { setInvalid(true); setResolving(false); });
  }, [token]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (password.length < 6) { setError('Password must be at least 6 characters'); return; }
    if (password !== confirm) { setError('Passwords do not match'); return; }
    setLoading(true);
    try {
      await authApi.register(token, password);
      setDone(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-800 to-primary p-4">
      <div className="w-full max-w-sm bg-surface rounded-2xl shadow-xl p-10">
        <div className="text-center mb-8">
          <BrandLogo />
          <h1 className="text-xl font-bold text-txt">Complete Registration</h1>
          <p className="text-sm text-txt-secondary mt-1">{email || 'Set your password'}</p>
        </div>

        {resolving ? (
          <div className="text-center py-4">
            <p className="text-sm text-txt-secondary">Verifying invitation…</p>
          </div>
        ) : invalid ? (
          <div className="text-center">
            <div className="w-12 h-12 rounded-full bg-error-bg flex items-center justify-center mx-auto mb-3">
              <svg className="w-6 h-6 text-error" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </div>
            <p className="text-sm font-medium text-txt mb-1">Invalid invitation link</p>
            <p className="text-xs text-txt-secondary mb-4">This link is invalid or has expired. Please contact your admin.</p>
            <Link to="/login" className="text-xs text-primary hover:underline">Go to Login</Link>
          </div>
        ) : done ? (
          <div className="text-center">
            <div className="w-12 h-12 rounded-full bg-success/10 flex items-center justify-center mx-auto mb-3">
              <svg className="w-6 h-6 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
            </div>
            <p className="text-sm font-medium text-txt mb-1">Registration complete!</p>
            <p className="text-xs text-txt-secondary mb-4">You can now sign in with your credentials.</p>
            <button onClick={() => navigate('/login')} className="w-full h-11 rounded-lg bg-primary text-white text-[15px] font-semibold hover:bg-primary-hover transition shadow-md shadow-primary/20">
              Go to Login
            </button>
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            {error && <div className="bg-error-bg text-error text-sm p-2.5 rounded-lg text-center font-medium">{error}</div>}
            <div>
              <label className="block text-sm font-medium text-txt mb-1.5">Password</label>
              <input className="w-full h-11 px-3 rounded-lg border border-border bg-bg text-txt text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-light transition" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Min 6 characters" required autoFocus />
            </div>
            <div>
              <label className="block text-sm font-medium text-txt mb-1.5">Confirm Password</label>
              <input className="w-full h-11 px-3 rounded-lg border border-border bg-bg text-txt text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-light transition" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Re-enter password" required />
            </div>
            <button type="submit" disabled={loading} className="w-full h-11 mt-2 rounded-lg bg-primary text-white text-[15px] font-semibold hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed transition shadow-md shadow-primary/20">
              {loading ? 'Setting up…' : 'Create Password'}
            </button>
            <Link to="/login" className="text-xs text-center text-primary hover:underline">Already registered? Sign in</Link>
          </form>
        )}
      </div>
    </div>
  );
}
