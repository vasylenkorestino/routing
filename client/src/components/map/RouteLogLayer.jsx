import { useMemo, useState, useCallback } from 'react';
import { Marker, InfoWindow } from '@react-google-maps/api';
import useStore from '../../store';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';
import {
  FLAG_META,
  NEEDS_RESOLUTION,
  decide,
  parseReason,
  routeLogMarkerIcon,
} from '../../utils/routeLogFlags';

/** Returns valid lat/lng for a route log account, or null. */
function logCoords(log) {
  const lat = Number(log.Account__r?.MALatitude__c);
  const lng = Number(log.Account__r?.MALongitude__c);
  if (Number.isNaN(lat) || Number.isNaN(lng) || (lat === 0 && lng === 0)) return null;
  return { lat, lng };
}

/**
 * Map markers for pending AI Enhance RouteLog__c rows, colored by flag.
 * Click opens a popup with AI reasoning and Keep / Decline actions.
 */
export default function RouteLogLayer() {
  const routeId = useStore((s) => s.routeId);
  const routeLogs = useStore((s) => s.routeLogs);
  const routeLogsRouteId = useStore((s) => s.routeLogsRouteId);
  const approving = useStore((s) => s.routeLogsApproving);
  const resolveRouteLog = useStore((s) => s.resolveRouteLog);
  const route = useStore((s) => s.route);
  const [selectedId, setSelectedId] = useState(null);

  const routeAccountIds = useMemo(() => {
    const stops = route?.Routes__r?.records ?? route?.Routes__r ?? [];
    const ids = new Set();
    (Array.isArray(stops) ? stops : []).forEach((s) => {
      if (s.AccountId__c) ids.add(s.AccountId__c);
      if (s.Account__c) ids.add(s.Account__c);
    });
    return ids;
  }, [route]);

  const pending = useMemo(() => {
    if (!routeId || routeLogsRouteId !== routeId) return [];
    return routeLogs
      .filter((l) => l.Status__c === 'Proposed' && logCoords(l))
      .map((l) => ({ ...l, ...parseReason(l.Reason__c), coords: logCoords(l) }));
  }, [routeId, routeLogsRouteId, routeLogs]);

  const selected = pending.find((l) => l.Id === selectedId) || null;

  const handleAction = useCallback(async (log, decisionOrOutcome, isOutcome = false) => {
    const outcome = isOutcome ? decisionOrOutcome : decide(log.flag, decisionOrOutcome);
    if (!outcome) return;
    try {
      await resolveRouteLog({ logId: log.Id, outcome });
      setSelectedId(null);
      toast.success(outcome === 'add' || outcome === 'keep' ? 'Accepted' : 'Declined');
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }, [resolveRouteLog]);

  if (!pending.length) return null;

  return (
    <>
      {pending.map((log) => (
        <Marker
          key={log.Id}
          position={log.coords}
          onClick={() => setSelectedId(log.Id)}
          icon={routeLogMarkerIcon(log.flag)}
          title={`${FLAG_META[log.flag]?.label || log.flag}: ${log.Account__r?.Name || log.Name}`}
          zIndex={120}
        />
      ))}

      {selected && (
        <InfoWindow
          position={selected.coords}
          onCloseClick={() => setSelectedId(null)}
        >
          <RouteLogPopup
            log={selected}
            inRoute={!!selected.Account__c && routeAccountIds.has(selected.Account__c)}
            approving={!!approving[selected.Id]}
            onAction={handleAction}
          />
        </InfoWindow>
      )}
    </>
  );
}

/** Compact InfoWindow content for a pending AI route log. */
function RouteLogPopup({ log, inRoute, approving, onAction }) {
  const meta = FLAG_META[log.flag] || FLAG_META.FLAG;
  const needsResolution = NEEDS_RESOLUTION.has(log.flag);
  const btnStyle = {
    height: 26,
    padding: '0 8px',
    fontSize: 11,
    fontWeight: 600,
    borderRadius: 6,
    border: '1px solid',
    cursor: approving ? 'wait' : 'pointer',
    opacity: approving ? 0.5 : 1,
  };

  return (
    <div style={{ fontFamily: 'sans-serif', fontSize: 13, minWidth: 220, maxWidth: 300 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{
          fontSize: 10,
          fontWeight: 700,
          textTransform: 'uppercase',
          padding: '2px 6px',
          borderRadius: 4,
          background: `${meta.hex}22`,
          color: meta.hex,
          border: `1px solid ${meta.hex}55`,
        }}>
          {meta.label}
        </span>
        {log.Confidence__c != null && (
          <span style={{ fontSize: 10, color: '#888' }}>{Math.round(log.Confidence__c * 100)}%</span>
        )}
        <span style={{ fontSize: 10, color: '#aaa' }}>{log.Name}</span>
      </div>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        {log.Account__r?.Name || 'Account'}
      </div>
      <p style={{ fontSize: 12, color: '#555', lineHeight: 1.4, margin: '0 0 10px' }}>
        {log.text || 'No AI reason provided.'}
      </p>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {needsResolution ? (
          (inRoute ? ['keep', 'remove'] : ['add']).map((o) => (
            <button
              key={o}
              type="button"
              disabled={approving}
              style={{
                ...btnStyle,
                borderColor: o === 'remove' ? '#ef4444' : o === 'add' ? '#8b5cf6' : '#22c55e',
                color: o === 'remove' ? '#ef4444' : o === 'add' ? '#8b5cf6' : '#22c55e',
                background: '#fff',
              }}
              onClick={() => onAction(log, o, true)}
            >
              {o === 'add' ? 'Add' : o === 'keep' ? 'Keep' : 'Remove'}
            </button>
          ))
        ) : (
          <>
            <button
              type="button"
              disabled={approving}
              style={{ ...btnStyle, borderColor: '#22c55e', color: '#fff', background: '#22c55e' }}
              onClick={() => onAction(log, 'approve')}
            >
              {approving ? '…' : (log.flag === 'REMOVE' ? 'Remove' : log.flag === 'ADD' ? 'Add' : 'Keep')}
            </button>
            <button
              type="button"
              disabled={approving}
              style={{ ...btnStyle, borderColor: '#ef4444', color: '#ef4444', background: '#fff' }}
              onClick={() => onAction(log, 'decline')}
            >
              Decline
            </button>
          </>
        )}
      </div>
    </div>
  );
}
