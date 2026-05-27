import { useState, useEffect, useCallback, useRef } from 'react';
import useStore from '../../store';
import { updatePoint } from '../../api/routing';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';

/**
 * Picklist values mirrored from LWC routingPointEditor.noteOptions.
 * `value` MUST match the Salesforce picklist value (Notes2__c) exactly.
 * `tone` drives the colored severity dot in the custom dropdown.
 */
const SERVICE_ISSUE_OPTIONS = [
  { label: 'None', value: '', tone: 'none' },
  { label: 'Not Collected - Low', value: 'Not Collected - Low', tone: 'low' },
  { label: 'Not Collected - Empty', value: 'Not Collected - Empty', tone: 'empty' },
  { label: 'Not Collected - Tank Missing', value: 'Not Collected - Tank Missing', tone: 'missing' },
  { label: 'Inaccessible', value: 'Inaccessible', tone: 'blocked' },
  { label: 'Restaurant Closed', value: 'Restaurant Closed', tone: 'closed' },
];

const TONE_STYLES = {
  none:    { dot: 'bg-border',        text: 'text-txt-secondary italic' },
  low:     { dot: 'bg-yellow-400',    text: 'text-txt' },
  empty:   { dot: 'bg-orange-500',    text: 'text-txt' },
  missing: { dot: 'bg-red-500',       text: 'text-txt' },
  blocked: { dot: 'bg-red-600',       text: 'text-txt' },
  closed:  { dot: 'bg-gray-400',      text: 'text-txt' },
};

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
  const handleNotes2Change = useCallback((value) => {
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
            <IssueSelect value={form.notes2} onChange={handleNotes2Change} />
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

/**
 * Custom dropdown for the Service Issues (Notes2__c) picklist.
 * Replaces the unstyleable native <select> with a themed listbox:
 * severity dots, hover/selected states, click-outside + Escape to close.
 */
function IssueSelect({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef(null);

  const current = SERVICE_ISSUE_OPTIONS.find((o) => o.value === value) || SERVICE_ISSUE_OPTIONS[0];
  const currentTone = TONE_STYLES[current.tone];

  useEffect(() => {
    if (!open) return;
    const idx = SERVICE_ISSUE_OPTIONS.findIndex((o) => o.value === value);
    setHighlight(idx >= 0 ? idx : 0);
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const select = (val) => {
    onChange(val);
    setOpen(false);
  };

  const handleKeyDown = (e) => {
    if (!open && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown')) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, SERVICE_ISSUE_OPTIONS.length - 1)); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    if (e.key === 'Enter')     { e.preventDefault(); select(SERVICE_ISSUE_OPTIONS[highlight].value); }
  };

  return (
    <div ref={rootRef} className="relative" onKeyDown={handleKeyDown}>
      <button
        type="button"
        className="input-field w-full flex items-center justify-between gap-2 cursor-pointer hover:border-primary/40"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 min-w-0">
          <span className={`shrink-0 w-2 h-2 rounded-full ${currentTone.dot}`} />
          <span className={`truncate ${currentTone.text}`}>{current.label}</span>
        </span>
        <svg className={`w-4 h-4 text-txt-secondary transition-transform shrink-0 ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <ul
          role="listbox"
          className="absolute z-20 mt-1 w-full bg-surface border border-border rounded-lg shadow-lg py-1 max-h-64 overflow-auto"
        >
          {SERVICE_ISSUE_OPTIONS.map((o, idx) => {
            const tone = TONE_STYLES[o.tone];
            const isSelected = o.value === value;
            const isHighlight = idx === highlight;
            return (
              <li
                key={o.label}
                role="option"
                aria-selected={isSelected}
                className={`flex items-center gap-2 px-3 py-2 cursor-pointer text-[13px] ${
                  isHighlight ? 'bg-primary-light/40' : 'hover:bg-bg'
                } ${isSelected ? 'font-semibold' : ''}`}
                onMouseEnter={() => setHighlight(idx)}
                onMouseDown={(e) => { e.preventDefault(); select(o.value); }}
              >
                <span className={`shrink-0 w-2 h-2 rounded-full ${tone.dot}`} />
                <span className={`flex-1 truncate ${tone.text}`}>{o.label}</span>
                {isSelected && (
                  <svg className="w-4 h-4 text-primary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
