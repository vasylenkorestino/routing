import { useState, useCallback, useEffect } from 'react';
import useStore from '../../store';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';

/* ── Local-timezone date helpers for the quick range chips ── */
function iso(d) {
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
/** Days until the upcoming Sunday (end of the current week). */
function endOfWeek(d) { const day = d.getDay(); return addDays(d, (7 - day) % 7); }

function quickRange(kind) {
  const today = new Date();
  if (kind === 'tomorrow') { const t = addDays(today, 1); return { from: iso(t), to: iso(t) }; }
  if (kind === 'thisWeek') { return { from: iso(addDays(today, 1)), to: iso(endOfWeek(today)) }; }
  if (kind === 'nextWeek') {
    const nextMon = addDays(endOfWeek(today), 1);
    return { from: iso(nextMon), to: iso(addDays(nextMon, 6)) };
  }
  return { from: iso(today), to: iso(today) };
}

/** Entry modal for the AI Route Planning workspace (separate from AI Generate). */
export default function PlanRoutesModal({ onClose }) {
  const serviceLocations = useStore((s) => s.serviceLocations);
  const serviceDate = useStore((s) => s.serviceDate);
  const startPlanning = useStore((s) => s.startPlanning);
  const loadPlanningSessions = useStore((s) => s.loadPlanningSessions);
  const resumePlanning = useStore((s) => s.resumePlanning);
  const resumeList = useStore((s) => s.planningResumeList);

  const [form, setForm] = useState({
    serviceLocationId: '',
    rangeMode: false,
    dateFrom: serviceDate || iso(new Date()),
    dateTo: serviceDate || iso(new Date()),
    maxStops: 25,
    minStopsPerRoute: 5,
    maxGallons: 1800,
    serviceTimeMin: 15,
    maxDurationMin: '',
  });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => { loadPlanningSessions(); }, [loadPlanningSessions]);

  const set = useCallback((key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value })), []);

  const applyChip = (kind) => {
    const { from, to } = quickRange(kind);
    setForm((f) => ({ ...f, dateFrom: from, dateTo: to, rangeMode: from !== to }));
  };

  const handleGenerate = useCallback(async () => {
    if (!form.dateFrom) { toast.error('Please select a start date'); return; }
    setLoading(true);
    try {
      await startPlanning({
        dateFrom: form.dateFrom,
        dateTo: form.rangeMode ? (form.dateTo || form.dateFrom) : form.dateFrom,
        serviceLocationId: form.serviceLocationId || null,
        maxStops: Number(form.maxStops),
        minStopsPerRoute: Number(form.minStopsPerRoute),
        maxGallons: Number(form.maxGallons),
        serviceTimeMin: Number(form.serviceTimeMin),
        maxDurationMin: form.maxDurationMin ? Number(form.maxDurationMin) : null,
      });
      onClose?.();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
    setLoading(false);
  }, [form, startPlanning, onClose]);

  const doResume = async (id) => {
    setLoading(true);
    try { await resumePlanning(id); onClose?.(); }
    catch (err) { toast.error(getErrorMessage(err)); }
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="w-[520px] max-w-[94vw] max-h-[92vh] overflow-auto bg-surface rounded-xl shadow-2xl p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-txt mb-1 flex items-center gap-2">
          <span className="text-ai text-sm">✦</span> Plan Routes
        </h3>
        <p className="text-[12px] text-txt-secondary mb-4">Build editable mock routes and watch the AI plan them. Nothing is written to Salesforce until you approve.</p>

        <Field label="Service Location" className="mb-3">
          <select className="input-field" value={form.serviceLocationId} onChange={set('serviceLocationId')}>
            <option value="">All Service Locations (assign to nearest)</option>
            {(serviceLocations ?? []).map((sl) => (
              <option key={sl.Id ?? sl} value={sl.Id ?? sl}>{sl.Name ?? sl}</option>
            ))}
          </select>
        </Field>

        {/* Quick range chips */}
        <div className="flex items-center gap-2 mb-3">
          {[
            { id: 'tomorrow', label: 'Tomorrow' },
            { id: 'thisWeek', label: 'This Week' },
            { id: 'nextWeek', label: 'Next Week' },
          ].map((c) => (
            <button
              key={c.id}
              type="button"
              className="h-7 px-3 rounded-full border border-border text-[12px] font-medium text-txt-secondary hover:border-ai hover:text-ai transition bg-surface"
              onClick={() => applyChip(c.id)}
            >
              {c.label}
            </button>
          ))}
          <label className="ml-auto flex items-center gap-1.5 text-[12px] text-txt-secondary cursor-pointer select-none">
            <input type="checkbox" checked={form.rangeMode} onChange={(e) => setForm((f) => ({ ...f, rangeMode: e.target.checked }))} />
            Date range
          </label>
        </div>

        <div className="flex gap-3 mb-3">
          <Field label={form.rangeMode ? 'From' : 'Service Date'} className="flex-1">
            <input type="date" className="input-field" value={form.dateFrom} onChange={set('dateFrom')} />
          </Field>
          {form.rangeMode && (
            <Field label="To" className="flex-1">
              <input type="date" className="input-field" value={form.dateTo} min={form.dateFrom} onChange={set('dateTo')} />
            </Field>
          )}
        </div>

        <button
          type="button"
          className="flex items-center gap-1.5 text-[12px] font-medium text-txt-secondary hover:text-txt transition mb-2 bg-transparent border-none p-0"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          <span className={`transition-transform ${showAdvanced ? 'rotate-90' : ''}`}>▸</span>
          Advanced settings (guidance, not hard limits)
        </button>
        {showAdvanced && (
          <div className="grid grid-cols-2 gap-3 mb-4 p-3 rounded-lg bg-bg/40 border border-border/60">
            <Field label="Min Stops / Route"><input type="number" min="1" className="input-field" value={form.minStopsPerRoute} onChange={set('minStopsPerRoute')} /></Field>
            <Field label="Target Max Stops / Route"><input type="number" min="1" className="input-field" value={form.maxStops} onChange={set('maxStops')} /></Field>
            <Field label="Target Max Gallons / Route"><input type="number" min="1" className="input-field" value={form.maxGallons} onChange={set('maxGallons')} /></Field>
            <Field label="Service Time / Stop (min)"><input type="number" min="0" className="input-field" value={form.serviceTimeMin} onChange={set('serviceTimeMin')} /></Field>
            <Field label="Max Duration (min, optional)" className="col-span-2"><input type="number" min="30" className="input-field" value={form.maxDurationMin} onChange={set('maxDurationMin')} placeholder="no limit" /></Field>
          </div>
        )}

        <div className="flex justify-end gap-2 mt-2">
          <button className="h-[34px] px-4 rounded-lg border border-border text-txt text-[13px] font-medium hover:bg-bg transition" onClick={onClose} disabled={loading}>Cancel</button>
          <button className="h-[34px] px-4 rounded-lg bg-ai text-white text-[13px] font-medium hover:bg-ai-hover transition disabled:opacity-50" onClick={handleGenerate} disabled={loading}>
            {loading ? 'Starting…' : 'Generate'}
          </button>
        </div>

        {/* Resume sessions */}
        {resumeList?.length > 0 && (
          <div className="mt-5 pt-4 border-t border-border">
            <div className="text-[11px] font-semibold text-txt-secondary uppercase tracking-wide mb-2">Resume a planning session</div>
            <div className="space-y-1.5 max-h-[180px] overflow-auto">
              {resumeList.map((s) => (
                <div key={s.id} className="flex items-center gap-2 p-2 rounded-lg border border-border/60 hover:bg-bg/40 transition">
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium text-txt truncate">
                      {s.serviceLocationName || 'All Locations'} · {s.dateFrom}{s.dateTo && s.dateTo !== s.dateFrom ? ` → ${s.dateTo}` : ''}
                    </div>
                    <div className="text-[11px] text-txt-secondary">{s.routeCount} route(s){s.committedCount ? ` · ${s.committedCount} committed` : ''} · opened {s.lastOpened ? new Date(s.lastOpened).toLocaleString() : '—'}</div>
                  </div>
                  <button className="h-7 px-3 rounded-lg bg-primary text-white text-[12px] font-medium hover:bg-primary-hover transition disabled:opacity-50" disabled={loading} onClick={() => doResume(s.id)}>Resume</button>
                </div>
              ))}
            </div>
          </div>
        )}
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
