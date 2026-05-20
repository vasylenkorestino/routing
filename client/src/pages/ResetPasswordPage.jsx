import { useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import * as authApi from '../api/auth';

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (password.length < 6) { setError('Password must be at least 6 characters'); return; }
    if (password !== confirm) { setError('Passwords do not match'); return; }
    setLoading(true);
    try {
      await authApi.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Reset failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-800 to-primary p-4">
      <div className="w-full max-w-sm bg-surface rounded-2xl shadow-xl p-10">
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-xl bg-primary inline-flex items-center justify-center text-white text-2xl font-bold mb-3 shadow-lg shadow-primary/30">U</div>
          <h1 className="text-xl font-bold text-txt">Set New Password</h1>
          <p className="text-sm text-txt-secondary mt-1">Enter your new password</p>
        </div>

        {done ? (
          <div className="text-center">
            <div className="w-12 h-12 rounded-full bg-success/10 flex items-center justify-center mx-auto mb-3">
              <svg className="w-6 h-6 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
            </div>
            <p className="text-sm font-medium text-txt mb-1">Password updated!</p>
            <p className="text-xs text-txt-secondary mb-4">You can now sign in with your new password.</p>
            <button onClick={() => navigate('/login')} className="w-full h-11 rounded-lg bg-primary text-white text-[15px] font-semibold hover:bg-primary-hover transition shadow-md shadow-primary/20">
              Go to Login
            </button>
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            {error && <div className="bg-error-bg text-error text-sm p-2.5 rounded-lg text-center font-medium">{error}</div>}
            <div>
              <label className="block text-sm font-medium text-txt mb-1.5">New Password</label>
              <input className="w-full h-11 px-3 rounded-lg border border-border bg-bg text-txt text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-light transition" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Min 6 characters" required autoFocus />
            </div>
            <div>
              <label className="block text-sm font-medium text-txt mb-1.5">Confirm Password</label>
              <input className="w-full h-11 px-3 rounded-lg border border-border bg-bg text-txt text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-light transition" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Re-enter password" required />
            </div>
            <button type="submit" disabled={loading} className="w-full h-11 mt-2 rounded-lg bg-primary text-white text-[15px] font-semibold hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed transition shadow-md shadow-primary/20">
              {loading ? 'Updating…' : 'Set New Password'}
            </button>
            <Link to="/login" className="text-xs text-center text-primary hover:underline">Back to Login</Link>
          </form>
        )}
      </div>
    </div>
  );
}
