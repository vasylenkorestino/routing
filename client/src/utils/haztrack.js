/** HazTrack status colors (match MapApplication.page). */
export const HAZTRACK_STATUS_COLORS = {
  Healthy: '#14b8a6',
  Warning: '#eab308',
  Critical: '#ef4444',
  Issue: '#4b5563',
};

/** Grease weight estimate: lbs per gallon (same factor used in SF grease logic). */
export const LBS_PER_GALLON = 7.5;

/** Parses a volume string/number to gallons, or null. */
export function parseVolume(val) {
  if (val == null || val === '') return null;
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  const m = String(val).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** Formats gallons for display. */
export function formatGallons(val) {
  const n = parseVolume(val);
  if (n == null) return '—';
  return `${Number(n.toFixed(2))} GL`;
}

/** Estimated weight from gallons. */
export function estimateWeightLbs(gallons) {
  const n = parseVolume(gallons);
  if (n == null) return null;
  return n * LBS_PER_GALLON;
}

/** Formats estimated weight. */
export function formatWeightLbs(gallons) {
  const w = estimateWeightLbs(gallons);
  if (w == null) return '—';
  return `${Number(w.toFixed(2))} lbs`;
}

/** Returns 0–100 fill percent from tank row. */
export function volumePercent(tank) {
  if (tank?.VolumePercent != null && Number.isFinite(Number(tank.VolumePercent))) {
    return Math.max(0, Math.min(100, Number(tank.VolumePercent)));
  }
  const level = Number(tank?.CurrentLevel);
  if (!Number.isFinite(level)) return null;
  const pct = level <= 1 ? level * 100 : level;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/** Valid map coords for a tank, or null. */
export function tankCoords(tank) {
  const lat = Number(tank?.MALatitude);
  const lng = Number(tank?.MALongitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
  return { lat, lng };
}

/** Flatten sensor readings across a tank (newest first). */
export function flattenReadings(tank) {
  const rows = [];
  (tank?.sensors || []).forEach((s) => {
    (s.readings || []).forEach((r) => {
      rows.push({
        ...r,
        sensorName: s.SensorName || s.Name,
        gallons: parseVolume(r.ReadingF),
      });
    });
  });
  rows.sort((a, b) => {
    const ta = a.RecordOn ? new Date(a.RecordOn).getTime() : 0;
    const tb = b.RecordOn ? new Date(b.RecordOn).getTime() : 0;
    return tb - ta;
  });
  return rows;
}

/**
 * Estimates fill horizons from recent readings.
 * Returns { avgFillPerDay, near80Date, full100Date, fillsLeft80, fillsLeft100 } or nulls.
 */
export function estimateFillHorizons(tank) {
  const pct = volumePercent(tank);
  const maxVol = parseVolume(tank?.MaxVolumeF) ?? parseVolume(tank?.MaxVolume);
  const lastVol = parseVolume(tank?.LastVolume);
  const readings = flattenReadings(tank).filter((r) => r.gallons != null && r.RecordOn);

  let avgFillPerDay = null;
  if (readings.length >= 2) {
    // Use oldest→newest among recent samples for rate
    const newest = readings[0];
    const oldest = readings[readings.length - 1];
    const days = (new Date(newest.RecordOn) - new Date(oldest.RecordOn)) / (1000 * 60 * 60 * 24);
    const delta = newest.gallons - oldest.gallons;
    if (days > 0.05 && delta > 0) {
      avgFillPerDay = delta / days;
    }
  }

  const result = {
    avgFillPerDay,
    near80Date: null,
    full100Date: null,
    fillsLeft80: null,
    fillsLeft100: null,
  };

  if (avgFillPerDay == null || avgFillPerDay <= 0 || maxVol == null || maxVol <= 0) {
    return result;
  }

  const current = lastVol != null ? lastVol : (pct != null ? (pct / 100) * maxVol : null);
  if (current == null) return result;

  const target80 = maxVol * 0.8;
  const target100 = maxVol;
  const fillSize = Math.max(avgFillPerDay, 0.01);

  if (current < target80) {
    const days80 = (target80 - current) / avgFillPerDay;
    result.near80Date = addDays(new Date(), days80);
    result.fillsLeft80 = Math.ceil((target80 - current) / fillSize);
  }
  if (current < target100) {
    const days100 = (target100 - current) / avgFillPerDay;
    result.full100Date = addDays(new Date(), days100);
    result.fillsLeft100 = Math.ceil((target100 - current) / fillSize);
  }

  return result;
}

/** Adds fractional days to a date. */
function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/** Formats a date for horizon display. */
export function formatHorizonDate(d) {
  if (!d) return '—';
  try {
    return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  } catch {
    return '—';
  }
}

/** Formats Salesforce datetime for display. */
export function formatHazTrackDate(val) {
  if (!val) return '—';
  try {
    return new Date(val).toLocaleString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  } catch {
    return String(val);
  }
}

/** Display title for a tank. */
export function tankTitle(tank) {
  return tank?.AccountName || tank?.Name || 'Tank';
}

/** Salesforce record Id to open (Account preferred). */
export function tankSfRecordId(tank) {
  return tank?.AccountId || tank?.Id || null;
}
