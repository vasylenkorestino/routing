import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import authSlice from './authSlice';
import routingSlice from './routingSlice';
import modalSlice from './modalSlice';
import layoutSlice from './layoutSlice';
import mapSlice from './mapSlice';
import aiSlice from './aiSlice';
import bellSlice from './bellSlice';
import generationSlice from './generationSlice';
import planningSlice from './planningSlice';
import aiJobSlice from './aiJobSlice';
import compareSlice from './compareSlice';

/** Combined Zustand store — all domain slices merged */
const useStore = create(
  persist(
    (...a) => ({
      ...authSlice(...a),
      ...routingSlice(...a),
      ...modalSlice(...a),
      ...layoutSlice(...a),
      ...mapSlice(...a),
      ...aiSlice(...a),
      ...bellSlice(...a),
      ...generationSlice(...a),
      ...planningSlice(...a),
      ...aiJobSlice(...a),
      ...compareSlice(...a),
    }),
    {
      // Keep the user's active context across page refreshes. Session-scoped so a
      // brand-new session/tab still starts on today's defaults.
      name: 'uco-routing-context',
      storage: createJSONStorage(() => sessionStorage),
      partialize: (s) => ({
        serviceDate: s.serviceDate,
        recordType: s.recordType,
        serviceLocation: s.serviceLocation,
        routeId: s.routeId,
        panelMode: s.panelMode,
        // Per-session route visibility so reopening the tab restores the user's
        // own checkbox state instead of a computed default.
        hiddenRouteIds: s.hiddenRouteIds,
      }),
    }
  )
);

export default useStore;
