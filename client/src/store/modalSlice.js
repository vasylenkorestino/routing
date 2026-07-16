const MODAL_KEYS = ['isNew', 'isEdit', 'isCombine', 'isSplit', 'isEditPoint', 'isComplete', 'isAIGenerate', 'isPlanRoutes'];

/** Modal slice — toggles for route-action modals */
const modalSlice = (set) => ({
  isNew: false,
  isEdit: false,
  isCombine: false,
  isSplit: false,
  isEditPoint: false,
  isComplete: false,
  isAIGenerate: false,
  isPlanRoutes: false,
  editPoint: null,

  openModal: (name) => set({ [name]: true }),
  closeModal: (name) => set({ [name]: false, ...(name === 'isEditPoint' ? { editPoint: null } : {}) }),
  closeAllModals: () => set({ ...Object.fromEntries(MODAL_KEYS.map((k) => [k, false])), editPoint: null }),
  openPointEditor: (point) => set({ isEditPoint: true, editPoint: point }),
});

export default modalSlice;
