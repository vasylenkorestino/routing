const MODAL_KEYS = ['isNew', 'isEdit', 'isCombine', 'isSplit', 'isEditPoint', 'isComplete', 'isAIGenerate', 'isAIEnhance'];

/** Modal slice — toggles for route-action modals */
const modalSlice = (set) => ({
  isNew: false,
  isEdit: false,
  isCombine: false,
  isSplit: false,
  isEditPoint: false,
  isComplete: false,
  isAIGenerate: false,
  isAIEnhance: false,

  openModal: (name) => set({ [name]: true }),
  closeModal: (name) => set({ [name]: false }),
  closeAllModals: () => set(Object.fromEntries(MODAL_KEYS.map((k) => [k, false]))),
});

export default modalSlice;
