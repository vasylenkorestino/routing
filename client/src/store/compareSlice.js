/** Palette for comparison routes — chosen to stay distinct from the current route. */
const COMPARE_PALETTE = ['#db2777', '#f59e0b', '#8b5cf6', '#14b8a6', '#ef4444', '#0ea5e9', '#84cc16', '#a855f7'];

const routeKey = (r) => r?.Id ?? r?.id ?? null;

/** Assign stable, distinct colours to the comparison routes (skipping the current route's). */
function withColors(routes, currentColor) {
  const palette = COMPARE_PALETTE.filter((c) => c !== currentColor);
  return routes.map((r, i) => ({ ...r, _color: palette[i % palette.length] }));
}

/**
 * Compare slice — drives the multi-route side-by-side comparison view.
 * When `compareMode` is on, the right panel shows the comparison UI and the
 * map overlays every route in `compareRoutes` alongside the current route.
 */
const compareSlice = (set, get) => ({
  compareMode: false,
  compareRoutes: [],
  compareDetail: null, // { accountId, accountName } — drives the Last Services view

  openCompare: () => set({ compareMode: true }),

  closeCompare: () => set({ compareMode: false, compareRoutes: [], compareDetail: null }),

  /** Add/remove a single route from the comparison set, re-colouring the set. */
  toggleCompareRoute: (route) => {
    const id = routeKey(route);
    const current = get().compareRoutes;
    const exists = current.some((r) => routeKey(r) === id);
    const next = exists ? current.filter((r) => routeKey(r) !== id) : [...current, route];
    set({ compareRoutes: withColors(next, get().route?._color) });
  },

  /** Replace the comparison set (used by Select All / Deselect All). */
  setCompareRoutes: (routes) => set({ compareRoutes: withColors(routes || [], get().route?._color) }),

  clearCompareRoutes: () => set({ compareRoutes: [] }),

  /** Set (or clear) the account whose service history is shown in the panel. */
  setCompareDetail: (detail) => set({ compareDetail: detail || null }),
});

export default compareSlice;
