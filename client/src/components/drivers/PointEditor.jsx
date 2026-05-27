import { useState, useEffect, useCallback } from 'react';
import useStore from '../../store';
import { updatePoint } from '../../api/routing';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';

/**
 * Picklist values mirrored from LWC routingPointEditor.noteOptions.
 * Used for the Notes2__c (Service Issues) field.
 */
const SERVICE_ISSUE_OPTIONS = [
  { label: 'None', value: '' },
  { label: 'Not Collected - Low', value: 'Not Collected - Low' },
  { label: 'Not Collected - Empty', value: 'Not Collected - Empty' },
  { label: 'Not Collected - Tank Missing', value: 'Not Collected - Tank Missing' },
  { label: 'Inaccessible', value: 'Inaccessible' },
  { label: 'Restaurant Closed', value: 'Restaurant Closed' },
];

/**
 * Modal for editing a single Route__c stop.
 * Mirrors the LWC `c-routing-point-editor`: same fields (Gallons_Collected__c, Notes2__c,
 * InvoiceNotes__c, Inactive__c), same status/service-completed derivation, same validation.
 */
export default function PointEditor({ point: propPoint }) {
  const storePoint = useStore((st) => st.editPoint);
  const point = propPoint || storePoint;

  const closeModal = useStore((st) => st.closeModal);
  const refreshRoutes = useStore((st) => st.refreshRoutes);

  const [form, setForm] = useState({
    gallons: '',
    notes2: '',
    invoiceNotes: '',
    inactive: false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [touchedInvoice, setTouchedInvoice] = useState(false);

  useEffect(() => {
    setForm({
      gallons: point?.Gallons_Collected__c ?? '',
      notes2: point?.Notes2__c ?? '',
      invoiceNotes: point?.InvoiceNotes__c ?? '',
      inactive: !!point?.Inactive__c,
    });
    setTouchedInvoice(false);
    setError('');
  }, [point]);

  const set = useCallback((key) => (e) => {
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [key]: value }));
  }, []);

  /** Mirror LWC: when Service Issues changes, copy to InvoiceNotes unless user already edited it. */
  const handleNotes2Change = useCallback((e) => {
    const value = e.target.value;
    setForm((f) => ({
      ...f,
      notes2: value,
      invoiceNotes: touchedInvoice ? f.invoiceNotes : (f.invoiceNotes || value),
    }));
  }, [touchedInvoice]);

  const handleInvoiceChange = useCallback((e) => {
    setTouchedInvoice(true);
    setForm((f) => ({ ...f, invoiceNotes: e.target.value }));
  }, []);

  /** Mirror LWC validate(): Inactive without Service Issues is rejected. */
  function validate(payload) {
    if (payload.Inactive__c && !payload.Notes2__c) {
      setError('Add Service Issues to unserviced point!');
      return false;
    }
    setError('');
    return true;
  }

  /** Mirror LWC handleSubmit() status/service-completed derivation. */
  function deriveStatus(payload) {
    if (payload.Inactive__c) {
      payload.Gallons_Collected__c = null;
      payload.Service_Completed__c = true;
      payload.Status__c = 'Passed';
      return;
    }
    const g = payload.Gallons_Collected__c;
    if (g !== undefined && g !== null && g !== '' && Number(g) >= 0) {
      payload.Service_Completed__c = true;
      payload.Status__c = 'Driver Complete';
    } else {
      payload.Service_Completed__c = false;
      payload.Status__c = 'New';
    }
  }

  const handleSave = useCallback(async () => {
    if (!point?.Id) {
      setError('Missing stop Id.');
      return;
    }
    const payload = {
      Id: point.Id,
      Gallons_Collected__c: form.gallons === '' ? null : Number(form.gallons),
      Notes2__c: form.notes2 || null,
      InvoiceNotes__c: form.invoiceNotes || null,
      Inactive__c: !!form.inactive,
      isChangedByAdmin__c: true,
    };
    if (!validate(payload)) return;
    deriveStatus(payload);

    setSaving(true);
    try {
      await updatePoint({ point: payload });
      await refreshRoutes();
      toast.success('Stop updated');
      closeModal('isEditPoint');
    } catch (err) {
      const msg = getErrorMessage(err) || 'Save failed';
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }, [point, form, closeModal, refreshRoutes]);

  if (!point) return null;

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40" onClick={() => closeModal('isEditPoint')}>
      <div className="w-[460px] max-w-[92vw] max-h-[88vh] overflow-y-auto bg-surface rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-start justify-between gap-3 px-6 py-4 border-b border-border">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-txt truncate" title={point.Account_Name__c}>
              {point.Account_Name__c || 'Edit Stop'}
            </h3>
            {point.Container_Address__c && (
              <p className="text-xs text-txt-secondary truncate mt-0.5" title={point.Container_Address__c}>
                {point.Container_Address__c}
              </p>
            )}
          </div>
          <button
            type="button"
            aria-label="Close"
            className="shrink-0 h-7 w-7 inline-flex items-center justify-center rounded-md text-txt-secondary hover:bg-bg hover:text-txt transition"
            onClick={() => closeModal('isEditPoint')}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="px-6 py-5 flex flex-col gap-4">
          <Field label="Gallons Collected">
            <input
              type="number"
              step="0.01"
              min="0"
              className="input-field"
              value={form.gallons}
              onChange={set('gallons')}
              disabled={form.inactive}
              placeholder={form.inactive ? '— (Inactive)' : '0'}
            />
          </Field>

          <Field label="Service Issues">
            <select className="input-field" value={form.notes2} onChange={handleNotes2Change}>
              {SERVICE_ISSUE_OPTIONS.map((o) => (
                <option key={o.label} value={o.value}>{o.label}</option>
              ))}
            </select>
          </Field>

          <Field label="Invoice Notes">
            <textarea
              className="w-full p-2.5 rounded-lg border border-border bg-surface text-txt text-sm outline-none focus:border-primary resize-y min-h-[60px]"
              value={form.invoiceNotes}
              onChange={handleInvoiceChange}
              placeholder="Customer-facing note shown on the invoice"
            />
          </Field>

          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-border accent-primary"
              checked={form.inactive}
              onChange={set('inactive')}
            />
            <span className="text-sm text-txt">Mark stop as inactive (unserviced)</span>
          </label>

          {error && (
            <div className="text-sm text-error bg-error-bg border border-error/30 rounded-md px-3 py-2">
              {error}
            </div>
          )}
        </div>

        <footer className="flex justify-end gap-2 px-6 py-4 border-t border-border">
          <button
            type="button"
            className="h-9 px-4 rounded-lg border border-border text-txt text-[13px] font-medium hover:bg-bg transition"
            onClick={() => closeModal('isEditPoint')}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="h-9 px-4 rounded-lg bg-primary text-white text-[13px] font-medium hover:bg-primary-hover transition disabled:opacity-50"
            disabled={saving}
            onClick={handleSave}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Small wrapper to keep label/input layout consistent. */
function Field({ label, children }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-txt-secondary">{label}</label>
      {children}
    </div>
  );
}
