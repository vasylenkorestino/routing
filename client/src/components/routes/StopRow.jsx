import { useEffect, useRef, useState } from 'react';
import useStore from '../../store';
import * as routingApi from '../../api/routing';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';
import StopEditFields from './StopEditFields';

/** Display label + classes for a Route__c.Status__c value (matches RouteDataTable). */
function stopStatusBadge(raw) {
  const s = raw || '';
  if (s === 'Driver Complete' || s === 'Complete' || s === 'Completed') {
    return { label: 'Complete', cls: 'bg-success-bg text-success border border-success/20' };
  }
  if (s === 'Skipped') return { label: 'Skipped', cls: 'bg-warning-bg text-warning border border-warning/20' };
  if (s === 'Passed') return { label: 'Passed', cls: 'bg-bg text-txt-secondary border border-border' };
  return { label: s || 'New', cls: 'bg-bg text-txt-secondary border border-border' };
}

/** Editable fields persisted when saving an inline stop edit. */
const EDIT_FIELDS = ['ServiceType__c', 'ServiceSubType__c', 'Notes__c', 'isFull__c', 'Fixed_point__c'];

/**
 * Rich stop row shared by the map Layers list — number, account link, address,
 * service/gallons/status badges, edit + remove actions. Editing expands an inline
 * panel below the row (service type, notes, Is Full / Fixed, last services) rather
 * than opening a modal. Syncs hover with the map marker via hoveredStopId.
 * `readOnly` hides the edit/remove actions (e.g. when the route is completed).
 */
export default function StopRow({ stop, index, color, onRemove, readOnly = false }) {
  const sfInstanceUrl = useStore((st) => st.sfInstanceUrl);
  const hovered = useStore((st) => st.hoveredStopId === stop.Id);
  const hoveredFromMap = useStore((st) => st.hoveredStopId === stop.Id && st.hoveredStopSource === 'map');
  const selected = useStore((st) => st.selectedStopId === stop.Id);
  const setHoveredStopId = useStore((st) => st.setHoveredStopId);
  const setSelectedStopId = useStore((st) => st.setSelectedStopId);
  const refreshRoutes = useStore((st) => st.refreshRoutes);
  const rowRef = useRef(null);

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);

  // Map marker hover — bring the matching row into view without stealing focus.
  useEffect(() => {
    if (hoveredFromMap && rowRef.current) {
      rowRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [hoveredFromMap]);

  const openEditor = () => {
    setForm(Object.fromEntries(EDIT_FIELDS.map((f) => [f, stop[f]])));
    setEditing(true);
  };

  const setField = (field, value) => setForm((f) => ({ ...f, [field]: value }));

  const handleSave = async () => {
    if (!stop.Id) return;
    setSaving(true);
    try {
      await routingApi.updatePoint({
        point: { Id: stop.Id, ...Object.fromEntries(EDIT_FIELDS.map((f) => [f, form[f] ?? null])) },
      });
      await refreshRoutes();
      toast.success('Stop updated');
      setEditing(false);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const status = stopStatusBadge(stop.Status__c);
  const gallons = stop.LastGallonsCollected__c;

  return (
    <div ref={rowRef}>
      <div
        className={`flex items-center gap-2 py-1.5 px-2 rounded-lg border text-xs transition cursor-pointer ${
          hovered || selected || editing
            ? 'border-primary/40 bg-primary-light/20 shadow-sm'
            : 'border-transparent hover:bg-bg'
        }`}
        onMouseEnter={() => stop.Id && setHoveredStopId(stop.Id, 'list')}
        onMouseLeave={() => setHoveredStopId(null)}
        onClick={() => stop.Id && setSelectedStopId(stop.Id)}
      >
        <div
          className="w-5 h-5 rounded-full text-white flex items-center justify-center text-[10px] font-semibold shrink-0"
          style={{ background: color }}
        >
          {index + 1}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            {sfInstanceUrl && stop.AccountId__c ? (
              <a
                href={`${sfInstanceUrl}/${stop.AccountId__c}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[12px] font-medium text-primary hover:underline truncate"
                onClick={(e) => e.stopPropagation()}
              >
                {stop.Account_Name__c || stop.Name || '—'}
              </a>
            ) : (
              <span className="text-[12px] font-medium text-txt truncate">{stop.Account_Name__c || stop.Name || '—'}</span>
            )}
            {stop.isFull__c && <span className="text-[8px] font-bold text-white bg-warning rounded px-1 py-px shrink-0">FULL</span>}
            {stop.isAI__c && <span className="text-[8px] font-bold text-white bg-ai rounded px-1 py-px shrink-0">AI</span>}
          </div>
          <div className="text-[10px] text-txt-secondary truncate">{stop.Container_Address__c || '—'}</div>
        </div>

        {gallons != null && gallons !== '' && (
          <span className="text-[9px] font-bold text-primary bg-primary/10 px-1.5 py-0.5 rounded tabular-nums shrink-0">
            {gallons} gal
          </span>
        )}
        <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded shrink-0 ${status.cls}`}>{status.label}</span>

        {!readOnly && (
          <>
            <button
              type="button"
              title={editing ? 'Close editor' : 'Edit stop'}
              className={`w-6 h-6 flex items-center justify-center rounded-md transition shrink-0 ${
                editing ? 'text-primary bg-primary/10' : 'text-txt-secondary hover:text-primary hover:bg-primary/10'
              }`}
              onClick={(e) => { e.stopPropagation(); editing ? setEditing(false) : openEditor(); }}
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
              </svg>
            </button>
            <button
              type="button"
              title="Remove stop"
              className="w-6 h-6 flex items-center justify-center rounded-md text-txt-secondary hover:text-error hover:bg-error-bg transition shrink-0"
              onClick={(e) => { e.stopPropagation(); onRemove?.(stop); }}
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </>
        )}
      </div>

      {/* Inline editor — mirrors the route editor's expandable panel */}
      {editing && (
        <div className="mt-1 mb-1 rounded-lg border border-primary/30 bg-surface shadow-sm overflow-hidden">
          <StopEditFields
            values={form}
            onChange={setField}
            accountId={stop.AccountId__c}
            accountName={stop.Account_Name__c}
            layout="stack"
          />
          <div className="flex justify-end gap-2 px-3 pb-3">
            <button
              type="button"
              className="h-8 px-3 rounded-lg border border-border text-txt text-[12px] font-medium hover:bg-bg transition disabled:opacity-50"
              onClick={() => setEditing(false)}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="button"
              className="h-8 px-3 rounded-lg bg-primary text-white text-[12px] font-medium hover:bg-primary-hover transition disabled:opacity-50"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
