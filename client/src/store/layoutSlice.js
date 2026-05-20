/** Layout slice — panel mode and split ratio (persisted) */
const layoutSlice = (set) => ({
  panelMode: 'split',
  splitRatio: parseFloat(localStorage.getItem('splitRatio')) || 0.4,

  setPanelMode: (panelMode) => set({ panelMode }),

  setSplitRatio: (splitRatio) => {
    localStorage.setItem('splitRatio', splitRatio);
    set({ splitRatio });
  },
});

export default layoutSlice;
