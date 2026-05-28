import { useState } from 'react';
import { Link } from 'react-router-dom';
import * as authApi from '../api/auth';
import BrandLogo from '../components/ui/BrandLogo';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await authApi.forgotPassword(email);
      setSent(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-800 to-primary p-4">
      <div className="w-full max-w-sm bg-surface rounded-2xl shadow-xl p-10">
        <div className="text-center mb-8">
          <BrandLogo />
          <h1 className="text-xl font-bold text-txt">Reset Password</h1>
          <p className="text-sm text-txt-secondary mt-1">Enter your email to receive a reset link</p>
        </div>

        {sent ? (
          <div className="text-center">
            <div className="w-12 h-12 rounded-full bg-success/10 flex items-center justify-center mx-auto mb-3">
              <svg className="w-6 h-6 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" /></svg>
            </div>
            <p className="text-sm font-medium text-txt mb-1">Check your email</p>
            <p className="text-xs text-txt-secondary mb-4">If an account exists for <strong>{email}</strong>, you'll receive a password reset link.</p>
            <Link to="/login" className="text-sm text-primary font-medium hover:underline">Back to Login</Link>
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            {error && <div className="bg-error-bg text-error text-sm p-2.5 rounded-lg text-center font-medium">{error}</div>}
            <div>
              <label className="block text-sm font-medium text-txt mb-1.5">Email</label>
              <input className="w-full h-11 px-3 rounded-lg border border-border bg-bg text-txt text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-light transition" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required autoFocus />
            </div>
            <button type="submit" disabled={loading} className="w-full h-11 mt-2 rounded-lg bg-primary text-white text-[15px] font-semibold hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed transition shadow-md shadow-primary/20">
              {loading ? 'Sending…' : 'Send Reset Link'}
            </button>
            <Link to="/login" className="text-xs text-center text-primary hover:underline">Back to Login</Link>
          </form>
        )}
      </div>
    </div>
  );
}
