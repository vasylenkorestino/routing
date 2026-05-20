import { useState, useCallback } from 'react';
import useStore from '../../store';
import { generateRoutes } from '../../api/routing';

/** Modal for AI route generation with date range and filters */
export default function AIGenerateModal({ onClose }) {
  const recordTypes = useStore((st) => st.recordTypes);
  const serviceLocations = useStore((st) => st.serviceLocations);
  const loadPendingReviews = useStore((st) => st.loadPendingReviews);

  const [form, setForm] = useState({
    fromDate: '', toDate: '', recordType: recordTypes?.[0] ?? '', serviceLocation: '', message: '',
  });
  const [loading, setLoading] = useState(false);

  const set = useCallback((key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value })), []);

  const handleGenerate = useCallback(async () => {
    setLoading(true);
    try {
      await generateRoutes(form);
      await loadPendingReviews();
      onClose?.();
    } catch { /* toast */ }
    setLoading(false);
  }, [form, onClose, loadPendingReviews]);

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="w-[440px] max-w-[92vw] bg-surface rounded-xl shadow-2xl p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-txt mb-4 flex items-center gap-2">
          <span className="text-ai text-sm">✦</span> Generate AI Routes
        </h3>

        <div className="flex gap-3 mb-3">
          <Field label="From Date" className="flex-1">
            <input type="date" className="input-field" value={form.fromDate} onChange={set('fromDate')} />
          </Field>
          <Field label="To Date" className="flex-1">
            <input type="date" className="input-field" value={form.toDate} onChange={set('toDate')} />
          </Field>
        </div>

        <Field label="Record Type" className="mb-3">
          <select className="input-field" value={form.recordType} onChange={set('recordType')}>
            <option value="">All</option>
            {(recordTypes ?? []).map((rt) => <option key={rt} value={rt}>{rt}</option>)}
          </select>
        </Field>

        <Field label="Service Location" className="mb-3">
          <select className="input-field" value={form.serviceLocation} onChange={set('serviceLocation')}>
            <option value="">All</option>
            {(serviceLocations ?? []).map((sl) => (
              <option key={sl.Id ?? sl} value={sl.Id ?? sl}>{sl.Name ?? sl}</option>
            ))}
          </select>
        </Field>

        <Field label="Message (optional)" className="mb-3">
          <textarea
            className="w-full p-2.5 rounded-lg border border-border bg-surface text-txt text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary-light resize-y min-h-[60px] transition"
            value={form.message}
            onChange={set('message')}
            placeholder="Additional instructions for AI…"
          />
        </Field>

        {loading && <div className="text-center text-sm text-ai font-medium py-2 animate-pulse">Generating routes…</div>}

        <div className="flex justify-end gap-2 mt-4">
          <button className="h-[34px] px-4 rounded-lg border border-border text-txt text-[13px] font-medium hover:bg-bg transition" onClick={onClose} disabled={loading}>Cancel</button>
          <button className="h-[34px] px-4 rounded-lg bg-ai text-white text-[13px] font-medium hover:bg-ai-hover transition disabled:opacity-50" onClick={handleGenerate} disabled={loading}>
            {loading ? 'Generating…' : 'Generate'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children, className = '' }) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <label className="text-xs font-medium text-txt-secondary">{label}</label>
      {children}
    </div>
  );
}
