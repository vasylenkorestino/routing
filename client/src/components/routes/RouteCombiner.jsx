import { useState } from 'react';
import useStore from '../../store';
import * as routingApi from '../../api/routing';
import { OverlaySpinner } from '../ui/Spinner';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';

/** Modal for combining two routes into one */
export default function RouteCombiner() {
  const isCombine = useStore((st) => st.isCombine);
  const closeModal = useStore((st) => st.closeModal);
  const routes = useStore((st) => st.routes);
  const route = useStore((st) => st.route);
  const serviceLocations = useStore((st) => st.serviceLocations);
  const refreshRoutes = useStore((st) => st.refreshRoutes);
  const beginLocalRouteCreate = useStore((st) => st.beginLocalRouteCreate);
  const endLocalRouteCreate = useStore((st) => st.endLocalRouteCreate);

  const [routeA, setRouteA] = useState(route?.Id || '');
  const [routeB, setRouteB] = useState('');
  const [newName, setNewName] = useState('');
  const [startLoc, setStartLoc] = useState('');
  const [endLoc, setEndLoc] = useState('');
  const [loading, setLoading] = useState(false);

  const handleCombine = async () => {
    if (!routeA || !routeB || !newName.trim()) return;
    setLoading(true);
    beginLocalRouteCreate();
    try {
      await routingApi.combineRoutes({
        firstRouteId: routeA, secondRouteId: routeB, newRouteName: newName,
        startLocationId: startLoc, endLocationId: endLoc,
        dateOfService: route?.Service_Date__c, recordTypeName: route?.RecordType?.Name,
      });
      await refreshRoutes({ selectNewRoute: true });
      closeModal('isCombine');
    } catch (err) { toast.error(getErrorMessage(err)); }
    finally {
      endLocalRouteCreate();
      setLoading(false);
    }
  };

  if (!isCombine) return null;

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/35" onClick={() => closeModal('isCombine')}>
      <div className="w-[460px] max-w-[92vw] bg-surface rounded-xl shadow-2xl flex flex-col relative" onClick={(e) => e.stopPropagation()}>
        {loading && <OverlaySpinner label="Combining routes…" />}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
          <h3 className="text-base font-semibold text-txt">Combine Routes</h3>
          <button className="text-xl text-txt-secondary hover:text-error transition" onClick={() => closeModal('isCombine')}>×</button>
        </div>
        <div className="p-5 flex flex-col gap-3">
          <Field label="Route 1">
            <select className="input-field" value={routeA} onChange={(e) => setRouteA(e.target.value)}>
              <option value="">Select route</option>
              {routes.map((r) => <option key={r.Id} value={r.Id}>{r.Name}</option>)}
            </select>
          </Field>
          <Field label="Route 2">
            <select className="input-field" value={routeB} onChange={(e) => setRouteB(e.target.value)}>
              <option value="">Select route</option>
              {routes.filter((r) => r.Id !== routeA).map((r) => <option key={r.Id} value={r.Id}>{r.Name}</option>)}
            </select>
          </Field>
          <Field label="New Route Name">
            <input className="input-field" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Combined route name" />
          </Field>
          <div className="flex gap-3">
            <Field label="Start Location" className="flex-1">
              <select className="input-field" value={startLoc} onChange={(e) => setStartLoc(e.target.value)}>
                <option value="">Select</option>
                {serviceLocations.map((loc) => <option key={loc.Id} value={loc.Id}>{loc.Name}</option>)}
              </select>
            </Field>
            <Field label="End Location" className="flex-1">
              <select className="input-field" value={endLoc} onChange={(e) => setEndLoc(e.target.value)}>
                <option value="">Select</option>
                {serviceLocations.map((loc) => <option key={loc.Id} value={loc.Id}>{loc.Name}</option>)}
              </select>
            </Field>
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border">
          <button className="h-[34px] px-4 rounded-lg border border-border text-txt text-[13px] font-medium hover:bg-bg transition" onClick={() => closeModal('isCombine')}>Cancel</button>
          <button className="h-[34px] px-4 rounded-lg bg-primary text-white text-[13px] font-medium hover:bg-primary-hover transition disabled:opacity-50" onClick={handleCombine} disabled={loading || !routeA || !routeB}>
            {loading ? 'Combining…' : 'Combine'}
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
