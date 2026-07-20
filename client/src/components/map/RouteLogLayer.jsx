import { useMemo, useState, useCallback, useEffect } from 'react';
import { Marker, InfoWindow } from '@react-google-maps/api';
import useStore from '../../store';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';
import {
  FLAG_META,
  NEEDS_RESOLUTION,
  OUTCOME_LABEL,
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

/** Decorates a store log with parsed reason + coords for map UI. */
function decorateLog(log) {
  if (!log) return null;
  const coords = logCoords(log);
  if (!coords) return null;
  return { ...log, ...parseReason(log.Reason__c), coords };
}

/**
 * Map markers for pending AI Enhance RouteLog__c rows, colored by flag.
 * Selected = green check badge; unselected dim when any selection exists.
 */
export default function RouteLogLayer() {
  const routeId = useStore((s) => s.routeId);
  const routeLogs = useStore((s) => s.routeLogs);
  const routeLogsRouteId = useStore((s) => s.routeLogsRouteId);
  const approving = useStore((s) => s.routeLogsApproving);
  const resolveRouteLog = useStore((s) => s.resolveRouteLog);
  const undoRouteLog = useStore((s) => s.undoRouteLog);
  const selectedIds = useStore((s) => s.routeLogSelectedIds);
  const focusedId = useStore((s) => s.routeLogFocusedId);
  const flagVisible = useStore((s) => s.routeLogFlagVisible);
  const toggleSelected = useStore((s) => s.toggleRouteLogSelected);
  const setFocusedId = useStore((s) => s.setRouteLogFocusedId);
  const route = useStore((s) => s.route);
  const [popupId, setPopupId] = useState(null);
  const hasSelection = Object.keys(selectedIds).length > 0;

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
      .map((l) => decorateLog(l))
      .filter(Boolean)
      .filter((l) => flagVisible[l.flag] !== false);
  }, [routeId, routeLogsRouteId, routeLogs, flagVisible]);

  // Keep InfoWindow open after resolve so Undo is available (resolved logs leave `pending`).
  const popup = useMemo(() => {
    if (!popupId || !routeId || routeLogsRouteId !== routeId) return null;
    const fromPending = pending.find((l) => l.Id === popupId);
    if (fromPending) return fromPending;
    const raw = routeLogs.find((l) => l.Id === popupId);
    return decorateLog(raw);
  }, [popupId, pending, routeLogs, routeId, routeLogsRouteId]);

  useEffect(() => {
    if (popupId && !popup) setPopupId(null);
  }, [popupId, popup]);

  const handleAction = useCallback(async (log, decisionOrOutcome, isOutcome = false) => {
    const outcome = isOutcome ? decisionOrOutcome : decide(log.flag, decisionOrOutcome);
    if (!outcome) return;
    try {
      await resolveRouteLog({ logId: log.Id, outcome });
      setPopupId(log.Id);
      toast.success(outcome === 'add' || outcome === 'keep' ? 'Accepted' : 'Declined');
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }, [resolveRouteLog]);

  const handleUndo = useCallback(async (log) => {
    try {
      await undoRouteLog(log.Id);
      setPopupId(log.Id);
      toast.success('Decision undone');
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }, [undoRouteLog]);

  if (!pending.length && !popup) return null;

  return (
    <>
      {pending.map((log) => {
        const selected = !!selectedIds[log.Id];
        const focused = focusedId === log.Id;
        return (
          <Marker
            key={log.Id}
            position={log.coords}
            onClick={() => {
              toggleSelected(log.Id);
              setPopupId(log.Id);
              setFocusedId(log.Id);
            }}
            icon={routeLogMarkerIcon(log.flag, { selected, focused })}
            opacity={hasSelection && !selected && !focused ? 0.45 : 1}
            title={`${FLAG_META[log.flag]?.label || log.flag}: ${log.Account__r?.Name || log.Name}${selected ? ' (selected)' : ''}`}
            zIndex={focused ? 500 : selected ? 400 : 300}
          />
        );
      })}

      {popup && (
        <InfoWindow
          position={popup.coords}
          onCloseClick={() => setPopupId(null)}
        >
          <RouteLogPopup
            log={popup}
            inRoute={!!popup.Account__c && routeAccountIds.has(popup.Account__c)}
            approving={!!approving[popup.Id]}
            selected={!!selectedIds[popup.Id]}
            onToggleSelect={() => toggleSelected(popup.Id)}
            onAction={handleAction}
            onUndo={() => handleUndo(popup)}
          />
        </InfoWindow>
      )}
    </>
  );
}

/** Compact InfoWindow content for a pending or just-resolved AI route log. */
function RouteLogPopup({ log, inRoute, approving, selected, onToggleSelect, onAction, onUndo }) {
  const meta = FLAG_META[log.flag] || FLAG_META.FLAG;
  const needsResolution = NEEDS_RESOLUTION.has(log.flag);
  const isPending = log.Status__c === 'Proposed';
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
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
        {isPending && (
          <button
            type="button"
            onClick={onToggleSelect}
            style={{
              marginLeft: 'auto',
              height: 22,
              padding: '0 8px',
              fontSize: 10,
              fontWeight: 600,
              borderRadius: 6,
              border: selected ? '1px solid #2563eb' : '1px solid #cbd5e1',
              background: selected ? '#dbeafe' : '#fff',
              color: selected ? '#2563eb' : '#64748b',
              cursor: 'pointer',
            }}
          >
            {selected ? 'Selected' : 'Select'}
          </button>
        )}
      </div>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        {log.Account__r?.Name || 'Account'}
      </div>
      <p style={{ fontSize: 12, color: '#555', lineHeight: 1.4, margin: '0 0 10px' }}>
        {log.text || 'No AI reason provided.'}
      </p>
      {!isPending && (
        <p style={{ fontSize: 11, color: '#64748b', margin: '0 0 8px', fontStyle: 'italic' }}>
          {log._outcome ? `${OUTCOME_LABEL[log._outcome]} · ` : ''}
          {log.Status__c === 'Declined' ? 'Declined' : 'Approved'}
        </p>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {isPending ? (
          needsResolution ? (
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
          )
        ) : (
          <button
            type="button"
            disabled={approving}
            style={{ ...btnStyle, borderColor: '#2563eb', color: '#2563eb', background: '#eff6ff' }}
            onClick={onUndo}
          >
            {approving ? '…' : 'Undo'}
          </button>
        )}
      </div>
    </div>
  );
}
