import * as routingApi from '../api/routing';

const CHAT_KEY = 'routing_ai_chat';
function loadChat() {
  try { return JSON.parse(localStorage.getItem(CHAT_KEY)) || []; }
  catch { return []; }
}
function saveChat(msgs) {
  try { localStorage.setItem(CHAT_KEY, JSON.stringify(msgs.slice(-200))); }
  catch { /* quota */ }
}

/** AI slice — chat panel and AI-generated route review */
const aiSlice = (set, get) => ({
  isChatOpen: false,
  chatMessages: loadChat(),
  isGenerating: false,
  pendingReviewRoutes: [],
  isReviewOpen: false,

  toggleChat: () => set((s) => ({ isChatOpen: !s.isChatOpen })),

  addMessage: (msg) => {
    const updated = [...get().chatMessages, msg];
    saveChat(updated);
    set({ chatMessages: updated });
  },

  clearChat: () => {
    localStorage.removeItem(CHAT_KEY);
    set({ chatMessages: [] });
  },

  setGenerating: (isGenerating) => set({ isGenerating }),

  loadPendingReviews: async () => {
    const data = await routingApi.getAIPending();
    set({ pendingReviewRoutes: data.routes ?? data, isReviewOpen: true });
  },

  approveRoutes: async (ids) => {
    await routingApi.approveAIRoutes({ ids });
    set((s) => ({
      pendingReviewRoutes: s.pendingReviewRoutes.filter((r) => !ids.includes(r.id)),
    }));
  },

  declineRoutes: async (ids) => {
    await routingApi.declineAIRoutes({ ids });
    set((s) => ({
      pendingReviewRoutes: s.pendingReviewRoutes.filter((r) => !ids.includes(r.id)),
    }));
  },
});

export default aiSlice;
