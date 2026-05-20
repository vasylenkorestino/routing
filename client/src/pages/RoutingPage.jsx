import { useEffect, useState, useCallback, useRef } from 'react';
import useStore from '../store';
import Header from '../components/layout/Header';
import SplitPanel from '../components/layout/SplitPanel';
import RoutingMap from '../components/map/RoutingMap';
import RouteList from '../components/layers/RouteList';
import RouteCard from '../components/routes/RouteCard';
import RouteDataTable from '../components/routes/RouteDataTable';
import RouteEditor from '../components/routes/RouteEditor';
import RouteLogsPanel from '../components/routes/RouteLogsPanel';
import RouteCreator from '../components/routes/RouteCreator';
import RouteSplitter from '../components/routes/RouteSplitter';
import RouteCombiner from '../components/routes/RouteCombiner';
import RouteCompleter from '../components/routes/RouteCompleter';
import PointEditor from '../components/drivers/PointEditor';
import LastServices from '../components/shared/LastServices';
import TankSensorData from '../components/shared/TankSensorData';
import AIChat from '../components/shared/AIChat';
import AIReviewPanel from '../components/shared/AIReviewPanel';
import AIGenerateModal from '../components/shared/AIGenerateModal';
import AIEnhanceModal from '../components/routes/AIEnhanceModal';
import Spinner from '../components/ui/Spinner';

function RightPanel() {
  const route = useStore((s) => s.route);
  const routes = useStore((s) => s.routes);
  const isEdit = useStore((s) => s.isEdit);
  const isLoading = useStore((s) => s.isLoading);
  const [selectedPoint, setSelectedPoint] = useState(null);
  const [bottomTab, setBottomTab] = useState('services');

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {route && !isEdit && (
        <div className="shrink-0 p-3 pb-0">
          <RouteCard route={route} />
        </div>
      )}

      {route && !isEdit && (
        <div className="shrink-0 px-3 pt-2">
          <RouteLogsPanel googleRouteId={route.Id} />
        </div>
      )}

      <div className="flex-1 overflow-auto p-3 relative">
        {isLoading && !route ? (
          <div className="flex flex-col items-center justify-center h-full gap-2">
            <Spinner size="lg" />
            <span className="text-xs text-txt-secondary">Loading routes…</span>
          </div>
        ) : route ? (
          isEdit ? (
            <RouteEditor />
          ) : (
            <RouteDataTable
              points={route.Routes__r?.records ?? route.Routes__r ?? route.points ?? []}
              onSelectPoint={setSelectedPoint}
            />
          )
        ) : (
          <RouteList routes={routes} />
        )}
      </div>

      {route && !isEdit && selectedPoint && (
        <div className="shrink-0 border-t border-border max-h-[35%] overflow-auto relative">
          <button
            className="absolute top-2 right-2 z-10 w-6 h-6 flex items-center justify-center rounded-full bg-bg hover:bg-border text-txt-secondary hover:text-error text-sm transition"
            title="Close"
            onClick={() => setSelectedPoint(null)}
          >×</button>

          <div className="flex border-b border-border bg-surface">
            {[{ key: 'services', label: 'Last Services' }, { key: 'tanks', label: 'Tank & Sensor' }].map((tab) => (
              <button
                key={tab.key}
                className={`px-4 py-2 text-xs font-semibold transition border-b-2 ${bottomTab === tab.key ? 'border-primary text-primary' : 'border-transparent text-txt-secondary hover:text-txt'}`}
                onClick={() => setBottomTab(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {bottomTab === 'services' && (
            <LastServices
              accountId={selectedPoint.AccountId__c}
              accountName={selectedPoint.Account_Name__c}
            />
          )}
          {bottomTab === 'tanks' && (
            <TankSensorData
              accountId={selectedPoint.AccountId__c}
              accountName={selectedPoint.Account_Name__c}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** Resizable chat panel — drag the top edge to resize */
function ChatBar({ isChatOpen, toggleChat }) {
  const [height, setHeight] = useState(280);
  const dragging = useRef(false);
  const startY = useRef(0);
  const startH = useRef(0);

  const onMouseDown = useCallback((e) => {
    e.preventDefault();
    dragging.current = true;
    startY.current = e.clientY;
    startH.current = height;

    const onMouseMove = (e) => {
      if (!dragging.current) return;
      const delta = startY.current - e.clientY;
      setHeight(Math.max(120, Math.min(window.innerHeight * 0.7, startH.current + delta)));
    };
    const onMouseUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [height]);

  return (
    <div
      className="border-t border-border bg-surface overflow-hidden flex flex-col"
      style={{ height: isChatOpen ? height : 36 }}
    >
      {/* Drag handle */}
      {isChatOpen && (
        <div
          className="h-1.5 cursor-ns-resize bg-transparent hover:bg-primary/20 transition shrink-0"
          onMouseDown={onMouseDown}
        />
      )}

      {/* Toggle button */}
      <button
        className="flex items-center gap-1.5 w-full px-3 py-2 text-xs font-semibold text-ai bg-transparent border-none hover:bg-ai-bg transition shrink-0"
        onClick={toggleChat}
      >
        <span>✦</span> AI Assistant {isChatOpen ? '▾' : '▸'}
      </button>

      {isChatOpen && (
        <div className="flex-1 overflow-hidden">
          <AIChat />
        </div>
      )}
    </div>
  );
}

export default function RoutingPage() {
  const loadRoutingData = useStore((s) => s.loadRoutingData);
  const serviceDate = useStore((s) => s.serviceDate);
  const recordType = useStore((s) => s.recordType);
  const serviceLocation = useStore((s) => s.serviceLocation);
  const isChatOpen = useStore((s) => s.isChatOpen);
  const toggleChat = useStore((s) => s.toggleChat);
  const isNew = useStore((s) => s.isNew);
  const isSplit = useStore((s) => s.isSplit);
  const isCombine = useStore((s) => s.isCombine);
  const isComplete = useStore((s) => s.isComplete);
  const isEditPoint = useStore((s) => s.isEditPoint);
  const isReviewOpen = useStore((s) => s.isReviewOpen);
  const isAIGenerate = useStore((s) => s.isAIGenerate);
  const isAIEnhance = useStore((s) => s.isAIEnhance);

  useEffect(() => {
    loadRoutingData();
  }, [serviceDate, recordType, serviceLocation]);

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-bg">
      <Header />

      <div className="flex-1 overflow-hidden">
        <SplitPanel
          leftPanel={<RoutingMap />}
          rightPanel={<RightPanel />}
        />
      </div>

      {/* AI Chat bottom bar — resizable by dragging top edge */}
      <ChatBar isChatOpen={isChatOpen} toggleChat={toggleChat} />

      {/* Modals */}
      {isNew && <RouteCreator />}
      {isSplit && <RouteSplitter />}
      {isCombine && <RouteCombiner />}
      {isComplete && <RouteCompleter />}
      {isEditPoint && <PointEditor />}
      {isReviewOpen && <AIReviewPanel />}
      {isAIGenerate && <AIGenerateModal onClose={() => useStore.getState().closeModal('isAIGenerate')} />}
      {isAIEnhance && <AIEnhanceModal />}
    </div>
  );
}
