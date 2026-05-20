import { useState, useEffect, useCallback, useMemo } from 'react';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import useStore from '../../store';
import * as routingApi from '../../api/routing';
import { getLastServices } from '../../api/routing';
import ConfirmModal from '../ui/ConfirmModal';
import AccountTicketSearch from '../shared/AccountTicketSearch';
import Select from '../ui/Select';
import { OverlaySpinner } from '../ui/Spinner';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';

function reorder(list, startIndex, endIndex) {
  const result = Array.from(list);
  const [removed] = result.splice(startIndex, 1);
  result.splice(endIndex, 0, removed);
  return result;
}

const SERVICE_TYPES = ['UCO Collection', 'Container Service', 'Grease Trap Service', 'Rotisserie Water'];
const SUB_TYPES = {
  'Container Service': [
    'Automated System', 'Deliver Container', 'Deliver Oil Caddy',
    'Pressure Washing', 'Relocate Container', 'Remove Container',
    'Remove FSP Container', 'Replace Container', 'Replace Grill',
    'Replace Key', 'Replace Lock',
  ],
  'Grease Trap Service': ['Grease Trap Cleaning', 'Line Jetting'],
};

/** Maps a ticket description to the correct ServiceType + ServiceSubType */
function resolveServiceType(ticketDesc, isRotisserie) {
  if (!ticketDesc) return { ServiceType__c: isRotisserie ? 'Rotisserie Water' : 'UCO Collection', ServiceSubType__c: '' };
  if (SUB_TYPES['Container Service'].includes(ticketDesc)) return { ServiceType__c: 'Container Service', ServiceSubType__c: ticketDesc };
  if (SUB_TYPES['Grease Trap Service'].includes(ticketDesc)) return { ServiceType__c: 'Grease Trap Service', ServiceSubType__c: ticketDesc };
  if (ticketDesc === 'Rotisserie Water') return { ServiceType__c: 'Rotisserie Water', ServiceSubType__c: '' };
  if (SERVICE_TYPES.includes(ticketDesc)) return { ServiceType__c: ticketDesc, ServiceSubType__c: '' };
  return { ServiceType__c: isRotisserie ? 'Rotisserie Water' : 'UCO Collection', ServiceSubType__c: '' };
}

const COLS_EDIT = ['#', 'Location', 'Address', 'Service Type', 'Last Gal.', 'Notes', 'Is Full', 'Status', ''];

/** Build a Route__c-compatible payload for a single waypoint */
function buildRoutePoint(w, index, route, routeName, serviceDate) {
  const acctId = w.AccountId__c || w.Account__c || null;
  const isExisting = w.Id && !w.Id.startsWith('001');
  return {
    Id: isExisting ? w.Id : null,
    Name: w.Name || routeName || null,
    Account__c: acctId,
    AccountId__c: acctId,
    Account_Name__c: w.Account_Name__c || null,
    Container_Address__c: w.Container_Address__c || null,
    Latitude__c: w.Latitude__c || w.MALatitude__c || null,
    Longitude__c: w.Longitude__c || w.MALongitude__c || null,
    Priority__c: index + 1,
    Google_Route_Id__c: route.Id,
    GRoute_Id__c: route.Id,
    DateOfService__c: w.DateOfService__c || serviceDate || null,
    Status__c: w.Status__c || 'New',
    ServiceType__c: SERVICE_TYPES.includes(w.ServiceType__c) ? w.ServiceType__c : 'UCO Collection',
    ServiceSubType__c: w.ServiceSubType__c || null,
    Notes__c: w.Notes__c || null,
    isFull__c: w.isFull__c || false,
    Fixed_point__c: w.Fixed_point__c || false,
  };
}

/** Inline route editor — replaces RouteCard + RouteDataTable when editing */
export default function RouteEditor() {
  const closeModal = useStore((st) => st.closeModal);
  const route = useStore((st) => st.route);
  const drivers = useStore((st) => st.drivers);
  const serviceLocations = useStore((st) => st.serviceLocations);
  const refreshRoutes = useStore((st) => st.refreshRoutes);
  const sfInstanceUrl = useStore((st) => st.sfInstanceUrl);

  const [name, setName] = useState('');
  const [driverId, setDriverId] = useState('');
  const [serviceDate, setServiceDate] = useState('');
  const [startLoc, setStartLoc] = useState('');
  const [endLoc, setEndLoc] = useState('');
  const [waypoints, setWaypoints] = useState([]);
  const [expandedIdx, setExpandedIdx] = useState(null);
  const [saving, setSaving] = useState(false);
  const [removeTarget, setRemoveTarget] = useState(null);

  useEffect(() => {
    if (!route) return;
    const stops = route.Routes__r?.records ?? route.Routes__r ?? [];
    setName(route.Name || '');
    setDriverId(route.Driver__c || '');
    setServiceDate(route.Service_Date__c || '');
    setStartLoc(route.Service_Location_Start__c || '');
    setEndLoc(route.Service_Location_End__c || '');
    setWaypoints(stops.map((p) => ({ ...p })));
    setExpandedIdx(null);
  }, [route]);

  const addAccount = useCallback((item) => {
    const street = item.ShippingStreet || '';
    const city = item.ShippingCity || '';
    const state = item.ShippingState || '';
    const addr = street + (city ? ' ' + city : '') + (state ? ',' + state : '');
    const ticketDesc = item._source === 'ticket' ? (item.Description || '') : '';
    const { ServiceType__c, ServiceSubType__c } = resolveServiceType(ticketDesc, item.Rotisserie_Collection__c);
    setWaypoints((prev) => [...prev, {
      AccountId__c: item.Id,
      Account__c: item.Id,
      Account_Name__c: item.Name,
      Container_Address__c: addr.trim() || '',
      Latitude__c: item.MALatitude__c || null,
      Longitude__c: item.MALongitude__c || null,
      ServiceType__c,
      ServiceSubType__c,
    }]);
  }, []);

  const removeWaypoint = async (idx) => {
    const wp = waypoints[idx];
    if (wp?.Id) {
      try {
        await routingApi.deletePoint(wp.Id);
      } catch (err) {
        toast.error(getErrorMessage(err));
        setRemoveTarget(null);
        return;
      }
    }
    setWaypoints((prev) => prev.filter((_, i) => i !== idx));
    if (expandedIdx === idx) setExpandedIdx(null);
    else if (expandedIdx > idx) setExpandedIdx(expandedIdx - 1);
    setRemoveTarget(null);
  };

  const updateWaypoint = (idx, field, value) =>
    setWaypoints((prev) => prev.map((w, i) => i === idx ? { ...w, [field]: value } : w));

  const onDragEnd = (result) => {
    if (!result.destination) return;
    setWaypoints((prev) => reorder(prev, result.source.index, result.destination.index));
    setExpandedIdx(null);
  };

  const handleSave = async () => {
    if (!route?.Id) return;
    setSaving(true);
    try {
      const googleRoute = {
        Id: route.Id, Name: name, Driver__c: driverId || null,
        Service_Date__c: serviceDate,
        Service_Location_Start__c: startLoc || null,
        Service_Location_End__c: endLoc || null,
      };
      const routePoints = waypoints.map((w, i) => buildRoutePoint(w, i, route, name, serviceDate));
      await routingApi.updateRoute({ googleRoute, routePoints });
      await routingApi.optimizeRoute({ googleRoute: { Id: route.Id, Driver__c: driverId || null, Service_Location_Start__c: startLoc || route.Service_Location_Start__c, Service_Location_End__c: endLoc || route.Service_Location_End__c }, routePoints });
      await refreshRoutes();
      toast.success('Done! Route saved and optimized.');
      closeModal('isEdit');
    } catch (err) { toast.error(getErrorMessage(err)); }
    finally { setSaving(false); }
  };

  const driverOptions = useMemo(() => [
    { value: '', label: 'Select Driver' },
    ...drivers.map((d) => ({ value: d.Id, label: d.Name })),
  ], [drivers]);

  const locationOptions = useMemo(() => [
    { value: '', label: 'None' },
    ...serviceLocations.map((loc) => ({ value: loc.Id, label: loc.Name })),
  ], [serviceLocations]);

  if (!route) return null;

  const color = route._color ?? '#2563eb';

  return (
    <div className="flex flex-col h-full relative">
      {saving && <OverlaySpinner label="Saving…" />}

      {/* Fixed header section */}
      <div className="shrink-0 flex flex-col gap-2.5 p-4 bg-surface border border-border rounded-xl shadow-sm mx-1 mb-2">
        {/* Title row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-bg text-txt-secondary hover:text-primary transition"
              onClick={() => closeModal('isEdit')}
              title="Back"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
              </svg>
            </button>
            <div className="w-3 h-3 rounded-sm shrink-0" style={{ background: color }} />
            <input
              className="text-[15px] font-semibold text-txt bg-transparent border-b border-transparent hover:border-border focus:border-primary focus:outline-none transition px-0.5 -mx-0.5 w-48"
              value={name}
              onChange={(e) => setName(e.target.value)}
              title="Route Name"
            />
            <span className="text-xs text-txt-secondary bg-bg px-2 py-0.5 rounded tabular-nums">{waypoints.length} stops</span>
          </div>
          <div className="flex gap-1.5">
            <button className="h-7 px-3 rounded-lg border border-border text-txt text-[11px] font-medium hover:bg-bg transition" onClick={() => closeModal('isEdit')}>Cancel</button>
            <button className="h-7 px-3 rounded-lg bg-primary text-white text-[11px] font-semibold hover:bg-primary-hover transition disabled:opacity-50" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save & Optimize'}
            </button>
          </div>
        </div>

        {/* Route settings — compact inline */}
        <div className="flex items-end gap-2 ml-10">
          <Field label="Driver" className="flex-1">
            <Select value={driverId} onChange={setDriverId} options={driverOptions} placeholder="Select Driver" searchable />
          </Field>
          <Field label="Start" className="flex-1">
            <Select value={startLoc} onChange={setStartLoc} options={locationOptions} placeholder="None" searchable />
          </Field>
          <Field label="End" className="flex-1">
            <Select value={endLoc} onChange={setEndLoc} options={locationOptions} placeholder="None" searchable />
          </Field>
        </div>

        {/* Search */}
        <div className="ml-10">
          <AccountTicketSearch mode="edit" onAdd={addAccount} />
        </div>
      </div>

      {/* Scrollable stops list */}
      <div className="flex-1 overflow-auto mx-1">
        <DragDropContext onDragEnd={onDragEnd}>
          <Droppable droppableId="edit-waypoints">
            {(provided) => (
              <div ref={provided.innerRef} {...provided.droppableProps} className="flex flex-col gap-1">
                {waypoints.map((wp, idx) => (
                  <Draggable key={wp.Id || `wp-${idx}`} draggableId={wp.Id || `wp-${idx}`} index={idx}>
                    {(prov, snap) => (
                      <div
                        ref={prov.innerRef}
                        {...prov.draggableProps}
                        style={prov.draggableProps.style}
                        className={`rounded-lg border transition-shadow ${
                          snap.isDragging ? 'border-primary shadow-lg bg-surface' :
                          expandedIdx === idx ? 'border-primary/40 bg-primary-light/10' : 'border-border bg-surface hover:shadow-sm'
                        }`}
                      >
                        {/* Stop row */}
                        <div
                          className="flex items-center gap-2 px-3 py-2 cursor-pointer"
                          onClick={() => setExpandedIdx(expandedIdx === idx ? null : idx)}
                        >
                          {/* Drag handle + number */}
                          <span {...prov.dragHandleProps} className="cursor-grab text-txt-secondary select-none text-sm">⠿</span>
                          <div
                            className="w-6 h-6 rounded-full text-white flex items-center justify-center text-[11px] font-bold shrink-0"
                            style={{ background: color }}
                          >
                            {idx + 1}
                          </div>

                          {/* Main info */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              {sfInstanceUrl && wp.AccountId__c ? (
                                <a href={`${sfInstanceUrl}/${wp.AccountId__c}`} target="_blank" rel="noopener noreferrer" className="text-[13px] font-medium text-primary hover:underline truncate" onClick={(e) => e.stopPropagation()}>
                                  {wp.Account_Name__c || '—'}
                                </a>
                              ) : (
                                <span className="text-[13px] font-medium text-txt truncate">{wp.Account_Name__c || '—'}</span>
                              )}
                              {wp.isFull__c && <span className="text-[9px] font-bold text-white bg-warning rounded px-1.5 py-px">FULL</span>}
                            </div>
                            <div className="text-[11px] text-txt-secondary truncate">{wp.Container_Address__c || '—'}</div>
                          </div>

                          {/* Tags */}
                          <span className="text-[10px] font-medium text-txt-secondary bg-bg px-2 py-0.5 rounded shrink-0">
                            {wp.ServiceType__c || 'UCO Collection'}
                          </span>
                          {wp.LastGallonsCollected__c ? (
                            <span className="text-[10px] font-bold text-primary bg-primary/10 px-1.5 py-0.5 rounded tabular-nums shrink-0">
                              {wp.LastGallonsCollected__c} gal
                            </span>
                          ) : null}
                          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${
                            wp.Status__c === 'Completed' ? 'bg-success-bg text-success' :
                            wp.Status__c === 'Skipped' ? 'bg-warning-bg text-warning' :
                            'bg-bg text-txt-secondary'
                          }`}>{wp.Status__c || 'New'}</span>

                          {/* Fixed point pin */}
                          <button
                            className={`w-6 h-6 flex items-center justify-center rounded-full transition shrink-0 ${wp.Fixed_point__c ? 'bg-primary/15 text-primary' : 'text-border hover:text-txt-secondary'}`}
                            title={wp.Fixed_point__c ? 'Fixed position (click to unpin)' : 'Pin to fixed position'}
                            onClick={(e) => { e.stopPropagation(); updateWaypoint(idx, 'Fixed_point__c', !wp.Fixed_point__c); }}
                          >
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill={wp.Fixed_point__c ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
                            </svg>
                          </button>

                          {/* Expand arrow */}
                          <svg className={`w-3.5 h-3.5 text-txt-secondary shrink-0 transition-transform ${expandedIdx === idx ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                          </svg>

                          {/* Remove */}
                          <button
                            className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-error-bg text-txt-secondary hover:text-error transition shrink-0"
                            title="Remove"
                            onClick={(e) => { e.stopPropagation(); setRemoveTarget(idx); }}
                          >
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>

                        {/* Expanded detail */}
                        {expandedIdx === idx && (
                          <div className="border-t border-border">
                            <ExpandedRow wp={wp} idx={idx} updateWaypoint={updateWaypoint} />
                          </div>
                        )}
                      </div>
                    )}
                  </Draggable>
                ))}
                {provided.placeholder}
              </div>
            )}
          </Droppable>
        </DragDropContext>
      </div>

      <ConfirmModal
        open={removeTarget !== null}
        title="Remove Stop"
        message={removeTarget !== null ? `Remove "${waypoints[removeTarget]?.Account_Name__c || 'Stop'}" from the route?` : ''}
        confirmLabel="Remove"
        variant="danger"
        onConfirm={() => removeWaypoint(removeTarget)}
        onCancel={() => setRemoveTarget(null)}
      />
    </div>
  );
}

/** Expanded row — edit fields + last services */
function ExpandedRow({ wp, idx, updateWaypoint }) {
  const [services, setServices] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!wp.AccountId__c) return;
    let cancelled = false;
    setLoading(true);
    getLastServices(wp.AccountId__c)
      .then((res) => { if (!cancelled) setServices(res.services ?? res ?? []); })
      .catch(() => { if (!cancelled) setServices([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [wp.AccountId__c]);

  return (
    <div className="flex gap-4 p-3">
      {/* Edit fields */}
      <div className="flex flex-col gap-2 w-[260px] shrink-0">
        <Field label="Service Type">
          <select
            className="input-field w-full text-[12px]"
            value={wp.ServiceType__c || 'UCO Collection'}
            onChange={(e) => { updateWaypoint(idx, 'ServiceType__c', e.target.value); updateWaypoint(idx, 'ServiceSubType__c', ''); }}
          >
            {SERVICE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        {SUB_TYPES[wp.ServiceType__c] && (
          <Field label="Sub Type">
            <select className="input-field w-full text-[12px]" value={wp.ServiceSubType__c || ''} onChange={(e) => updateWaypoint(idx, 'ServiceSubType__c', e.target.value)}>
              <option value="">-- None --</option>
              {SUB_TYPES[wp.ServiceType__c].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
        )}
        <Field label="Notes">
          <textarea className="input-field w-full text-[12px] h-[100px] resize-y" value={wp.Notes__c || ''} onChange={(e) => updateWaypoint(idx, 'Notes__c', e.target.value)} placeholder="Notes…" />
        </Field>
        <div className="flex gap-2">
          <button
            type="button"
            className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-[12px] font-medium transition cursor-pointer flex-1 ${
              wp.isFull__c
                ? 'border-warning bg-warning/10 text-warning'
                : 'border-border bg-bg text-txt-secondary hover:border-txt-secondary/40'
            }`}
            onClick={() => updateWaypoint(idx, 'isFull__c', !wp.isFull__c)}
          >
            <div className={`relative w-8 h-[18px] rounded-full transition-colors ${wp.isFull__c ? 'bg-warning' : 'bg-border'}`}>
              <div className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-all ${wp.isFull__c ? 'left-[16px]' : 'left-[2px]'}`} />
            </div>
            Is Full
          </button>
          <button
            type="button"
            className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-[12px] font-medium transition cursor-pointer flex-1 ${
              wp.Fixed_point__c
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border bg-bg text-txt-secondary hover:border-txt-secondary/40'
            }`}
            onClick={() => updateWaypoint(idx, 'Fixed_point__c', !wp.Fixed_point__c)}
          >
            <div className={`relative w-8 h-[18px] rounded-full transition-colors ${wp.Fixed_point__c ? 'bg-primary' : 'bg-border'}`}>
              <div className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-all ${wp.Fixed_point__c ? 'left-[16px]' : 'left-[2px]'}`} />
            </div>
            Fixed
          </button>
        </div>
      </div>

      {/* Last services */}
      <div className="flex-1 min-w-0 overflow-auto">
        <div className="text-[11px] font-semibold text-txt-secondary uppercase tracking-wider mb-1">Last Services</div>
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
                <th className="text-left px-2 py-1 font-semibold text-txt-secondary">Notes</th>
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
                  <td className="px-2 py-1 text-txt-secondary max-w-[100px] truncate" title={s.Notes__c}>{s.Notes__c ?? '—'}</td>
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

function Field({ label, children, className = '' }) {
  return (
    <div className={`flex flex-col gap-0.5 ${className}`}>
      <label className="text-[11px] font-medium text-txt-secondary">{label}</label>
      {children}
    </div>
  );
}
