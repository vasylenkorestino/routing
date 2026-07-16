import { useState, useCallback } from 'react';
import { InfoWindow } from '@react-google-maps/api';
import useStore from '../../store';
import * as routingApi from '../../api/routing';
import ConfirmModal from '../ui/ConfirmModal';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';
import { isRouteCompleted } from '../../utils/route';

/** InfoWindow for route stops — shows account info, Remove + Last Services buttons */
export default function StopInfoWindow({ stop, onClose }) {
  const sfInstanceUrl = useStore((s) => s.sfInstanceUrl);
  const refreshRoutes = useStore((s) => s.refreshRoutes);
  const currentRouteId = useStore((s) => s.routeId);
  const currentRouteName = useStore((s) => s.route?.Name);
  const currentRouteCompleted = useStore((s) => isRouteCompleted(s.route));
  const [removing, setRemoving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // A stop belongs to the current route unless it was clicked on a comparison
  // (historical/completed) route overlay. Only current-route stops can be removed.
  const belongsToCurrent = !stop._googleRouteId || stop._googleRouteId === currentRouteId;
  const [showServices, setShowServices] = useState(false);
  const [services, setServices] = useState(null);
  const [loadingServices, setLoadingServices] = useState(false);
  const [showTankSensor, setShowTankSensor] = useState(false);
  const [tankSensorData, setTankSensorData] = useState(null);
  const [loadingTankSensor, setLoadingTankSensor] = useState(false);

  const doRemove = useCallback(async () => {
    setRemoving(true);
    try {
      await routingApi.deletePoint(stop.Id);
      setConfirmOpen(false);
      await refreshRoutes();
      onClose();
    } catch (err) {
      setRemoving(false);
      setConfirmOpen(false);
      toast.error(getErrorMessage(err));
    }
  }, [stop, refreshRoutes, onClose]);

  const handleAddToCurrent = useCallback(async () => {
    if (!currentRouteId) { toast.info('Please select a route first'); return; }
    setAdding(true);
    try {
      await routingApi.addPoint({ accountId: stop.AccountId__c, routeId: currentRouteId, ticketType: '' });
      await refreshRoutes();
      toast.success(`Added "${stop.Account_Name__c || stop.Name}" to ${currentRouteName || 'current route'}.`);
      onClose();
    } catch (err) {
      setAdding(false);
      toast.error(getErrorMessage(err));
    }
  }, [stop, currentRouteId, currentRouteName, refreshRoutes, onClose]);

  const lastServicesCache = useStore((s) => s.lastServicesByAccountId);
  const cacheLastServices = useStore((s) => s.cacheLastServices);

  const handleLastServices = useCallback(async () => {
    if (showServices) { setShowServices(false); return; }
    setShowServices(true);
    setShowTankSensor(false);
    if (services) return;

    const accountId = stop.AccountId__c;
    const cached = accountId ? lastServicesCache?.[accountId] : null;
    if (cached) {
      setServices(cached.services ?? []);
      return;
    }

    setLoadingServices(true);
    try {
      const res = await routingApi.getLastServices(accountId);
      const list = res.services ?? res ?? [];
      cacheLastServices(accountId, { services: list, account: res.account ?? null });
      setServices(list);
    } catch { setServices([]); }
    setLoadingServices(false);
  }, [showServices, services, stop.AccountId__c, lastServicesCache, cacheLastServices]);

  const handleTankSensor = useCallback(async () => {
    if (showTankSensor) { setShowTankSensor(false); return; }
    setShowTankSensor(true);
    setShowServices(false);
    if (!tankSensorData) {
      setLoadingTankSensor(true);
      try {
        const res = await routingApi.getTankSensorData(stop.AccountId__c);
        setTankSensorData(res);
      } catch { setTankSensorData({ tanks: [], sensors: [], readings: [] }); }
      setLoadingTankSensor(false);
    }
  }, [showTankSensor, tankSensorData, stop.AccountId__c]);

  return (
    <>
    <InfoWindow
      position={{ lat: Number(stop.Latitude__c), lng: Number(stop.Longitude__c) }}
      onCloseClick={onClose}
      options={{ maxWidth: 380 }}
    >
      <div style={{ fontFamily: 'sans-serif', fontSize: 13, minWidth: 240, maxWidth: 360 }}>
        {/* Account name — clickable link */}
        <a
          href={sfInstanceUrl && stop.AccountId__c ? `${sfInstanceUrl}/${stop.AccountId__c}` : '#'}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontWeight: 600, color: '#2563eb', fontSize: 14, marginBottom: 6, display: 'block', textDecoration: 'none' }}
          onMouseEnter={(e) => { e.target.style.textDecoration = 'underline'; }}
          onMouseLeave={(e) => { e.target.style.textDecoration = 'none'; }}
        >
          {stop.Account_Name__c || stop.Name || 'Account'}
        </a>

        {/* Details */}
        <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>
          <strong>Route:</strong> {stop._routeName}
        </div>
        {stop.Container_Address__c && (
          <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>
            <strong>Address:</strong> {stop.Container_Address__c}
          </div>
        )}
        {stop.LastGallonsCollected__c != null && (
          <div style={{ fontSize: 12, marginBottom: 2 }}>
            <strong>Last Gallons Collected:</strong> {stop.LastGallonsCollected__c}
          </div>
        )}
        {stop.Account__r?.Last_Service_Date__c && (
          <div style={{ fontSize: 12, marginBottom: 2 }}>
            <strong>Last Serviced Date:</strong> {stop.Account__r.Last_Service_Date__c}
          </div>
        )}
        {stop.ServiceType__c && (
          <div style={{ fontSize: 12, marginBottom: 2 }}>
            <strong>Service Type:</strong> {stop.ServiceType__c}
            {stop.ServiceSubType__c ? ` ${stop.ServiceSubType__c}` : ''}
          </div>
        )}

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          {/* Completed routes are read-only — no removing/adding stops */}
          {currentRouteCompleted ? null : belongsToCurrent ? (
            <button
              onClick={() => setConfirmOpen(true)}
              disabled={removing}
              style={{
                padding: '5px 14px', fontSize: 12, fontWeight: 600, borderRadius: 6,
                border: 'none', cursor: 'pointer',
                background: '#ef4444', color: '#fff',
                opacity: removing ? 0.5 : 1,
              }}
            >
              {removing ? 'Removing…' : 'Remove'}
            </button>
          ) : (
            <button
              onClick={handleAddToCurrent}
              disabled={adding}
              title={`Add this stop to ${currentRouteName || 'the current route'}`}
              style={{
                padding: '5px 14px', fontSize: 12, fontWeight: 600, borderRadius: 6,
                border: 'none', cursor: 'pointer',
                background: '#16a34a', color: '#fff',
                opacity: adding ? 0.5 : 1,
              }}
            >
              {adding ? 'Adding…' : 'Add to Current Route'}
            </button>
          )}
          <button
            onClick={handleLastServices}
            style={{
              padding: '5px 14px', fontSize: 12, fontWeight: 600, borderRadius: 6,
              border: 'none', cursor: 'pointer',
              background: showServices ? '#1d4ed8' : '#2563eb', color: '#fff',
            }}
          >
            Last Services
          </button>
          <button
            onClick={handleTankSensor}
            style={{
              padding: '5px 14px', fontSize: 12, fontWeight: 600, borderRadius: 6,
              border: 'none', cursor: 'pointer',
              background: showTankSensor ? '#b45309' : '#f59e0b', color: '#fff',
            }}
          >
            HazTrack
          </button>
        </div>

        {/* Inline last services table */}
        {showServices && (
          <div style={{ marginTop: 10, borderTop: '1px solid #e5e7eb', paddingTop: 8, maxHeight: 180, overflowY: 'auto' }}>
            {loadingServices && <div style={{ fontSize: 11, color: '#999' }}>Loading…</div>}
            {!loadingServices && services && services.length === 0 && (
              <div style={{ fontSize: 11, color: '#999' }}>No service history</div>
            )}
            {!loadingServices && services && services.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                    <th style={{ textAlign: 'left', padding: '2px 4px', color: '#666', fontWeight: 600 }}>Date</th>
                    <th style={{ textAlign: 'left', padding: '2px 4px', color: '#666', fontWeight: 600 }}>Code</th>
                    <th style={{ textAlign: 'right', padding: '2px 4px', color: '#666', fontWeight: 600 }}>Gallons</th>
                    <th style={{ textAlign: 'left', padding: '2px 4px', color: '#666', fontWeight: 600 }}>By</th>
                  </tr>
                </thead>
                <tbody>
                  {services.slice(0, 10).map((s, i) => (
                    <tr key={s.Id ?? i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '3px 4px' }}>{s.Service_Date__c ?? '—'}</td>
                      <td style={{ padding: '3px 4px' }}>{s.Code__c ?? '—'}</td>
                      <td style={{ padding: '3px 4px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{s.Qty_Gallons__c ?? '—'}</td>
                      <td style={{ padding: '3px 4px', color: '#888' }}>{s.ServicedBy__c ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* Inline HazTrack tank & sensor data */}
        {showTankSensor && (
          <div style={{ marginTop: 10, borderTop: '1px solid #e5e7eb', paddingTop: 8, maxHeight: 220, overflowY: 'auto' }}>
            {loadingTankSensor && <div style={{ fontSize: 11, color: '#999' }}>Loading…</div>}
            {!loadingTankSensor && tankSensorData && (tankSensorData.tanks?.length === 0 && tankSensorData.sensors?.length === 0 && tankSensorData.readings?.length === 0) && (
              <div style={{ fontSize: 11, color: '#999' }}>No HazTrack data</div>
            )}
            {!loadingTankSensor && tankSensorData && (tankSensorData.tanks?.length > 0 || tankSensorData.sensors?.length > 0) && (
              <>
                {tankSensorData.tanks?.length > 0 && (() => {
                  const t = tankSensorData.tanks[0];
                  return (
                    <div style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: '#666', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                        Tank
                        {t.Status__c && (
                          <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4, background: t.Status__c === 'critical' ? '#fee2e2' : t.Status__c === 'active' ? '#dcfce7' : '#f3f4f6', color: t.Status__c === 'critical' ? '#dc2626' : t.Status__c === 'active' ? '#16a34a' : '#666' }}>
                            {t.Status__c}
                          </span>
                        )}
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 12px', fontSize: 11 }}>
                        <div><span style={{ color: '#999' }}>Name:</span> {t.Name}</div>
                        <div><span style={{ color: '#999' }}>Max Vol:</span> {t.MaxVolumeF__c != null ? `${t.MaxVolumeF__c} GL` : '—'}</div>
                        <div><span style={{ color: '#999' }}>Last Vol:</span> {t.LastVolume__c != null ? `${t.LastVolume__c} GL` : '—'}</div>
                        <div><span style={{ color: '#999' }}>Recorded:</span> {t.LastRecordOn__c ? new Date(t.LastRecordOn__c).toLocaleDateString() : '—'}</div>
                      </div>
                    </div>
                  );
                })()}
                {tankSensorData.sensors?.length > 0 && (() => {
                  const s = tankSensorData.sensors[0];
                  return (
                    <div style={{ marginBottom: 8, borderTop: '1px solid #f3f4f6', paddingTop: 6 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: '#666', marginBottom: 4 }}>Sensor</div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 12px', fontSize: 11 }}>
                        <div><span style={{ color: '#999' }}>Name:</span> {s.SensorName__c ?? s.Name}</div>
                        <div><span style={{ color: '#999' }}>Temp:</span> {s.LastRecordTemperatureF__c != null ? `${s.LastRecordTemperatureF__c} F` : '—'}</div>
                        <div style={{ gridColumn: '1 / -1' }}><span style={{ color: '#999' }}>Recorded:</span> {s.LastRecordOn__c ? new Date(s.LastRecordOn__c).toLocaleDateString() : '—'}</div>
                      </div>
                    </div>
                  );
                })()}
                {tankSensorData.readings?.length > 0 && (
                  <div style={{ borderTop: '1px solid #f3f4f6', paddingTop: 6 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#666', marginBottom: 4 }}>Recent Readings ({tankSensorData.readings.length})</div>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                          <th style={{ textAlign: 'right', padding: '2px 4px', color: '#666', fontWeight: 600 }}>Reading</th>
                          <th style={{ textAlign: 'right', padding: '2px 4px', color: '#666', fontWeight: 600 }}>Temp</th>
                          <th style={{ textAlign: 'left', padding: '2px 4px', color: '#666', fontWeight: 600 }}>Date</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tankSensorData.readings.slice(0, 7).map((r, i) => (
                          <tr key={r.Id ?? i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                            <td style={{ padding: '2px 4px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.ReadingF__c ?? '—'}</td>
                            <td style={{ padding: '2px 4px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.TemperatureF__c ?? '—'}</td>
                            <td style={{ padding: '2px 4px', color: '#888' }}>{r.RecordOn__c ? new Date(r.RecordOn__c).toLocaleDateString() : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </InfoWindow>

    <ConfirmModal
      open={confirmOpen}
      title="Remove Stop"
      message={`Are you sure you want to remove "${stop.Account_Name__c || stop.Name}" from ${stop._routeName}?`}
      confirmLabel="Remove"
      cancelLabel="Cancel"
      variant="danger"
      loading={removing}
      onConfirm={doRemove}
      onCancel={() => setConfirmOpen(false)}
    />
    </>
  );
}
