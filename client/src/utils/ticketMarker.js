/**
 * Ticket type metadata + Google Maps marker icon builder.
 * Each ticket type gets a distinct color and short code so map pins are
 * visually distinguishable at a glance. AI candidates render larger with a
 * gold halo + star badge to draw attention.
 */

export const TICKET_META = {
  'UCO Collection':       { color: '#f97316', code: 'UCO' },
  'Deliver Container':    { color: '#2563eb', code: 'DEL' },
  'Relocate Container':   { color: '#22c55e', code: 'REL' },
  'Remove Container':     { color: '#14b8a6', code: 'RMV' },
  'Remove FSP Container': { color: '#6366f1', code: 'FSP' },
  'Replace Container':    { color: '#8b5cf6', code: 'RPL' },
  'Grease Trap Cleaning': { color: '#ec4899', code: 'GTC' },
  'Pressure Washing':     { color: '#f59e0b', code: 'PW' },
  'Replace Grill':        { color: '#a855f7', code: 'GRL' },
  'Rotisserie Water':     { color: '#06b6d4', code: 'RW' },
  'Future Services':      { color: '#64748b', code: 'FUT' },
};

/** Flat { type: color } map for legends/swatches (derived from TICKET_META). */
export const TICKET_COLORS = Object.fromEntries(
  Object.entries(TICKET_META).map(([type, m]) => [type, m.color]),
);

const FALLBACK = { color: '#64748b', code: '?' };

/** Derives a 1–3 char code from an unknown type (initials of the first words). */
function deriveCode(type) {
  if (!type) return FALLBACK.code;
  const words = type.trim().split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.map((w) => w[0]).join('').slice(0, 3).toUpperCase();
}

/** Resolves the color + code for a ticket type, deriving a code when unknown. */
export function ticketMeta(type) {
  return TICKET_META[type] || { color: FALLBACK.color, code: deriveCode(type) };
}

export const ticketColor = (type) => ticketMeta(type).color;

/** Builds the teardrop pin SVG (with optional gold candidate halo + star). */
function pinSvg({ color, code, candidate }) {
  const halo = candidate
    ? '<circle cx="20" cy="18" r="18" fill="#facc15" opacity="0.35"/>'
    : '';
  const star = candidate
    ? '<circle cx="32" cy="7" r="6.5" fill="#facc15" stroke="#fff" stroke-width="1.5"/>'
      + '<text x="32" y="10.4" text-anchor="middle" font-size="9" font-weight="700" fill="#fff" font-family="Arial, sans-serif">\u2726</text>'
    : '';
  const stroke = candidate ? '#facc15' : '#ffffff';
  const strokeW = candidate ? 2.5 : 1.5;
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="52" viewBox="0 0 40 52">'
    + halo
    + `<path d="M20 3 C12 3 5.5 9.5 5.5 17.5 C5.5 29 20 47 20 47 C20 47 34.5 29 34.5 17.5 C34.5 9.5 28 3 20 3 Z" fill="${color}" stroke="${stroke}" stroke-width="${strokeW}"/>`
    + '<circle cx="20" cy="18" r="11" fill="#ffffff"/>'
    + `<text x="20" y="21.3" text-anchor="middle" font-size="8" font-weight="700" fill="${color}" font-family="Arial, sans-serif">${code}</text>`
    + star
    + '</svg>'
  );
}

/**
 * Returns a Google Maps Icon for a ticket type. Candidates are scaled up and
 * anchored at the pin tip so they sit correctly on their coordinates.
 */
export function ticketMarkerIcon(type, { candidate = false } = {}) {
  const { color, code } = ticketMeta(type);
  const url = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(pinSvg({ color, code, candidate }));
  const g = typeof window !== 'undefined' ? window.google : undefined;
  if (!g?.maps) return { url };
  const scale = candidate ? 1.3 : 1;
  return {
    url,
    scaledSize: new g.maps.Size(40 * scale, 52 * scale),
    anchor: new g.maps.Point(20 * scale, 47 * scale),
  };
}
