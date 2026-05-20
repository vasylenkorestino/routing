import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import useStore from '../store';
import * as adminApi from '../api/admin';
import { toast } from '../components/ui/Toast';
import { getErrorMessage } from '../utils/error';
import Spinner from '../components/ui/Spinner';
import Select from '../components/ui/Select';

const STATUS_BADGE = {
  Active: 'bg-emerald-100 text-emerald-700',
  Inactive: 'bg-gray-100 text-gray-500',
};

/** Full-page admin panel for managing RoutingUser__c records */
export default function AdminPage() {
  const navigate = useNavigate();
  const driver = useStore((s) => s.driver);
  const logout = useStore((s) => s.logout);

  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(null);
  const [linkModal, setLinkModal] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminApi.getUsers();
      setUsers(Array.isArray(data) ? data : []);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  const getUserName = (u) => [u.First_Name__c, u.Last_Name__c].filter(Boolean).join(' ') || u.Name__c || '—';

  const filtered = users.filter((u) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return getUserName(u).toLowerCase().includes(q) || (u.Email__c || '').toLowerCase().includes(q);
  });

  const openCreate = () => setModal({ mode: 'create', data: { firstName: '', lastName: '', email: '', isAdmin: false, status: 'Active', password: '' } });
  const openEdit = (u) => setModal({ mode: 'edit', data: { id: u.Id, firstName: u.First_Name__c || '', lastName: u.Last_Name__c || '', email: u.Email__c || '', isAdmin: u.isAdmin__c || false, status: u.Status__c || 'Active', password: '' } });

  const handleDelete = async (u) => {
    if (!confirm(`Delete user "${getUserName(u)}"? This cannot be undone.`)) return;
    try {
      await adminApi.deleteUser(u.Id);
      toast.success('User deleted');
      fetchUsers();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  const handleSave = async (formData) => {
    try {
      const body = { firstName: formData.firstName, lastName: formData.lastName, email: formData.email, isAdmin: formData.isAdmin, status: formData.status };
      if (formData.password) body.password = formData.password;
      if (formData.id) {
        await adminApi.updateUser(formData.id, body);
        toast.success('User updated');
      } else {
        const result = await adminApi.createUser(body);
        if (!formData.password && result.registrationLink) {
          setLinkModal(result.registrationLink);
        } else {
          toast.success('User created');
        }
      }
      setModal(null);
      fetchUsers();
    } catch (err) {
      throw err;
    }
  };

  const handleRegenerateInvite = async (u) => {
    setActionLoading(u.Id);
    try {
      const result = await adminApi.regenerateInvite(u.Id);
      toast.success('New invite link generated and emailed');
      if (result.registrationLink) setLinkModal(result.registrationLink);
      fetchUsers();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setActionLoading(null);
    }
  };

  const handleResetPassword = async (u) => {
    setActionLoading(u.Id);
    try {
      const result = await adminApi.resetUserPassword(u.Id);
      toast.success('Password reset link sent');
      if (result.registrationLink) setLinkModal(result.registrationLink);
      fetchUsers();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setActionLoading(null);
    }
  };

  const handleViewInviteLink = (u) => {
    if (u.inviteLink) setLinkModal(u.inviteLink);
  };

  const fmtDate = (d) => {
    if (!d) return '—';
    try { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
    catch { return d; }
  };

  const getRegStatus = (u) => {
    if (u.isRegistered) return { label: 'Registered', cls: 'bg-emerald-100 text-emerald-700' };
    if (u.inviteLink && !u.inviteExpired) return { label: 'Pending', cls: 'bg-amber-100 text-amber-700' };
    if (u.inviteLink && u.inviteExpired) return { label: 'Expired', cls: 'bg-red-100 text-red-600' };
    return { label: 'No Invite', cls: 'bg-gray-100 text-gray-500' };
  };

  return (
    <div className="flex flex-col h-screen bg-bg">
      <header className="flex items-center gap-3 px-4 py-2 bg-surface border-b border-border shrink-0 h-12">
        <button onClick={() => navigate('/')} className="h-8 w-8 flex items-center justify-center rounded-lg border border-border bg-surface text-txt-secondary hover:bg-bg hover:text-txt transition cursor-pointer" title="Back to Routing">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" /></svg>
        </button>
        <div className="flex items-center gap-2">
          <svg className="w-5 h-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <h1 className="text-sm font-bold text-txt">Admin Panel</h1>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-bg">
          <div className="w-6 h-6 rounded-full bg-primary-light text-primary text-[10px] font-bold flex items-center justify-center">
            {(driver?.name || 'U').charAt(0).toUpperCase()}
          </div>
          <span className="text-[13px] text-txt font-medium max-w-[100px] truncate">{driver?.name || 'Admin'}</span>
        </div>
        <button className="h-8 px-2.5 rounded-lg border border-error/30 bg-surface text-error text-xs font-medium hover:bg-error-bg transition cursor-pointer" onClick={logout}>Logout</button>
      </header>

      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-6xl mx-auto">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-bold text-txt">Users</h2>
              <p className="text-xs text-txt-secondary mt-0.5">{users.length} RoutingUser records</p>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-txt-secondary pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" /></svg>
                <input className="h-8 w-56 pl-8 pr-3 rounded-lg border border-border bg-bg text-txt text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary-light transition" placeholder="Search by name or email..." value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              <button onClick={fetchUsers} disabled={loading} className="h-8 w-8 flex items-center justify-center rounded-lg border border-border bg-surface text-txt-secondary hover:bg-bg hover:text-txt transition disabled:opacity-50 cursor-pointer" title="Refresh">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" /></svg>
              </button>
              <button onClick={openCreate} className="h-8 px-3 rounded-lg bg-primary text-white text-xs font-medium hover:bg-primary-hover transition flex items-center gap-1.5 cursor-pointer">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                New User
              </button>
            </div>
          </div>

          {loading ? (
            <div className="flex flex-col items-center justify-center py-20 gap-2"><Spinner size="lg" /><span className="text-xs text-txt-secondary">Loading users...</span></div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center justify-center py-20 text-sm text-txt-secondary">{search ? 'No users match your search' : 'No users found'}</div>
          ) : (
            <div className="bg-surface border border-border rounded-xl overflow-hidden">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-border bg-bg/50">
                    <th className="px-4 py-2.5 text-[11px] font-semibold text-txt-secondary uppercase tracking-wide">Name</th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold text-txt-secondary uppercase tracking-wide">Email</th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold text-txt-secondary uppercase tracking-wide text-center">Admin</th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold text-txt-secondary uppercase tracking-wide">Status</th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold text-txt-secondary uppercase tracking-wide">Registration</th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold text-txt-secondary uppercase tracking-wide">Created</th>
                    <th className="px-4 py-2.5 text-[11px] font-semibold text-txt-secondary uppercase tracking-wide text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {filtered.map((u) => {
                    const reg = getRegStatus(u);
                    const isLoading = actionLoading === u.Id;
                    return (
                      <tr key={u.Id} className="hover:bg-bg/40 transition">
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-full bg-primary-light text-primary text-[10px] font-bold flex items-center justify-center shrink-0">
                              {getUserName(u).charAt(0).toUpperCase()}
                            </div>
                            <span className="text-[13px] font-medium text-txt">{getUserName(u)}</span>
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-[13px] text-txt-secondary">{u.Email__c || '—'}</td>
                        <td className="px-4 py-2.5 text-center">
                          {u.isAdmin__c ? (
                            <span className="inline-block w-5 h-5 rounded bg-primary-light text-primary text-[10px] font-bold leading-5 text-center">✓</span>
                          ) : (
                            <span className="text-[11px] text-txt-secondary">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${STATUS_BADGE[u.Status__c] || STATUS_BADGE.Active}`}>
                            {u.Status__c || 'Active'}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${reg.cls}`}>{reg.label}</span>
                        </td>
                        <td className="px-4 py-2.5 text-[12px] text-txt-secondary tabular-nums">{fmtDate(u.CreatedDate)}</td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center justify-end gap-1">
                            {/* View invite link (if pending/expired and link exists) */}
                            {!u.isRegistered && u.inviteLink && (
                              <button
                                onClick={() => handleViewInviteLink(u)}
                                className="h-7 w-7 flex items-center justify-center rounded-md text-txt-secondary hover:text-primary hover:bg-primary-light/50 transition cursor-pointer"
                                title="View invite link"
                              >
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-2.54a4.5 4.5 0 00-6.364-6.364L4.5 8.688" /></svg>
                              </button>
                            )}
                            {/* Regenerate invite (if not registered and expired) */}
                            {!u.isRegistered && u.inviteExpired && (
                              <button
                                onClick={() => handleRegenerateInvite(u)}
                                disabled={isLoading}
                                className="h-7 w-7 flex items-center justify-center rounded-md text-txt-secondary hover:text-amber-600 hover:bg-amber-50 transition cursor-pointer disabled:opacity-50"
                                title="Regenerate invite"
                              >
                                {isLoading ? <Spinner size="sm" /> : (
                                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" /></svg>
                                )}
                              </button>
                            )}
                            {/* Reset password (only for registered users) */}
                            {u.isRegistered && (
                              <button
                                onClick={() => handleResetPassword(u)}
                                disabled={isLoading}
                                className="h-7 w-7 flex items-center justify-center rounded-md text-txt-secondary hover:text-amber-600 hover:bg-amber-50 transition cursor-pointer disabled:opacity-50"
                                title="Reset password"
                              >
                                {isLoading ? <Spinner size="sm" /> : (
                                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" /></svg>
                                )}
                              </button>
                            )}
                            <button onClick={() => openEdit(u)} className="h-7 w-7 flex items-center justify-center rounded-md text-txt-secondary hover:text-primary hover:bg-primary-light/50 transition cursor-pointer" title="Edit">
                              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" /></svg>
                            </button>
                            <button onClick={() => handleDelete(u)} className="h-7 w-7 flex items-center justify-center rounded-md text-txt-secondary hover:text-error hover:bg-error-bg transition cursor-pointer" title="Delete">
                              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {modal && <UserModal modal={modal} onClose={() => setModal(null)} onSave={handleSave} />}
      {linkModal && <RegistrationLinkModal link={linkModal} onClose={() => { setLinkModal(null); }} />}
    </div>
  );
}

/** Modal for creating / editing a user */
function UserModal({ modal, onClose, onSave }) {
  const [form, setForm] = useState(modal.data);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const isEdit = modal.mode === 'edit';

  const set = (key, val) => setForm((f) => ({ ...f, [key]: val }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await onSave(form);
    } catch (err) {
      setError(err.response?.data?.error || getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-surface rounded-xl shadow-2xl w-full max-w-md p-6 animate-slide-in" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-bold text-txt mb-4">{isEdit ? 'Edit User' : 'New User'}</h3>
        <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
          {error && <div className="bg-error-bg text-error text-xs p-2 rounded-lg font-medium">{error}</div>}
          <div className="flex items-center gap-3">
            <Field label="First Name" required className="flex-1">
              <input className="w-full h-9 px-3 rounded-lg border border-border bg-bg text-txt text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-light transition" value={form.firstName} onChange={(e) => set('firstName', e.target.value)} required autoFocus />
            </Field>
            <Field label="Last Name" required className="flex-1">
              <input className="w-full h-9 px-3 rounded-lg border border-border bg-bg text-txt text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-light transition" value={form.lastName} onChange={(e) => set('lastName', e.target.value)} required />
            </Field>
          </div>
          <Field label="Email" required>
            <input className="w-full h-9 px-3 rounded-lg border border-border bg-bg text-txt text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-light transition" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} required />
          </Field>
          <Field label={isEdit ? 'New Password (leave blank to keep current)' : 'Password (optional — user can register later)'}>
            <input className="w-full h-9 px-3 rounded-lg border border-border bg-bg text-txt text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-light transition" type="password" value={form.password} onChange={(e) => set('password', e.target.value)} placeholder={isEdit ? '••••••••' : 'Optional'} minLength={form.password ? 6 : undefined} />
          </Field>
          <div className="flex items-center gap-4">
            <Field label="Status" className="flex-1">
              <Select value={form.status} onChange={(v) => set('status', v)} options={[{ value: 'Active', label: 'Active' }, { value: 'Inactive', label: 'Inactive' }]} />
            </Field>
            <Field label="Admin" className="flex-none">
              <button type="button" role="switch" aria-checked={form.isAdmin} onClick={() => set('isAdmin', !form.isAdmin)} className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer ${form.isAdmin ? 'bg-primary' : 'bg-border'}`}>
                <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${form.isAdmin ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </Field>
          </div>
          <div className="flex items-center justify-end gap-2 mt-2">
            <button type="button" onClick={onClose} className="h-9 px-4 rounded-lg border border-border bg-surface text-txt-secondary text-sm font-medium hover:bg-bg transition cursor-pointer">Cancel</button>
            <button type="submit" disabled={saving} className="h-9 px-4 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary-hover disabled:opacity-50 transition cursor-pointer">{saving ? 'Saving...' : isEdit ? 'Update' : 'Create'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, required, className = '', children }) {
  return (
    <div className={className}>
      <label className="block text-xs font-medium text-txt-secondary mb-1">{label}{required && <span className="text-error ml-0.5">*</span>}</label>
      {children}
    </div>
  );
}

/** Modal showing a registration/reset link with copy button */
function RegistrationLinkModal({ link, onClose }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Failed to copy');
    }
  };

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-surface rounded-xl shadow-2xl w-full max-w-lg p-6 animate-slide-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-3">
          <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center">
            <svg className="w-4 h-4 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-2.54a4.5 4.5 0 00-6.364-6.364L4.5 8.688" /></svg>
          </div>
          <h3 className="text-base font-bold text-txt">Registration Link</h3>
        </div>
        <p className="text-xs text-txt-secondary mb-3">Share this link with the user so they can set their password. The link expires in 7 days.</p>
        <div className="flex items-center gap-2">
          <input readOnly value={link} className="flex-1 h-9 px-3 rounded-lg border border-border bg-bg text-txt text-xs font-mono outline-none select-all" onClick={(e) => e.target.select()} />
          <button onClick={handleCopy} className={`h-9 px-3 rounded-lg text-xs font-medium transition flex items-center gap-1.5 shrink-0 cursor-pointer ${copied ? 'bg-emerald-100 text-emerald-700' : 'bg-primary text-white hover:bg-primary-hover'}`}>
            {copied ? (
              <><svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>Copied</>
            ) : (
              <><svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" /></svg>Copy</>
            )}
          </button>
        </div>
        <div className="flex justify-end mt-4">
          <button onClick={onClose} className="h-9 px-4 rounded-lg bg-bg border border-border text-txt text-sm font-medium hover:bg-surface transition cursor-pointer">Done</button>
        </div>
      </div>
    </div>
  );
}
