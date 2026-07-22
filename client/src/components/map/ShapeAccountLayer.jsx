import { useCallback, useEffect, useMemo, useState } from 'react';
import { Marker, InfoWindow } from '@react-google-maps/api';
import useStore from '../../store';
import * as routingApi from '../../api/routing';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';
import { isRouteCompleted } from '../../utils/route';

/** Normalizes Services__r from Apex REST (array or { records }). */
function lastService(account) {
  const raw = account?.Services__r;
  const list = Array.isArray(raw) ? raw : raw?.records ?? [];
  return list[0] || null;
}

/** Account Ids already on the selected Google route. */
function routeAccountIdSet(route) {
  const stops = route?.Routes__r?.records ?? route?.Routes__r ?? [];
  const ids = new Set();
  stops.forEach((s) => {
    const id = s.AccountId__c || s.Account__c;
    if (id) ids.add(id);
  });
  return ids;
}

/** Account markers for shapes with "Show Accounts" enabled; supports Add to Route. */
export default function ShapeAccountLayer() {
  const shapeAccountLayers = useStore((s) => s.shapeAccountLayers);
  const setShapeAccountLayer = useStore((s) => s.setShapeAccountLayer);
  const routeId = useStore((s) => s.routeId);
  const route = useStore((s) => s.route);
  const refreshRoutes = useStore((s) => s.refreshRoutes);
  const sfInstanceUrl = useStore((s) => s.sfInstanceUrl);
  const lastServicesCache = useStore((s) => s.lastServicesByAccountId);
  const cacheLastServices = useStore((s) => s.cacheLastServices);
  const [selected, setSelected] = useState(null);
  const [adding, setAdding] = useState(false);
  const [showServices, setShowServices] = useState(false);
  const [services, setServices] = useState(null);
  const [loadingServices, setLoadingServices] = useState(false);

  const onRouteIds = useMemo(() => routeAccountIdSet(route), [route]);

  /** Lazy-loads accounts when a shape's account layer is turned on. */
  useEffect(() => {
    Object.entries(shapeAccountLayers).forEach(([shapeId, layer]) => {
      if (!layer.visible || layer.loaded || layer.loading) return;
      const shape = layer.shape || {};
      setShapeAccountLayer(shapeId, { loading: true });
      routingApi.getShapeAccounts({ shapeId, shapeName: shape.Name || '' })
        .then((data) => {
          const accounts = Array.isArray(data) ? data : data.accounts ?? [];
          setShapeAccountLayer(shapeId, { accounts, loaded: true, loading: false });
        })
        .catch(() => {
          setShapeAccountLayer(shapeId, { accounts: [], loaded: true, loading: false });
          toast.error('Failed to load shape accounts');
        });
    });
  }, [shapeAccountLayers, setShapeAccountLayer]);

  /** Clears Last Services panel when switching selected marker. */
  useEffect(() => {
    setShowServices(false);
    setServices(null);
    setLoadingServices(false);
  }, [selected?.Id]);

  const handleAdd = useCallback(async (account) => {
    if (!routeId) {
      toast.info('Select a route first');
      return;
    }
    if (isRouteCompleted(route)) {
      toast.info('Route is completed — stops cannot be added');
      return;
    }
    setAdding(true);
    try {
      await routingApi.addPoint({ accountId: account.Id, routeId, ticketType: '' });
      await refreshRoutes();
      toast.success(`Added ${account.Name || 'account'} to route`);
      setSelected(null);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setAdding(false);
    }
  }, [routeId, route, refreshRoutes]);

  /** Toggles inline Last Services table for the selected account. */
  const handleLastServices = useCallback(async () => {
    if (showServices) { setShowServices(false); return; }
    setShowServices(true);
    if (services) return;

    const accountId = selected?.Id;
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
    } catch {
      setServices([]);
    } finally {
      setLoadingServices(false);
    }
  }, [showServices, services, selected?.Id, lastServicesCache, cacheLastServices]);

  const markers = [];
  Object.entries(shapeAccountLayers).forEach(([shapeId, layer]) => {
    if (!layer.visible || !layer.accounts?.length) return;
    const color = layer.shape?.Color__c || '#888888';
    layer.accounts.forEach((acct) => {
      if (onRouteIds.has(acct.Id)) return;
      const lat = Number(acct.MALatitude__c);
      const lng = Number(acct.MALongitude__c);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return;
      markers.push({ shapeId, color, acct, lat, lng });
    });
  });

  return (
    <>
      {markers.map(({ shapeId, color, acct, lat, lng }) => (
        <Marker
          key={`${shapeId}-${acct.Id}`}
          position={{ lat, lng }}
          title={acct.Name}
          onClick={() => setSelected({ ...acct, _color: color })}
          icon={{
            path: window.google?.maps?.SymbolPath?.CIRCLE ?? 0,
            scale: 10,
            fillColor: color,
            fillOpacity: 1,
            strokeColor: '#000',
            strokeWeight: 2.5,
          }}
        />
      ))}

      {selected && (
        <InfoWindow
          position={{ lat: Number(selected.MALatitude__c), lng: Number(selected.MALongitude__c) }}
          onCloseClick={() => setSelected(null)}
          options={{ maxWidth: 380 }}
        >
          <div style={{ fontFamily: 'sans-serif', fontSize: 13, minWidth: 200, maxWidth: 360, lineHeight: 1.5 }}>
            <a
              href={sfInstanceUrl && selected.Id ? `${sfInstanceUrl}/${selected.Id}` : '#'}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontWeight: 700, fontSize: 14, display: 'block', marginBottom: 4, color: '#2563eb', textDecoration: 'none' }}
            >
              {selected.Name}
            </a>
            <div style={{ color: '#444', marginBottom: 3 }}>
              <span style={{ fontWeight: 600 }}>Address:</span>{' '}
              {[selected.ShippingStreet, selected.ShippingCity, selected.ShippingState].filter(Boolean).join(', ') || '—'}
            </div>
            <div style={{ color: '#444', marginBottom: 3 }}>
              <span style={{ fontWeight: 600 }}>Status:</span> {selected.Account_Status__c || '—'}
            </div>
            <div style={{ color: '#444', marginBottom: 3 }}>
              <span style={{ fontWeight: 600 }}>Last Serviced:</span>{' '}
              {lastService(selected)?.Service_Date__c
                ? String(lastService(selected).Service_Date__c).slice(0, 15)
                : '—'}
            </div>
            <div style={{ color: '#444', marginBottom: 8 }}>
              <span style={{ fontWeight: 600 }}>Last Gallons:</span>{' '}
              {lastService(selected)?.Qty_Gallons__c ?? '—'}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button
                type="button"
                disabled={adding || !routeId}
                onClick={() => handleAdd(selected)}
                style={{
                  padding: '6px 10px',
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#fff',
                  background: routeId ? '#059669' : '#9ca3af',
                  border: 'none',
                  borderRadius: 6,
                  cursor: routeId ? 'pointer' : 'not-allowed',
                }}
              >
                {adding ? 'Adding…' : 'Add to Route'}
              </button>
              <button
                type="button"
                onClick={handleLastServices}
                style={{
                  padding: '6px 10px',
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#fff',
                  background: showServices ? '#1d4ed8' : '#2563eb',
                  border: 'none',
                  borderRadius: 6,
                  cursor: 'pointer',
                }}
              >
                Last Services
              </button>
            </div>

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
          </div>
        </InfoWindow>
      )}
    </>
  );
}
