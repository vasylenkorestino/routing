import { create } from 'zustand';
import authSlice from './authSlice';
import routingSlice from './routingSlice';
import modalSlice from './modalSlice';
import layoutSlice from './layoutSlice';
import mapSlice from './mapSlice';
import aiSlice from './aiSlice';
import bellSlice from './bellSlice';
import generationSlice from './generationSlice';

/** Combined Zustand store — all domain slices merged */
const useStore = create((...a) => ({
  ...authSlice(...a),
  ...routingSlice(...a),
  ...modalSlice(...a),
  ...layoutSlice(...a),
  ...mapSlice(...a),
  ...aiSlice(...a),
  ...bellSlice(...a),
  ...generationSlice(...a),
}));

export default useStore;
