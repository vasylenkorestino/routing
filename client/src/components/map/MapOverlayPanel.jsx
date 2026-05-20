import { useState, useEffect } from 'react';
import useStore from '../../store';
import * as routingApi from '../../api/routing';
import RouteList from '../layers/RouteList';
import TicketList from '../layers/TicketList';
import ShapeList from '../layers/ShapeList';
import Spinner from '../ui/Spinner';

const TABS = ['routes', 'tickets', 'shapes'];

/** Floating overlay panel on the map — collapsible, shows routes/tickets/shapes */
export default function MapOverlayPanel() {
  const [open, setOpen] = useState(false);
  const [layerLoading, setLayerLoading] = useState(false);
  const layers = useStore((st) => st.layers);
  const selectedLayerTab = useStore((st) => st.selectedLayerTab);
  const setSelectedLayerTab = useStore((st) => st.setSelectedLayerTab);
  const toggleLayer = useStore((st) => st.toggleLayer);
  const setLayerData = useStore((st) => st.setLayerData);
  const recordType = useStore((st) => st.recordType);

  useEffect(() => {
    if (!open) return;
    if (selectedLayerTab === 'tickets' && layers.tickets.data.length === 0) {
      setLayerLoading(true);
      routingApi.getTickets({ recordTypeName: recordType }).then((data) => {
        const tickets = Array.isArray(data) ? data : data.tickets ?? [];
        setLayerData('tickets', tickets);
        if (!layers.tickets.visible) toggleLayer('tickets');
      }).catch(() => {}).finally(() => setLayerLoading(false));
    }
    if (selectedLayerTab === 'shapes' && layers.shapes.data.length === 0) {
      setLayerLoading(true);
      routingApi.getShapes({ recordTypeName: recordType }).then((data) => {
        const shapes = Array.isArray(data) ? data : data.shapes ?? [];
        setLayerData('shapes', shapes);
        if (!layers.shapes.visible) toggleLayer('shapes');
      }).catch(() => {}).finally(() => setLayerLoading(false));
    }
  }, [selectedLayerTab, open]);

  return (
    <div className="absolute top-2 right-2 z-20 flex flex-col" style={{ maxHeight: 'calc(100% - 16px)' }}>
      {/* Toggle button */}
      <button
        className={`self-end flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg shadow-md transition ${
          open ? 'bg-primary text-white' : 'bg-surface text-txt border border-border hover:bg-bg'
        }`}
        onClick={() => setOpen((v) => !v)}
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
        </svg>
        Layers
      </button>

      {/* Panel */}
      {open && (
        <div className="mt-1 w-[360px] max-h-[calc(100%-40px)] bg-surface rounded-xl border border-border shadow-xl flex flex-col overflow-hidden">
          {/* Tabs */}
          <div className="flex border-b border-border shrink-0">
            {TABS.map((tab) => {
              const count = layers[tab].data.length;
              return (
                <button
                  key={tab}
                  className={`flex-1 py-2 text-center text-[12px] font-medium transition -mb-px border-b-2 ${
                    selectedLayerTab === tab
                      ? 'text-primary border-primary'
                      : 'text-txt-secondary border-transparent hover:text-txt'
                  }`}
                  onClick={() => setSelectedLayerTab(tab)}
                >
                  {tab.charAt(0).toUpperCase() + tab.slice(1)}
                  {count > 0 && <span className="ml-1 text-[10px] text-txt-secondary">({count})</span>}
                  <span
                    className={`ml-1 cursor-pointer text-xs transition-opacity ${layers[tab].visible ? 'opacity-100' : 'opacity-30'}`}
                    onClick={(e) => { e.stopPropagation(); toggleLayer(tab); }}
                    title={layers[tab].visible ? 'Hide layer' : 'Show layer'}
                  >
                    {layers[tab].visible ? '👁' : '👁‍🗨'}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-2">
            {layerLoading ? (
              <div className="flex flex-col items-center justify-center py-10 gap-2">
                <Spinner size="md" />
                <span className="text-xs text-txt-secondary">Loading…</span>
              </div>
            ) : (
              <>
                {selectedLayerTab === 'routes' && <RouteList routes={layers.routes.data} />}
                {selectedLayerTab === 'tickets' && <TicketList tickets={layers.tickets.data} />}
                {selectedLayerTab === 'shapes' && <ShapeList shapes={layers.shapes.data} />}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
