import { useCallback, useEffect, useState } from 'react';
import { Marker, InfoWindow } from '@react-google-maps/api';
import useStore from '../../store';
import * as routingApi from '../../api/routing';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';
import { isRouteCompleted } from '../../utils/route';

/**
 * Purple focus pin from AI / "Show on map".
 * Click opens the same account details panel (Add to Route + Last Services).
 */
export default function MapFocusMarker() {
  const marker = useStore((s) => s.mapFocusMarker);
  const clearMapFocusMarker = useStore((s) => s.clearMapFocusMarker);
  const routeId = useStore((s) => s.routeId);
  const route = useStore((s) => s.route);
  const refreshRoutes = useStore((s) => s.refreshRoutes);
  const sfInstanceUrl = useStore((s) => s.sfInstanceUrl);
  const lastServicesCache = useStore((s) => s.lastServicesByAccountId);
  const cacheLastServices = useStore((s) => s.cacheLastServices);

  const [open, setOpen] = useState(true);
  const [adding, setAdding] = useState(false);
  const [showServices, setShowServices] = useState(false);
  const [services, setServices] = useState(null);
  const [loadingServices, setLoadingServices] = useState(false);
  const [account, setAccount] = useState(null);

  /** Auto-open details whenever a new focus pin is placed. */
  useEffect(() => {
    if (!marker) return;
    setOpen(true);
    setShowServices(false);
    setServices(null);
    setAccount(null);
  }, [marker?.accountId, marker?.lat, marker?.lng]);

  /** Lazy-load account details for the info panel when opened. */
  useEffect(() => {
    if (!open || !marker?.accountId || account) return;
    let cancelled = false;
    routingApi.searchAccounts({ searchText: marker.accountName || marker.accountId })
      .then((data) => {
        if (cancelled) return;
        const list = Array.isArray(data) ? data : data.accounts || [];
        const match = list.find((a) => a.Id === marker.accountId) || list[0] || null;
        setAccount(match);
      })
      .catch(() => { if (!cancelled) setAccount(null); });
    return () => { cancelled = true; };
  }, [open, marker?.accountId, marker?.accountName, account]);

  const handleAdd = useCallback(async () => {
    if (!routeId || !marker?.accountId) {
      toast.info('Select a route first');
      return;
    }
    if (isRouteCompleted(route)) {
      toast.info('Route is completed — stops cannot be added');
      return;
    }
    setAdding(true);
    try {
      await routingApi.addPoint({ accountId: marker.accountId, routeId, ticketType: '' });
      await refreshRoutes();
      clearMapFocusMarker();
      toast.success(`Added ${marker.accountName || 'account'} to route`);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setAdding(false);
    }
  }, [routeId, route, marker, refreshRoutes, clearMapFocusMarker]);

  const handleLastServices = useCallback(async () => {
    if (showServices) { setShowServices(false); return; }
    setShowServices(true);
    if (services) return;

    const accountId = marker?.accountId;
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
      if (res.account) setAccount((prev) => prev || res.account);
    } catch {
      setServices([]);
    } finally {
      setLoadingServices(false);
    }
  }, [showServices, services, marker?.accountId, lastServicesCache, cacheLastServices]);

  if (!marker) return null;

  const name = account?.Name || marker.accountName || 'Account';
  const address = marker.address
    || [account?.ShippingStreet, account?.ShippingCity, account?.ShippingState].filter(Boolean).join(', ')
    || '—';
  const status = account?.Account_Status__c || '—';

  return (
    <>
      <Marker
        position={{ lat: marker.lat, lng: marker.lng }}
        title={name}
        zIndex={6000}
        onClick={() => setOpen(true)}
        icon={{
          url: 'data:image/svg+xml,' + encodeURIComponent(`
            <svg xmlns="http://www.w3.org/2000/svg" width="36" height="44" viewBox="0 0 36 44">
              <path d="M18 0C8.06 0 0 8.06 0 18c0 13.5 18 26 18 26s18-12.5 18-26C36 8.06 27.94 0 18 0z" fill="#7c3aed"/>
              <circle cx="18" cy="17" r="7" fill="white"/>
            </svg>
          `),
          scaledSize: new google.maps.Size(36, 44),
          anchor: new google.maps.Point(18, 44),
        }}
      />

      {open && (
        <InfoWindow
          position={{ lat: marker.lat, lng: marker.lng }}
          onCloseClick={() => setOpen(false)}
          options={{ maxWidth: 380 }}
        >
          <div style={{ fontFamily: 'sans-serif', fontSize: 13, minWidth: 200, maxWidth: 360, lineHeight: 1.5 }}>
            <a
              href={sfInstanceUrl && marker.accountId ? `${sfInstanceUrl}/${marker.accountId}` : '#'}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontWeight: 700, fontSize: 14, display: 'block', marginBottom: 4, color: '#2563eb', textDecoration: 'none' }}
            >
              {name}
            </a>
            <div style={{ color: '#444', marginBottom: 3 }}>
              <span style={{ fontWeight: 600 }}>Address:</span> {address}
            </div>
            <div style={{ color: '#444', marginBottom: 8 }}>
              <span style={{ fontWeight: 600 }}>Status:</span> {status}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button
                type="button"
                disabled={adding || !routeId}
                onClick={handleAdd}
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
