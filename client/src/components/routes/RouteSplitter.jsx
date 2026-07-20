import { useState, useMemo } from 'react';
import useStore from '../../store';
import * as routingApi from '../../api/routing';
import { OverlaySpinner } from '../ui/Spinner';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';

/** Modal for splitting a route — dual transfer list */
export default function RouteSplitter() {
  const isSplit = useStore((st) => st.isSplit);
  const closeModal = useStore((st) => st.closeModal);
  const route = useStore((st) => st.route);
  const refreshRoutes = useStore((st) => st.refreshRoutes);

  const allStops = useMemo(() => (route?.Routes__r?.records ?? route?.Routes__r ?? []), [route]);

  const [movedIds, setMovedIds] = useState(new Set());
  const [selectedLeft, setSelectedLeft] = useState(new Set());
  const [selectedRight, setSelectedRight] = useState(new Set());
  const [newName, setNewName] = useState('');
  const [loading, setLoading] = useState(false);

  const leftStops = allStops.filter((p) => !movedIds.has(p.Id));
  const rightStops = allStops.filter((p) => movedIds.has(p.Id));

  const moveRight = () => {
    setMovedIds((prev) => { const n = new Set(prev); selectedLeft.forEach((id) => n.add(id)); return n; });
    setSelectedLeft(new Set());
  };
  const moveLeft = () => {
    setMovedIds((prev) => { const n = new Set(prev); selectedRight.forEach((id) => n.delete(id)); return n; });
    setSelectedRight(new Set());
  };
  const toggleSelect = (id, set, setter) => {
    setter(new Set(set.has(id) ? [...set].filter((x) => x !== id) : [...set, id]));
  };

  const beginLocalRouteCreate = useStore((st) => st.beginLocalRouteCreate);
  const endLocalRouteCreate = useStore((st) => st.endLocalRouteCreate);

  const handleSplit = async () => {
    if (!movedIds.size || !newName.trim()) return;
    setLoading(true);
    beginLocalRouteCreate();
    try {
      await routingApi.splitRoute({ googleRoute: { Id: route.Id }, accountIds: [...movedIds], recordTypeName: route.RecordType?.Name });
      await refreshRoutes({ selectNewRoute: true });
      closeModal('isSplit');
    } catch (err) { toast.error(getErrorMessage(err)); }
    finally {
      endLocalRouteCreate();
      setLoading(false);
    }
  };

  if (!isSplit) return null;

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/35" onClick={() => closeModal('isSplit')}>
      <div className="w-[640px] max-w-[94vw] max-h-[85vh] bg-surface rounded-xl shadow-2xl flex flex-col relative" onClick={(e) => e.stopPropagation()}>
        {loading && <OverlaySpinner label="Splitting route…" />}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
          <h3 className="text-base font-semibold text-txt">Split Route — {route?.Name}</h3>
          <button className="text-xl text-txt-secondary hover:text-error transition" onClick={() => closeModal('isSplit')}>×</button>
        </div>

        <div className="flex-1 overflow-auto p-5 flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-txt-secondary">New Route Name</label>
            <input className="input-field" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Enter name for the new route" />
          </div>

          <div className="flex gap-3 min-h-[240px]">
            <TransferBox
              title={`Current Route (${leftStops.length})`}
              items={leftStops}
              selected={selectedLeft}
              onToggle={(id) => toggleSelect(id, selectedLeft, setSelectedLeft)}
            />
            <div className="flex flex-col justify-center gap-2">
              <button className="w-8 h-8 border border-border rounded flex items-center justify-center text-primary hover:bg-primary-light transition" onClick={moveRight}>→</button>
              <button className="w-8 h-8 border border-border rounded flex items-center justify-center text-primary hover:bg-primary-light transition" onClick={moveLeft}>←</button>
            </div>
            <TransferBox
              title={`New Route (${rightStops.length})`}
              items={rightStops}
              selected={selectedRight}
              onToggle={(id) => toggleSelect(id, selectedRight, setSelectedRight)}
              emptyText="Select stops and move them here"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border">
          <button className="h-[34px] px-4 rounded-lg border border-border text-txt text-[13px] font-medium hover:bg-bg transition" onClick={() => closeModal('isSplit')}>Cancel</button>
          <button className="h-[34px] px-4 rounded-lg bg-primary text-white text-[13px] font-medium hover:bg-primary-hover transition disabled:opacity-50" onClick={handleSplit} disabled={loading || !movedIds.size}>
            {loading ? 'Splitting…' : 'Split'}
          </button>
        </div>
      </div>
    </div>
  );
}

function TransferBox({ title, items, selected, onToggle, emptyText }) {
  return (
    <div className="flex-1 flex flex-col border border-border rounded-lg overflow-hidden">
      <div className="px-3 py-2 text-xs font-semibold text-txt-secondary bg-bg border-b border-border">{title}</div>
      <div className="flex-1 overflow-auto">
        {items.map((p) => (
          <button
            key={p.Id}
            className={`flex items-center gap-2 w-full text-left px-3 py-1.5 text-[13px] border-b border-border transition ${
              selected.has(p.Id) ? 'bg-primary-light' : 'hover:bg-bg'
            }`}
            onClick={() => onToggle(p.Id)}
          >
            <input type="checkbox" checked={selected.has(p.Id)} readOnly className="accent-primary" />
            <span className="text-txt">{p.Account_Name__c || p.Id}</span>
          </button>
        ))}
        {!items.length && emptyText && (
          <div className="p-4 text-center text-txt-secondary text-sm">{emptyText}</div>
        )}
      </div>
    </div>
  );
}
