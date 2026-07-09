import { useState, useEffect } from 'react';
import { getLastServices } from '../../api/routing';
import { SERVICE_TYPES, SUB_TYPES } from '../../utils/serviceTypes';

/**
 * Controlled editor for a single stop's service fields (Service Type, Sub Type,
 * Notes, Is Full, Fixed) plus the account's recent service history. Shared by the
 * inline route editor and the map Layers list so both stay consistent.
 *
 * @param values   Route__c-shaped object providing the current field values.
 * @param onChange (field, value) => void — called per field edit.
 * @param layout   'row' (wide, side-by-side) or 'stack' (narrow panels).
 */
export default function StopEditFields({ values, onChange, accountId, accountName, layout = 'row' }) {
  const [services, setServices] = useState(null);
  const [loading, setLoading] = useState(false);
  const serviceType = values.ServiceType__c || 'UCO Collection';

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    setLoading(true);
    getLastServices(accountId)
      .then((res) => { if (!cancelled) setServices(res.services ?? res ?? []); })
      .catch(() => { if (!cancelled) setServices([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [accountId]);

  const stacked = layout === 'stack';

  return (
    <div className={stacked ? 'flex flex-col gap-3 p-3' : 'flex gap-4 p-3'}>
      {/* Edit fields */}
      <div className={`flex flex-col gap-2 ${stacked ? '' : 'w-[260px] shrink-0'}`}>
        <Field label="Service Type">
          <select
            className="input-field w-full text-[12px]"
            value={serviceType}
            onChange={(e) => { onChange('ServiceType__c', e.target.value); onChange('ServiceSubType__c', ''); }}
          >
            {SERVICE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        {SUB_TYPES[serviceType] && (
          <Field label="Sub Type">
            <select
              className="input-field w-full text-[12px]"
              value={values.ServiceSubType__c || ''}
              onChange={(e) => onChange('ServiceSubType__c', e.target.value)}
            >
              <option value="">-- None --</option>
              {SUB_TYPES[serviceType].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
        )}
        <Field label="Notes">
          <textarea
            className="input-field w-full text-[12px] h-[80px] resize-y"
            value={values.Notes__c || ''}
            onChange={(e) => onChange('Notes__c', e.target.value)}
            placeholder="Notes…"
          />
        </Field>
        <div className="flex gap-2">
          <Toggle
            label="Is Full"
            active={!!values.isFull__c}
            activeCls="border-warning bg-warning/10 text-warning"
            knobCls="bg-warning"
            onClick={() => onChange('isFull__c', !values.isFull__c)}
          />
          <Toggle
            label="Fixed"
            active={!!values.Fixed_point__c}
            activeCls="border-primary bg-primary/10 text-primary"
            knobCls="bg-primary"
            onClick={() => onChange('Fixed_point__c', !values.Fixed_point__c)}
          />
        </div>
      </div>

      {/* Last services */}
      <div className="flex-1 min-w-0 overflow-auto">
        <div className="text-[11px] font-semibold text-txt-secondary uppercase tracking-wider mb-1">
          Last Services{accountName ? ` — ${accountName}` : ''}
        </div>
        {loading && <div className="text-xs text-txt-secondary animate-pulse py-2">Loading…</div>}
        {!loading && services && services.length === 0 && <div className="text-xs text-txt-secondary py-2">No service history</div>}
        {!loading && services && services.length > 0 && (
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="bg-bg/50">
                <th className="text-left px-2 py-1 font-semibold text-txt-secondary">Ref#</th>
                <th className="text-left px-2 py-1 font-semibold text-txt-secondary">Code</th>
                <th className="text-left px-2 py-1 font-semibold text-txt-secondary">Date</th>
                <th className="text-right px-2 py-1 font-semibold text-txt-secondary">Gal.</th>
                <th className="text-left px-2 py-1 font-semibold text-txt-secondary">Driver Notes</th>
                <th className="text-left px-2 py-1 font-semibold text-txt-secondary">By</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {services.slice(0, 10).map((s, i) => (
                <tr key={s.Id ?? i} className="hover:bg-bg/40">
                  <td className="px-2 py-1 text-txt">{s.Name ?? '—'}</td>
                  <td className="px-2 py-1">
                    {s.Code__c ? <span className="text-[10px] font-semibold bg-primary/10 text-primary px-1.5 py-0.5 rounded">{s.Code__c}</span> : '—'}
                  </td>
                  <td className="px-2 py-1 text-txt tabular-nums">{s.Service_Date__c ?? '—'}</td>
                  <td className="px-2 py-1 text-txt tabular-nums text-right font-medium">{s.Qty_Gallons__c ?? '—'}</td>
                  <td className="px-2 py-1 text-txt-secondary max-w-[100px] truncate" title={s.DriverNotes__c}>{s.DriverNotes__c ?? '—'}</td>
                  <td className="px-2 py-1 text-txt">{s.ServicedBy__c ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/** Pill toggle used for the Is Full / Fixed boolean flags. */
function Toggle({ label, active, activeCls, knobCls, onClick }) {
  return (
    <button
      type="button"
      className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-[12px] font-medium transition cursor-pointer flex-1 ${
        active ? activeCls : 'border-border bg-bg text-txt-secondary hover:border-txt-secondary/40'
      }`}
      onClick={onClick}
    >
      <div className={`relative w-8 h-[18px] rounded-full transition-colors ${active ? knobCls : 'bg-border'}`}>
        <div className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-all ${active ? 'left-[16px]' : 'left-[2px]'}`} />
      </div>
      {label}
    </button>
  );
}

function Field({ label, children, className = '' }) {
  return (
    <div className={`flex flex-col gap-0.5 ${className}`}>
      <label className="text-[11px] font-medium text-txt-secondary">{label}</label>
      {children}
    </div>
  );
}
