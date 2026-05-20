import { create } from 'zustand';
import authSlice from './authSlice';
import routingSlice from './routingSlice';
import modalSlice from './modalSlice';
import layoutSlice from './layoutSlice';
import mapSlice from './mapSlice';
import aiSlice from './aiSlice';

/** Combined Zustand store — all domain slices merged */
const useStore = create((...a) => ({
  ...authSlice(...a),
  ...routingSlice(...a),
  ...modalSlice(...a),
  ...layoutSlice(...a),
  ...mapSlice(...a),
  ...aiSlice(...a),
}));

export default useStore;
