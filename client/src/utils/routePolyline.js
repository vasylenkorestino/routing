/** Decode Google_Route__c.Polyline__c into map coordinates. */

function sanitizePolylineRaw(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/&#124;/g, '|')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

/** Split Polyline__c into encoded segments ([a],[b] or plain encoded). */
export function extractPolylineSegments(raw) {
  const cleaned = sanitizePolylineRaw(raw);
  if (!cleaned) return [];

  const bracketed = cleaned.match(/\[[^\]]+\]/g);
  if (bracketed?.length) {
    return bracketed.map((part) => part.slice(1, -1)).filter(Boolean);
  }

  return [cleaned.replace(/^\[|\]$/g, '')].filter(Boolean);
}

export function isValidCoord(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && !(lat === 0 && lng === 0)
    && lat >= -90 && lat <= 90
    && lng >= -180 && lng <= 180;
}

/** Whether decoded path stays near route anchors (stops + service locations). */
export function isPathPlausible(path, anchors, paddingDeg = 0.75) {
  if (!path?.length || !anchors?.length) return path?.length >= 2;

  const lats = anchors.map((a) => a.lat).filter(Number.isFinite);
  const lngs = anchors.map((a) => a.lng).filter(Number.isFinite);
  if (!lats.length || !lngs.length) return path.length >= 2;

  const minLat = Math.min(...lats) - paddingDeg;
  const maxLat = Math.max(...lats) + paddingDeg;
  const minLng = Math.min(...lngs) - paddingDeg;
  const maxLng = Math.max(...lngs) + paddingDeg;

  return path.every(({ lat, lng }) =>
    lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng,
  );
}

/** Decode Polyline__c via Google geometry API; returns [] when invalid. */
export function decodeRoutePolyline(raw, { anchors = [] } = {}) {
  if (!raw || !window.google?.maps?.geometry?.encoding) return [];

  const segments = extractPolylineSegments(raw);
  const path = [];

  for (const segment of segments) {
    try {
      const decoded = google.maps.geometry.encoding.decodePath(segment);
      for (const p of decoded) {
        const lat = p.lat();
        const lng = p.lng();
        if (isValidCoord(lat, lng)) path.push({ lat, lng });
      }
    } catch {
      // Try next segment; caller may fall back to driving directions.
    }
  }

  if (path.length < 2) return [];
  if (anchors.length && !isPathPlausible(path, anchors)) return [];
  return path;
}
