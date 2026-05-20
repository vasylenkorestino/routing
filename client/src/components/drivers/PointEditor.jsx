import { useState, useCallback } from 'react';
import useStore from '../../store';
import { updatePoint } from '../../api/routing';

const STATUS_OPTIONS = ['Pending', 'Completed', 'Skipped', 'Cancelled'];

/** Modal for editing a single route stop */
export default function PointEditor({ point }) {
  const closeModal = useStore((st) => st.closeModal);
  const refreshRoutes = useStore((st) => st.refreshRoutes);
  const [form, setForm] = useState({
    gallons: point?.GallonsCollected ?? '',
    notes: point?.Notes ?? '',
    driverNotes: point?.DriverNotes ?? '',
    status: point?.Status ?? 'Pending',
    serviceType: point?.ServiceType ?? '',
  });
  const [saving, setSaving] = useState(false);

  const set = useCallback((key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value })), []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await updatePoint({ id: point?.Id, ...form });
      await refreshRoutes();
      closeModal('isEditPoint');
    } catch { /* toast */ }
    setSaving(false);
  }, [form, point, closeModal, refreshRoutes]);

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40" onClick={() => closeModal('isEditPoint')}>
      <div className="w-[420px] max-w-[92vw] max-h-[80vh] overflow-y-auto bg-surface rounded-xl shadow-2xl p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-txt mb-4">Edit Stop</h3>

        <div className="flex flex-col gap-3">
          <Field label="Gallons Collected">
            <input type="number" className="input-field" value={form.gallons} onChange={set('gallons')} />
          </Field>
          <Field label="Notes">
            <textarea className="w-full p-2.5 rounded-lg border border-border bg-surface text-txt text-sm outline-none focus:border-primary resize-y min-h-[60px]" value={form.notes} onChange={set('notes')} />
          </Field>
          <Field label="Driver Notes">
            <textarea className="w-full p-2.5 rounded-lg border border-border bg-surface text-txt text-sm outline-none focus:border-primary resize-y min-h-[60px]" value={form.driverNotes} onChange={set('driverNotes')} />
          </Field>
          <Field label="Status">
            <select className="input-field" value={form.status} onChange={set('status')}>
              {STATUS_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </Field>
          <Field label="Service Type">
            <input className="input-field" value={form.serviceType} onChange={set('serviceType')} />
          </Field>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button className="h-[34px] px-4 rounded-lg border border-border text-txt text-[13px] font-medium hover:bg-bg transition" onClick={() => closeModal('isEditPoint')}>Cancel</button>
          <button className="h-[34px] px-4 rounded-lg bg-primary text-white text-[13px] font-medium hover:bg-primary-hover transition disabled:opacity-50" disabled={saving} onClick={handleSave}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-txt-secondary">{label}</label>
      {children}
    </div>
  );
}
