/** Distinct colours for the comparison route so it stands out from the current one. */
const COMPARE_COLOR = '#db2777';
const COMPARE_COLOR_ALT = '#f59e0b';

/**
 * Compare slice — drives the side-by-side route comparison view.
 * When `compareMode` is on, the right panel shows the comparison UI and the
 * map overlays `compareRoute` alongside the current route.
 */
const compareSlice = (set, get) => ({
  compareMode: false,
  compareRoute: null,

  openCompare: () => set({ compareMode: true }),

  closeCompare: () => set({ compareMode: false, compareRoute: null }),

  /** Select (or clear) the comparison route, stamping a contrasting colour. */
  setCompareRoute: (route) => {
    if (!route) { set({ compareRoute: null }); return; }
    const currentColor = get().route?._color;
    const color = currentColor === COMPARE_COLOR ? COMPARE_COLOR_ALT : COMPARE_COLOR;
    set({ compareRoute: { ...route, _color: color } });
  },
});

export default compareSlice;
