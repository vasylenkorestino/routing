/** Flag presentation + decision semantics for AI Enhance RouteLog__c rows. */

export const FLAG_META = {
  ADD: { label: 'Add', badge: 'bg-ai/10 text-ai border-ai/30', dot: 'bg-ai', hex: '#8b5cf6' },
  KEEP: { label: 'Keep', badge: 'bg-success/10 text-success border-success/30', dot: 'bg-success', hex: '#22c55e' },
  REMOVE: { label: 'Remove', badge: 'bg-error/10 text-error border-error/30', dot: 'bg-error', hex: '#ef4444' },
  FLAG: { label: 'Flag', badge: 'bg-warning/10 text-warning border-warning/30', dot: 'bg-warning', hex: '#f59e0b' },
  OVERFLOW: { label: 'Overflow Risk', badge: 'bg-orange-100 text-orange-600 border-orange-300', dot: 'bg-orange-500', hex: '#f97316' },
};

export const FLAG_ORDER = ['REMOVE', 'OVERFLOW', 'FLAG', 'ADD', 'KEEP'];

export const OUTCOME_LABEL = {
  add: 'Add stop',
  keep: 'Keep stop',
  remove: 'Remove stop',
  ignore: 'No change',
};

/** Flags that require an explicit manager decision rather than approve/decline. */
export const NEEDS_RESOLUTION = new Set(['FLAG', 'OVERFLOW']);

/** Resolves a flag + approve/decline decision into a concrete route outcome. */
export function decide(flag, decision) {
  switch (flag) {
    case 'REMOVE': return decision === 'approve' ? 'remove' : 'keep';
    case 'KEEP': return decision === 'approve' ? 'keep' : 'remove';
    case 'ADD': return decision === 'approve' ? 'add' : 'ignore';
    default: return null;
  }
}

/** Splits a "[ACTION] text" reason into its flag token and message. */
export function parseReason(reason) {
  if (!reason) return { flag: 'FLAG', text: '' };
  const m = reason.match(/^\[(\w+)\]\s*(.*)$/s);
  if (!m) return { flag: 'FLAG', text: reason };
  const token = m[1].toUpperCase();
  const flag = FLAG_META[token] ? token : 'FLAG';
  return { flag, text: m[2] };
}

/**
 * SVG pin for a Route Log marker.
 * - Selected: green check badge (readable at a glance among many pins)
 * - Focused (opened in list): slightly larger + soft ring
 * @param {string} flag
 * @param {{ selected?: boolean, focused?: boolean }} [opts]
 */
export function routeLogMarkerIcon(flag, opts = {}) {
  const { selected = false, focused = false } = opts;
  const hex = FLAG_META[flag]?.hex || FLAG_META.FLAG.hex;

  // Canvas sized to fit pin + optional check badge / focus ring.
  const w = focused || selected ? 40 : 28;
  const h = focused || selected ? 48 : 36;
  const cx = w / 2;
  const cy = focused || selected ? 16 : 13;
  const headR = focused || selected ? 6.5 : 5.5;
  const tipY = h - 2;

  const checkBadge = selected
    ? `
      <circle cx="${w - 8}" cy="9" r="8" fill="#16a34a" stroke="#ffffff" stroke-width="2"/>
      <path d="M${w - 11.5} 9 l2.2 2.3 l5 -5.2"
        fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    `
    : '';

  const focusRing = focused
    ? `<circle cx="${cx}" cy="${cy}" r="14" fill="#2563eb" opacity="0.18"/>`
    : '';

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <ellipse cx="${cx}" cy="${tipY}" rx="${selected || focused ? 8 : 6}" ry="2.2" fill="rgba(0,0,0,0.28)"/>
      ${focusRing}
      <path d="M${cx} 2C${(cx - 7.5).toFixed(1)} 2 ${(cx - 12).toFixed(1)} 7.5 ${(cx - 12).toFixed(1)} ${cy}
        c0 9.5 12 20 12 20s12-10.5 12-20
        C${(cx + 12).toFixed(1)} 7.5 ${(cx + 7.5).toFixed(1)} 2 ${cx} 2z"
        fill="${hex}" stroke="#ffffff" stroke-width="2.25"/>
      <circle cx="${cx}" cy="${cy}" r="${headR}" fill="#ffffff"/>
      ${checkBadge}
    </svg>
  `;

  return {
    url: 'data:image/svg+xml,' + encodeURIComponent(svg.replace(/\s+/g, ' ').trim()),
    scaledSize: typeof google !== 'undefined' ? new google.maps.Size(w, h) : undefined,
    anchor: typeof google !== 'undefined' ? new google.maps.Point(cx, tipY) : undefined,
  };
}
