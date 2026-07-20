import { useState, useEffect } from 'react';
import useStore from '../../store';
import * as routingApi from '../../api/routing';
import { OverlaySpinner } from '../ui/Spinner';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';

/**
 * Polls refreshRoutes until a newly created route appears and is selected.
 * Returns true when a route that was not in `priorIds` becomes the selection.
 */
async function pollForNewRoutes(refreshRoutes, priorIds, maxAttempts = 12, intervalMs = 2500) {
  const before = priorIds instanceof Set
    ? priorIds
    : new Set((useStore.getState().routes || []).map((r) => r.Id ?? r.id));

  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, intervalMs));
    await refreshRoutes({ selectNewRoute: true });
    const selectedId = useStore.getState().routeId;
    if (selectedId && !before.has(selectedId)) return true;
    const grew = (useStore.getState().routes || []).some((r) => !before.has(r.Id ?? r.id));
    if (grew && selectedId && !before.has(selectedId)) return true;
  }
  return false;
}

function formatDate(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return d; }
}

/** Client-side filter over loaded template rows (name, notes, interval, type, dates). */
function matchesTemplateSearch(template, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    template.Name,
    template.Notes__c,
    template.Interval__c,
    template.StopsCompleted__c,
    template._type === 'shape' ? 'shape' : 'custom',
    formatDate(template.Last_Route_Serviced_Date__c),
    formatDate(template.FutureServiceDate__c),
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(q);
}

/** Modal for creating new routes — choose template or build from scratch */
export default function RouteCreator() {
  const isNew = useStore((st) => st.isNew);
  const closeModal = useStore((st) => st.closeModal);
  const serviceDate = useStore((st) => st.serviceDate);
  const recordType = useStore((st) => st.recordType);
  const recordTypes = useStore((st) => st.recordTypes);
  const serviceLocation = useStore((st) => st.serviceLocation);
  const serviceLocations = useStore((st) => st.serviceLocations);
  const refreshRoutes = useStore((st) => st.refreshRoutes);

  const [tab, setTab] = useState('inherit');
  const [templates, setTemplates] = useState([]);
  const [selected, setSelected] = useState([]);
  const [date, setDate] = useState(serviceDate);
  const [routeName, setRouteName] = useState('');
  const [recType, setRecType] = useState(recordType);
  const [svcLoc, setSvcLoc] = useState('');
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [sortKey, setSortKey] = useState('Name');
  const [sortAsc, setSortAsc] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  // Sync modal fields when opened.
  useEffect(() => {
    if (!isNew) return;
    setDate(serviceDate);
    setRecType(recordType);
    setSvcLoc(serviceLocation || '');
    setSelected([]);
    setSearchQuery('');
  }, [isNew, serviceDate, recordType, serviceLocation]);

  // Load inherit templates filtered by service location (Google routes + shapes).
  useEffect(() => {
    if (!isNew) return;
    const locParam = svcLoc || 'All';
    setFetching(true);
    (async () => {
      try {
        const [routeRes, shapeRes] = await Promise.allSettled([
          routingApi.getCustomRoutes({ recordTypeName: recordType, serviceLocationId: locParam }),
          routingApi.getShapes({ recordTypeName: recordType, serviceLocationId: locParam }),
        ]);

        const routes = routeRes.status === 'fulfilled'
          ? (Array.isArray(routeRes.value) ? routeRes.value : [])
          : [];
        const shapes = shapeRes.status === 'fulfilled'
          ? (Array.isArray(shapeRes.value) ? shapeRes.value : [])
          : [];

        const combined = [
          ...routes.map((r) => ({ ...r, _type: 'route' })),
          ...shapes.map((s) => ({ ...s, _type: 'shape' })),
        ];
        setTemplates(combined);
      } catch { setTemplates([]); }
      setFetching(false);
    })();
  }, [isNew, recordType, svcLoc]);

  const toggleTemplate = (id) => {
    setSelected((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  const handleSort = (key) => {
    if (sortKey === key) setSortAsc((v) => !v);
    else { setSortKey(key); setSortAsc(true); }
  };

  const sorted = [...templates]
    .filter((t) => matchesTemplateSearch(t, searchQuery))
    .sort((a, b) => {
    let av = a[sortKey] ?? '';
    let bv = b[sortKey] ?? '';
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    if (av < bv) return sortAsc ? -1 : 1;
    if (av > bv) return sortAsc ? 1 : -1;
    return 0;
  });

  // Inherit: close the modal immediately and finish creation + refresh in the
  // background so the user can keep working; the new route is selected once ready.
  const handleInheritInBackground = () => {
    const routeIds = selected.filter((id) => templates.find((t) => t.Id === id && t._type === 'route'));
    const shapeIds = selected.filter((id) => templates.find((t) => t.Id === id && t._type === 'shape'));
    const selDate = date;
    const priorIds = new Set((useStore.getState().routes || []).map((r) => r.Id ?? r.id));

    closeModal('isNew');
    toast.success('Route creation started in the background…');

    (async () => {
      try {
        const promises = [];
        if (routeIds.length > 0) {
          promises.push(routingApi.createRoutes({ selectedRowIds: routeIds, selectedDate: selDate }));
        }
        if (shapeIds.length > 0) {
          promises.push(routingApi.generateRouteByShape({ shapeIds, serviceDate: selDate }));
        }
        await Promise.all(promises);

        // Poll until the new route is in the list and selected (map + right panel).
        const opened = await pollForNewRoutes(refreshRoutes, priorIds, shapeIds.length > 0 ? 12 : 8, 2500);
        if (opened) toast.success('Route created and opened.');
        else toast.success('Route created. Select it from the route list if it is not open yet.');
      } catch (err) {
        toast.error(getErrorMessage(err));
      }
    })();
  };

  const handleCreate = async () => {
    if (tab === 'inherit') {
      handleInheritInBackground();
      return;
    }
    setLoading(true);
    const priorIds = new Set((useStore.getState().routes || []).map((r) => r.Id ?? r.id));
    try {
      await routingApi.createRoutes({ name: routeName, selectedDate: date, recordTypeName: recType, serviceLocationId: svcLoc });
      const opened = await pollForNewRoutes(refreshRoutes, priorIds, 8, 2000);
      if (opened) toast.success('Done! Route created and opened.');
      else toast.success('Done! Route created.');
      closeModal('isNew');
    } catch (err) { toast.error(getErrorMessage(err)); }
    finally { setLoading(false); }
  };

  if (!isNew) return null;

  const COLS = [
    { key: 'Name', label: 'Name', flex: '2' },
    { key: 'Last_Route_Serviced_Date__c', label: 'Last Serviced', flex: '1' },
    { key: 'FutureServiceDate__c', label: 'Future Date', flex: '1' },
    { key: 'Interval__c', label: 'Interval', flex: '0.8' },
    { key: 'StopsCompleted__c', label: 'Completed', flex: '0.8' },
    { key: 'Notes__c', label: 'Notes', flex: '1' },
    { key: '_type', label: 'Type', flex: '0.6' },
  ];

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/35" onClick={() => closeModal('isNew')}>
      <div className="w-[900px] max-w-[95vw] max-h-[85vh] bg-surface rounded-xl shadow-2xl flex flex-col relative" onClick={(e) => e.stopPropagation()}>
        {loading && <OverlaySpinner label="Creating route…" />}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
          <h3 className="text-base font-semibold text-txt">New Route</h3>
          <button className="text-xl text-txt-secondary hover:text-error transition" onClick={() => closeModal('isNew')}>×</button>
        </div>

        <div className="flex border-b border-border">
          {['inherit', 'scratch'].map((t) => (
            <button
              key={t}
              className={`flex-1 py-2.5 text-center text-[13px] font-medium -mb-px border-b-2 transition ${
                tab === t ? 'text-primary border-primary' : 'text-txt-secondary border-transparent'
              }`}
              onClick={() => setTab(t)}
            >
              {t === 'inherit' ? 'Inherit from Template' : 'Create from Scratch'}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-auto p-5 flex flex-col gap-3">
          <div className="flex gap-3">
            <Field label="Service Date" className="w-48">
              <input type="date" className="input-field" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            {tab === 'inherit' && (
              <Field label="Service Location" className="flex-1">
                <select
                  className="input-field"
                  value={svcLoc}
                  onChange={(e) => {
                    setSvcLoc(e.target.value);
                    setSelected([]);
                    setSearchQuery('');
                  }}
                >
                  <option value="">All</option>
                  {serviceLocations.map((loc) => <option key={loc.Id} value={loc.Id}>{loc.Name}</option>)}
                </select>
              </Field>
            )}
          </div>

          {tab === 'inherit' && (
            <Field label="Search">
              <input
                type="search"
                className="input-field"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter loaded templates by name, notes, interval, type…"
                disabled={fetching}
              />
            </Field>
          )}

          {tab === 'inherit' ? (
            <>
              {fetching ? (
                <div className="text-sm text-txt-secondary text-center py-8">Loading templates…</div>
              ) : templates.length === 0 ? (
                <div className="text-sm text-txt-secondary text-center py-8">No templates found</div>
              ) : sorted.length === 0 ? (
                <div className="text-sm text-txt-secondary text-center py-8">No templates match your search</div>
              ) : (
                <div className="border border-border rounded-lg overflow-hidden">
                  {/* Table header */}
                  <div className="flex items-center bg-bg/60 border-b border-border px-2 py-1.5 gap-1">
                    <div className="w-7 shrink-0" />
                    {COLS.map((c) => (
                      <button
                        key={c.key}
                        className="text-[11px] font-semibold text-txt-secondary uppercase tracking-wide text-left truncate hover:text-txt transition"
                        style={{ flex: c.flex }}
                        onClick={() => handleSort(c.key)}
                      >
                        {c.label}
                        {sortKey === c.key && <span className="ml-0.5">{sortAsc ? '▲' : '▼'}</span>}
                      </button>
                    ))}
                  </div>

                  {/* Table rows */}
                  <div className="max-h-[40vh] overflow-auto divide-y divide-border/50">
                    {sorted.map((t) => {
                      const isSelected = selected.includes(t.Id);
                      return (
                        <label
                          key={t.Id}
                          className={`flex items-center px-2 py-2 gap-1 cursor-pointer transition text-[12px] ${
                            isSelected ? 'bg-primary/5' : 'hover:bg-bg/50'
                          }`}
                        >
                          <div className="w-7 shrink-0 flex items-center justify-center">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleTemplate(t.Id)}
                              className="accent-primary w-3.5 h-3.5"
                            />
                          </div>
                          <span className="text-txt font-medium truncate" style={{ flex: '2' }}>{t.Name}</span>
                          <span className="text-txt-secondary truncate" style={{ flex: '1' }}>{formatDate(t.Last_Route_Serviced_Date__c)}</span>
                          <span className="text-txt-secondary truncate" style={{ flex: '1' }}>{formatDate(t.FutureServiceDate__c)}</span>
                          <span className="text-txt-secondary truncate" style={{ flex: '0.8' }}>{t.Interval__c || ''}</span>
                          <span className="text-txt-secondary truncate" style={{ flex: '0.8' }}>
                            {t.StopsCompleted__c || ''}
                            {t.StopsCompleted__c && ' ✓'}
                          </span>
                          <span className="text-txt-secondary truncate italic" style={{ flex: '1' }}>{t.Notes__c || ''}</span>
                          <span style={{ flex: '0.6' }}>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                              t._type === 'shape' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'
                            }`}>
                              {t._type === 'shape' ? 'Shape' : 'Custom'}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
              {selected.length > 0 && (
                <div className="text-xs text-primary font-medium">{selected.length} template{selected.length > 1 ? 's' : ''} selected</div>
              )}
              {!fetching && templates.length > 0 && searchQuery.trim() && (
                <div className="text-xs text-txt-secondary">
                  Showing {sorted.length} of {templates.length} loaded template{templates.length !== 1 ? 's' : ''}
                </div>
              )}
            </>
          ) : (
            <>
              <Field label="Route Name">
                <input className="input-field" value={routeName} onChange={(e) => setRouteName(e.target.value)} placeholder="e.g. NJ-Mon-01" />
              </Field>
              <Field label="Record Type">
                <select className="input-field" value={recType} onChange={(e) => setRecType(e.target.value)}>
                  {recordTypes.map((rt) => <option key={rt} value={rt}>{rt}</option>)}
                </select>
              </Field>
              <Field label="Service Location">
                <select className="input-field" value={svcLoc} onChange={(e) => setSvcLoc(e.target.value)}>
                  <option value="">Select Location</option>
                  {serviceLocations.map((loc) => <option key={loc.Id} value={loc.Id}>{loc.Name}</option>)}
                </select>
              </Field>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border">
          <button className="h-[34px] px-4 rounded-lg border border-border text-txt text-[13px] font-medium hover:bg-bg transition" onClick={() => closeModal('isNew')}>Cancel</button>
          <button
            className="h-[34px] px-4 rounded-lg bg-primary text-white text-[13px] font-medium hover:bg-primary-hover transition disabled:opacity-50"
            onClick={handleCreate}
            disabled={loading || (tab === 'inherit' && selected.length === 0)}
          >
            {loading ? 'Creating…' : 'Create'}
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
