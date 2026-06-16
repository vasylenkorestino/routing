import { useState, useCallback } from 'react';
import useStore from '../../store';
import { generateRoutes } from '../../api/routing';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';

const MODE_LOCATION = 'location';
const MODE_SHAPE = 'shape';

/** Modal for AI route generation — choose between Service Location and Shape modes. */
export default function AIGenerateModal({ onClose }) {
  const recordTypes = useStore((st) => st.recordTypes);
  const serviceLocations = useStore((st) => st.serviceLocations);
  const serviceDate = useStore((st) => st.serviceDate);
  const loadPendingReviews = useStore((st) => st.loadPendingReviews);
  const startLocationGeneration = useStore((st) => st.startLocationGeneration);

  const [mode, setMode] = useState(MODE_LOCATION);

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="w-[480px] max-w-[94vw] bg-surface rounded-xl shadow-2xl p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-txt mb-4 flex items-center gap-2">
          <span className="text-ai text-sm">✦</span> Generate AI Routes
        </h3>

        {/* Mode selector */}
        <div className="inline-flex w-full rounded-lg border border-border overflow-hidden mb-4">
          {[
            { id: MODE_LOCATION, label: 'By Service Location' },
            { id: MODE_SHAPE, label: 'By Shape' },
          ].map((m) => (
            <button
              key={m.id}
              className={`flex-1 h-9 text-[13px] font-medium transition border-none ${mode === m.id ? 'bg-ai text-white' : 'bg-surface text-txt-secondary hover:bg-bg'}`}
              onClick={() => setMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>

        {mode === MODE_LOCATION ? (
          <LocationForm
            recordTypes={recordTypes}
            serviceLocations={serviceLocations}
            serviceDate={serviceDate}
            onStart={startLocationGeneration}
            onClose={onClose}
          />
        ) : (
          <ShapeForm
            recordTypes={recordTypes}
            serviceLocations={serviceLocations}
            loadPendingReviews={loadPendingReviews}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  );
}

/** New deterministic Service Location generation form. */
function LocationForm({ recordTypes, serviceLocations, serviceDate, onStart, onClose }) {
  const [form, setForm] = useState({
    date: serviceDate || '',
    recordType: recordTypes?.[0] ?? '',
    depotScope: 'all', // 'all' | 'single'
    serviceLocationId: '',
    maxRadiusMiles: '',
    maxStops: 25,
    minStopsPerRoute: 3,
    maxGallons: 1800,
    maxDurationMin: 480,
    serviceTimeMin: 15,
  });
  const [loading, setLoading] = useState(false);

  const set = useCallback((key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value })), []);

  const handleGenerate = useCallback(async () => {
    if (!form.date) { toast.error('Please select a date'); return; }
    if (form.depotScope === 'single' && !form.serviceLocationId) { toast.error('Please select a service location'); return; }
    setLoading(true);
    try {
      await onStart({
        date: form.date,
        recordType: form.recordType || null,
        serviceLocationId: form.depotScope === 'single' ? form.serviceLocationId : null,
        maxRadiusMiles: form.depotScope === 'single' && form.maxRadiusMiles ? Number(form.maxRadiusMiles) : null,
        maxStops: Number(form.maxStops),
        minStopsPerRoute: Number(form.minStopsPerRoute),
        maxGallons: Number(form.maxGallons),
        maxDurationMin: Number(form.maxDurationMin),
        serviceTimeMin: Number(form.serviceTimeMin),
      });
      onClose?.();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
    setLoading(false);
  }, [form, onStart, onClose]);

  return (
    <>
      <div className="flex gap-3 mb-3">
        <Field label="Service Date" className="flex-1">
          <input type="date" className="input-field" value={form.date} onChange={set('date')} />
        </Field>
        <Field label="Record Type" className="flex-1">
          <select className="input-field" value={form.recordType} onChange={set('recordType')}>
            <option value="">All</option>
            {(recordTypes ?? []).map((rt) => <option key={rt} value={rt}>{rt}</option>)}
          </select>
        </Field>
      </div>

      <Field label="Depot Scope" className="mb-3">
        <select className="input-field" value={form.depotScope} onChange={set('depotScope')}>
          <option value="all">All Service Locations (assign to nearest)</option>
          <option value="single">Single Service Location</option>
        </select>
      </Field>

      {form.depotScope === 'single' && (
        <div className="flex gap-3 mb-3">
          <Field label="Service Location" className="flex-1">
            <select className="input-field" value={form.serviceLocationId} onChange={set('serviceLocationId')}>
              <option value="">Select…</option>
              {(serviceLocations ?? []).map((sl) => (
                <option key={sl.Id ?? sl} value={sl.Id ?? sl}>{sl.Name ?? sl}</option>
              ))}
            </select>
          </Field>
          <Field label="Max Radius (mi)" className="w-[120px]">
            <input type="number" min="0" className="input-field" value={form.maxRadiusMiles} onChange={set('maxRadiusMiles')} placeholder="none" />
          </Field>
        </div>
      )}

      <div className="text-[11px] font-semibold text-txt-secondary uppercase tracking-wide mb-2">Route Limits</div>
      <div className="grid grid-cols-2 gap-3 mb-4">
        <Field label="Min Stops / Route"><input type="number" min="1" className="input-field" value={form.minStopsPerRoute} onChange={set('minStopsPerRoute')} /></Field>
        <Field label="Max Stops / Route"><input type="number" min="1" className="input-field" value={form.maxStops} onChange={set('maxStops')} /></Field>
        <Field label="Max Gallons / Route"><input type="number" min="1" className="input-field" value={form.maxGallons} onChange={set('maxGallons')} /></Field>
        <Field label="Max Duration (min)"><input type="number" min="30" className="input-field" value={form.maxDurationMin} onChange={set('maxDurationMin')} /></Field>
        <Field label="Service Time / Stop (min)" className="col-span-2"><input type="number" min="0" className="input-field" value={form.serviceTimeMin} onChange={set('serviceTimeMin')} /></Field>
      </div>

      <Actions loading={loading} onClose={onClose} onGenerate={handleGenerate} label="Generate" />
    </>
  );
}

/** Existing AI generate behavior (unchanged) — date range, record type, location, message. */
function ShapeForm({ recordTypes, serviceLocations, loadPendingReviews, onClose }) {
  const [form, setForm] = useState({
    fromDate: '', toDate: '', recordType: recordTypes?.[0] ?? '', serviceLocation: '', message: '',
  });
  const [loading, setLoading] = useState(false);

  const set = useCallback((key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value })), []);

  const handleGenerate = useCallback(async () => {
    if (!form.fromDate) { toast.error('Please select a from date'); return; }
    setLoading(true);
    try {
      await generateRoutes({
        dateRange: { from: form.fromDate, to: form.toDate || form.fromDate },
        recordType: form.recordType || null,
        serviceLocationId: form.serviceLocation || null,
        message: form.message || null,
      });
      await loadPendingReviews();
      onClose?.();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
    setLoading(false);
  }, [form, onClose, loadPendingReviews]);

  return (
    <>
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

      <Actions loading={loading} onClose={onClose} onGenerate={handleGenerate} label="Generate" />
    </>
  );
}

function Actions({ loading, onClose, onGenerate, label }) {
  return (
    <div className="flex justify-end gap-2 mt-4">
      <button className="h-[34px] px-4 rounded-lg border border-border text-txt text-[13px] font-medium hover:bg-bg transition" onClick={onClose} disabled={loading}>Cancel</button>
      <button className="h-[34px] px-4 rounded-lg bg-ai text-white text-[13px] font-medium hover:bg-ai-hover transition disabled:opacity-50" onClick={onGenerate} disabled={loading}>
        {loading ? 'Starting…' : label}
      </button>
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
