import { useState, useRef, useCallback, useEffect } from 'react';
import useStore from '../../store';
import { chatAsync } from '../../api/routing';
import AIProgressSteps from './AIProgressSteps';
import { toast } from '../ui/Toast';

/** Collapsible AI chat panel with async progress and live placeholder messages. */
export default function AIChat() {
  const {
    chatMessages, isGenerating, addMessage, updateMessage, setGenerating, clearChat,
    chatSessionId, setChatSessionId,
    trackAIJob, clearAIJob, aiJobStatus, aiJobSteps, aiJobFindings, aiJobProgress, aiJobMessage, aiJobError,
  } = useStore();
  const route = useStore((s) => s.route);
  const routes = useStore((s) => s.routes);
  const recordType = useStore((s) => s.recordType);
  const serviceDate = useStore((s) => s.serviceDate);
  const aiSelectedRouteIds = useStore((s) => s.aiSelectedRouteIds);
  const clearAiSelection = useStore((s) => s.clearAiSelection);
  const [input, setInput] = useState('');
  const [activePlaceholderIdx, setActivePlaceholderIdx] = useState(null);
  const scrollRef = useRef(null);

  const selectedRoutes = routes.filter((r) => aiSelectedRouteIds[r.Id ?? r.id]);
  const selectedCount = selectedRoutes.length;

  const scrollBottom = useCallback(() => {
    setTimeout(() => scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight), 50);
  }, []);

  const buildContext = useCallback(() => {
    if (selectedCount > 0) {
      return {
        multiRoute: true,
        serviceDate,
        recordType,
        routes: selectedRoutes.map((r) => {
          const stops = r.Routes__r?.records ?? r.Routes__r ?? r.points ?? [];
          return {
            routeId: r.Id ?? r.id,
            routeName: r.Name,
            driver: r.DriverName__c,
            stopsCount: stops.length,
            totalDistance: r.Total_Distance__c,
            totalTime: r.Total_Time__c,
          };
        }),
      };
    }
    if (!route) return undefined;
    const stops = route.Routes__r?.records ?? route.Routes__r ?? [];
    return {
      routeId: route.Id,
      routeName: route.Name,
      serviceDate: route.Service_Date__c,
      driver: route.DriverName__c,
      totalDistance: route.Total_Distance__c,
      totalTime: route.Total_Time__c,
      stopsCount: stops.length,
      stops: stops.slice(0, 30).map((s) => ({
        account: s.Account_Name__c,
        address: s.Container_Address__c,
        serviceType: s.ServiceType__c,
        status: s.Status__c,
        lastGallons: s.LastGallonsCollected__c,
        priority: s.Priority__c,
        isFixed: s.Fixed_point__c,
        notes: s.Notes__c,
      })),
    };
  }, [route, selectedCount, selectedRoutes, serviceDate, recordType]);

  useEffect(() => {
    if (activePlaceholderIdx == null || aiJobStatus === 'idle') return;
    updateMessage(activePlaceholderIdx, {
      jobSteps: aiJobSteps,
      jobFindings: aiJobFindings,
      jobProgress: aiJobProgress,
      content: aiJobStatus === 'complete' && aiJobMessage
        ? aiJobMessage
        : undefined,
      isPlaceholder: aiJobStatus !== 'complete',
    });
    if (aiJobStatus === 'complete') {
      setGenerating(false);
      setActivePlaceholderIdx(null);
      clearAIJob();
      scrollBottom();
    } else if (aiJobStatus === 'error') {
      updateMessage(activePlaceholderIdx, {
        content: aiJobError || 'Sorry, something went wrong. Please try again.',
        isPlaceholder: false,
      });
      setGenerating(false);
      setActivePlaceholderIdx(null);
      clearAIJob();
      scrollBottom();
    }
  }, [activePlaceholderIdx, aiJobStatus, aiJobSteps, aiJobFindings, aiJobProgress, aiJobMessage, aiJobError, updateMessage, setGenerating, clearAIJob, scrollBottom]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    if (isGenerating) {
      toast.error('Please wait for the current response');
      return;
    }

    addMessage({ role: 'user', content: text });
    setInput('');
    setGenerating(true);
    scrollBottom();

    const context = buildContext();
    const body = { message: text, recordType, context, sessionId: chatSessionId };

    try {
      const { jobId, sessionId } = await chatAsync(body);
      if (sessionId && !chatSessionId) setChatSessionId(sessionId);

      addMessage({
        role: 'assistant',
        content: '',
        isPlaceholder: true,
        jobSteps: [],
        jobFindings: [],
        jobProgress: { label: 'Starting…', percent: 0 },
      });
      const placeholderIdx = useStore.getState().chatMessages.length - 1;
      setActivePlaceholderIdx(placeholderIdx);

      await trackAIJob(jobId, 'chat');
    } catch (err) {
      addMessage({ role: 'assistant', content: `Error: ${err.message}` });
      setGenerating(false);
    }
    scrollBottom();
  }, [input, isGenerating, addMessage, setGenerating, scrollBottom, buildContext, recordType, chatSessionId, setChatSessionId, route, selectedCount, trackAIJob]);

  return (
    <div className="flex flex-col h-full bg-surface">
      <div className="flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-2" ref={scrollRef}>
        {chatMessages.length === 0 && (
          <div className="text-txt-secondary text-xs text-center py-4">
            Ask the AI assistant anything about your routes.
          </div>
        )}
        {chatMessages.map((m, i) => (
          <div
            key={i}
            className={`max-w-[85%] px-3 py-2 rounded-xl text-[13px] leading-relaxed break-words ${
              m.role === 'user'
                ? 'self-end bg-primary text-white rounded-br-sm whitespace-pre-wrap'
                : 'self-start bg-bg text-txt rounded-bl-sm'
            }`}
          >
            {m.isPlaceholder ? (
              <AIProgressSteps
                compact
                steps={m.jobSteps || []}
                findings={m.jobFindings || []}
                progress={m.jobProgress || {}}
                status={isGenerating ? 'running' : 'complete'}
              />
            ) : (
              <span className="whitespace-pre-wrap">{m.content}</span>
            )}
          </div>
        ))}
      </div>

      {selectedCount > 0 && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-t border-border bg-ai-bg/60">
          <span className="text-[11px] font-medium text-ai">
            ✦ {selectedCount} route{selectedCount > 1 ? 's' : ''} in AI context
          </span>
          <span className="text-[11px] text-txt-secondary truncate flex-1">
            {selectedRoutes.map((r) => r.Name).join(', ')}
          </span>
          <button
            className="text-[11px] text-txt-secondary hover:text-error transition shrink-0"
            onClick={clearAiSelection}
            title="Clear AI selection"
          >
            clear
          </button>
        </div>
      )}

      <div className="flex gap-2 px-3 py-2 border-t border-border">
        {chatMessages.length > 0 && (
          <button
            className="h-8 w-8 shrink-0 flex items-center justify-center rounded-lg border border-border text-txt-secondary hover:text-error hover:border-error/30 transition"
            title="Clear chat"
            onClick={clearChat}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
            </svg>
          </button>
        )}
        <input
          className="flex-1 h-8 px-3 rounded-lg border border-border bg-surface text-txt text-[13px] focus:border-primary focus:ring-1 focus:ring-primary-light outline-none transition"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
          placeholder={isGenerating ? 'Processing…' : 'Ask AI…'}
          disabled={isGenerating}
        />
        <button
          className="h-8 px-4 rounded-lg bg-ai text-white text-xs font-medium hover:bg-ai-hover transition disabled:opacity-50"
          disabled={isGenerating}
          onClick={handleSend}
        >
          Send
        </button>
      </div>
    </div>
  );
}
