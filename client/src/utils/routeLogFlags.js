/** Flag presentation + decision semantics for AI Enhance RouteLog__c rows. */

export const FLAG_META = {
  ADD: { label: 'Add', badge: 'bg-ai/10 text-ai border-ai/30', dot: 'bg-ai', hex: '#8b5cf6' },
  KEEP: { label: 'Keep', badge: 'bg-success/10 text-success border-success/30', dot: 'bg-success', hex: '#22c55e' },
  REMOVE: { label: 'Remove', badge: 'bg-error/10 text-error border-error/30', dot: 'bg-error', hex: '#ef4444' },
  FLAG: { label: 'Flag', badge: 'bg-warning/10 text-warning border-warning/30', dot: 'bg-warning', hex: '#f59e0b' },
  OVERFLOW: { label: 'Overflow Risk', badge: 'bg-orange-100 text-orange-600 border-orange-300', dot: 'bg-orange-500', hex: '#f97316' },
};

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

/** SVG data-URL marker icon colored by flag. */
export function routeLogMarkerIcon(flag) {
  const hex = FLAG_META[flag]?.hex || FLAG_META.FLAG.hex;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">
      <path d="M14 0C6.27 0 0 6.27 0 14c0 10.5 14 22 14 22s14-11.5 14-22C28 6.27 21.73 0 14 0z" fill="${hex}"/>
      <circle cx="14" cy="13" r="6" fill="white"/>
    </svg>
  `;
  return {
    url: 'data:image/svg+xml,' + encodeURIComponent(svg),
    scaledSize: typeof google !== 'undefined' ? new google.maps.Size(28, 36) : undefined,
    anchor: typeof google !== 'undefined' ? new google.maps.Point(14, 36) : undefined,
  };
}
