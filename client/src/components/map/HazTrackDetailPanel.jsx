import { useCallback, useState } from 'react';
import useStore from '../../store';
import * as routingApi from '../../api/routing';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';
import { isRouteCompleted } from '../../utils/route';
import LastServices from '../shared/LastServices';
import {
  HAZTRACK_STATUS_COLORS,
  LBS_PER_GALLON,
  volumePercent,
  parseVolume,
  formatGallons,
  formatWeightLbs,
  estimateFillHorizons,
  formatHorizonDate,
  formatHazTrackDate,
  flattenReadings,
  tankTitle,
  tankSfRecordId,
} from '../../utils/haztrack';

/** Status pill for Healthy / Warning / Critical / Issue. */
function StatusPill({ status }) {
  const color = HAZTRACK_STATUS_COLORS[status] || HAZTRACK_STATUS_COLORS.Issue;
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold border"
      style={{ color, borderColor: `${color}66`, background: `${color}18` }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      {status || 'Issue'}
    </span>
  );
}

/** Vertical capacity gauge (0–100%). */
function CapacityGauge({ pct }) {
  const fill = pct != null ? Math.max(0, Math.min(100, pct)) : 0;
  const color = pct == null
    ? '#4b5563'
    : pct >= 80 ? '#ef4444' : pct >= 60 ? '#eab308' : '#14b8a6';
  return (
    <div className="flex flex-col items-center gap-1 shrink-0">
      <div className="relative w-8 h-28 rounded-md border border-border bg-bg overflow-hidden">
        <div
          className="absolute bottom-0 left-0 right-0 transition-all"
          style={{ height: `${fill}%`, background: color }}
        />
      </div>
      <span className="text-xs font-semibold tabular-nums text-txt">{pct != null ? `${Math.round(pct)}%` : '—'}</span>
    </div>
  );
}

/** External-link icon for Salesforce record. */
function ExternalLinkIcon() {
  return (
    <svg className="w-3.5 h-3.5 inline-block ml-1 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
    </svg>
  );
}

/**
 * Rich Bonchon-style HazTrack tank detail panel.
 * Built from Salesforce Tank__/Sensor__ data + client-side fill forecasts.
 */
export default function HazTrackDetailPanel({ tank, onBack }) {
  const sfInstanceUrl = useStore((s) => s.sfInstanceUrl);
  const routeId = useStore((s) => s.routeId);
  const route = useStore((s) => s.route);
  const refreshRoutes = useStore((s) => s.refreshRoutes);
  const [adding, setAdding] = useState(false);

  const accountId = tank?.AccountId || null;
  const accountName = tank?.AccountName || tankTitle(tank);
  const routeCompleted = isRouteCompleted(route);
  const canAdd = !!(accountId && routeId && !routeCompleted && !adding);

  /** Adds the linked account as a stop on the selected Google_Route__c. */
  const handleAddToRoute = useCallback(async () => {
    if (!accountId) {
      toast.info('No account linked to this tank');
      return;
    }
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
      await routingApi.addPoint({ accountId, routeId, ticketType: '' });
      await refreshRoutes();
      toast.success(`Added ${accountName || 'account'} to route`);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setAdding(false);
    }
  }, [accountId, accountName, routeId, route, refreshRoutes]);

  if (!tank) return null;

  const pct = volumePercent(tank);
  const lastVol = parseVolume(tank.LastVolume);
  const maxVol = parseVolume(tank.MaxVolumeF);
  const horizons = estimateFillHorizons(tank);
  const readings = flattenReadings(tank);
  const recordId = tankSfRecordId(tank);
  const href = sfInstanceUrl && recordId ? `${sfInstanceUrl}/${recordId}` : null;
  const address = [tank.ShippingStreet, tank.ShippingCity, tank.ShippingState].filter(Boolean).join(', ');
  const capacityLeft = maxVol != null && lastVol != null ? Math.max(0, maxVol - lastVol) : null;
  const status = tank.LevelStatus || 'Issue';
  const overdueHorizon = (d) => d && d.getTime() < Date.now();

  let addTitle = 'Add this account to the selected route';
  if (!accountId) addTitle = 'No account linked to this tank';
  else if (!routeId) addTitle = 'Select a route first';
  else if (routeCompleted) addTitle = 'Route is completed — stops cannot be added';

  return (
    <div className="flex flex-col gap-3 text-txt">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="self-start text-[11px] font-medium text-primary hover:underline"
        >
          ← Back to tanks
        </button>
      )}

      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold leading-snug">{tankTitle(tank)}</h3>
        <StatusPill status={status} />
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!canAdd}
          onClick={handleAddToRoute}
          title={addTitle}
          className={`px-3 py-1.5 text-[12px] font-semibold rounded-md text-white transition ${
            canAdd
              ? 'bg-emerald-600 hover:bg-emerald-700 cursor-pointer'
              : 'bg-gray-400 cursor-not-allowed'
          }`}
        >
          {adding ? 'Adding…' : 'Add to Route'}
        </button>
      </div>

      {!accountId && (
        <div className="text-[11px] text-txt-secondary rounded-md border border-border bg-bg/60 px-2.5 py-2">
          No account linked — cannot show services or add to route.
        </div>
      )}

      {/* Metrics overview */}
      <div className="flex gap-3 items-stretch">
        <CapacityGauge pct={pct} />
        <div className="flex-1 min-w-0 flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-txt-secondary">Volume</div>
              <div className="text-sm font-semibold tabular-nums">{formatGallons(lastVol)}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-txt-secondary">Weight (est.)</div>
              <div className="text-sm font-semibold tabular-nums">{formatWeightLbs(lastVol)}</div>
            </div>
          </div>
          <div className="rounded-lg border border-border bg-bg/60 px-2.5 py-2 text-[11px]">
            <div className="font-semibold text-txt-secondary mb-1">Predicted fill horizons</div>
            <div className="flex justify-between gap-2">
              <span>Near capacity (80%)</span>
              <span className={`font-medium tabular-nums ${overdueHorizon(horizons.near80Date) ? 'text-error' : ''}`}>
                {formatHorizonDate(horizons.near80Date)}
              </span>
            </div>
            {horizons.fillsLeft80 != null && (
              <div className="text-txt-secondary text-[10px] mb-1">Estimated fills left: {horizons.fillsLeft80}</div>
            )}
            <div className="flex justify-between gap-2 mt-1">
              <span>Full capacity (100%)</span>
              <span className={`font-medium tabular-nums ${overdueHorizon(horizons.full100Date) ? 'text-error' : ''}`}>
                {formatHorizonDate(horizons.full100Date)}
              </span>
            </div>
            {horizons.fillsLeft100 != null && (
              <div className="text-txt-secondary text-[10px]">Estimated fills left: {horizons.fillsLeft100}</div>
            )}
          </div>
        </div>
      </div>

      {/* Meta row */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-txt-secondary border-y border-border py-1.5">
        <span>Last transmission: <span className="text-txt">{formatHazTrackDate(tank.LastRecordOn)}</span></span>
        <span>Avg fill: <span className="text-txt">
          {horizons.avgFillPerDay != null ? `${horizons.avgFillPerDay.toFixed(2)} GL/day` : '—'}
        </span></span>
        <span>Capacity left: <span className="text-txt">
          {capacityLeft != null ? `${Number(capacityLeft.toFixed(2))} GL` : '—'}
        </span></span>
      </div>

      {/* Tank details */}
      <div className="space-y-1.5 text-[12px]">
        <div className="flex items-center justify-between gap-2">
          <span className="text-txt-secondary shrink-0">Tank</span>
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary font-medium hover:underline text-right truncate"
            >
              {tank.Name || tankTitle(tank)}
              <ExternalLinkIcon />
            </a>
          ) : (
            <span className="font-medium truncate">{tank.Name || '—'}</span>
          )}
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-txt-secondary">Model</span>
          <span>—</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-txt-secondary">Customer</span>
          <span className="text-right truncate">{tank.AccountName || '—'}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-txt-secondary">Customer ID</span>
          <span className="tabular-nums text-[11px]">{tank.AccountId || '—'}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-txt-secondary shrink-0">Address</span>
          <span className="text-right">{address || (tank.hasAccount ? '—' : 'No Account relationship')}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-txt-secondary">Max volume</span>
          <span>{formatGallons(maxVol)}</span>
        </div>
      </div>

      {/* Sensors summary */}
      {(tank.sensors || []).length > 0 && (
        <div className="text-[11px]">
          <div className="font-semibold text-txt-secondary mb-1">Sensors ({tank.sensors.length})</div>
          <div className="space-y-1.5">
            {tank.sensors.map((s) => (
              <div key={s.Id} className="pl-2 border-l-2 border-border">
                <div className="font-medium">{s.SensorName || s.Name || 'Sensor'}</div>
                <div className="text-txt-secondary">Reading: {s.LastRecordReadingF || '—'}</div>
                <div className="text-txt-secondary">Temp: {s.LastRecordTemperatureF || '—'}</div>
                <div className="text-txt-secondary">On: {formatHazTrackDate(s.LastRecordOn)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Last Services — under Sensors, before events */}
      {accountId && (
        <LastServices accountId={accountId} accountName={accountName} />
      )}

      {/* Most recent events */}
      <div>
        <div className="text-[11px] font-semibold text-txt-secondary mb-1.5">Most recent events</div>
        {readings.length === 0 ? (
          <div className="text-[11px] text-txt-secondary">No recent readings</div>
        ) : (
          <div className="overflow-x-auto rounded border border-border">
            <table className="w-full text-[10px]">
              <thead className="bg-bg/80 text-txt-secondary">
                <tr>
                  <th className="text-left font-semibold px-2 py-1.5">Date</th>
                  <th className="text-right font-semibold px-2 py-1.5">Detected (GL)</th>
                  <th className="text-right font-semibold px-2 py-1.5">Detected (lbs)</th>
                  <th className="text-right font-semibold px-2 py-1.5">Driver&apos;s (GL)</th>
                  <th className="text-right font-semibold px-2 py-1.5">Driver&apos;s (lbs)</th>
                </tr>
              </thead>
              <tbody>
                {readings.slice(0, 10).map((r) => (
                  <tr key={r.Id || `${r.RecordOn}-${r.ReadingF}`} className="border-t border-border">
                    <td className="px-2 py-1.5 whitespace-nowrap">{formatHazTrackDate(r.RecordOn)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{r.gallons != null ? Number(r.gallons.toFixed(2)) : '—'}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {r.gallons != null ? Number((r.gallons * LBS_PER_GALLON).toFixed(2)) : '—'}
                    </td>
                    <td className="px-2 py-1.5 text-right text-txt-secondary">—</td>
                    <td className="px-2 py-1.5 text-right text-txt-secondary">—</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
