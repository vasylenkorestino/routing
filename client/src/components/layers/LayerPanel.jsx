import { useEffect } from 'react';
import useStore from '../../store';
import * as routingApi from '../../api/routing';
import RouteList from './RouteList';
import TicketList from './TicketList';
import ShapeList from './ShapeList';

const TABS = ['routes', 'tickets', 'shapes'];

/** Right-side layer panel with Routes / Tickets / Shapes tabs — lazy-loads tickets & shapes */
export default function LayerPanel() {
  const layers = useStore((st) => st.layers);
  const selectedLayerTab = useStore((st) => st.selectedLayerTab);
  const setSelectedLayerTab = useStore((st) => st.setSelectedLayerTab);
  const toggleLayer = useStore((st) => st.toggleLayer);
  const setLayerData = useStore((st) => st.setLayerData);
  const recordType = useStore((st) => st.recordType);

  useEffect(() => {
    if (selectedLayerTab === 'tickets' && layers.tickets.data.length === 0) {
      routingApi.getTickets({ recordTypeName: recordType }).then((data) => {
        const tickets = Array.isArray(data) ? data : data.tickets ?? [];
        setLayerData('tickets', tickets);
        if (!layers.tickets.visible) toggleLayer('tickets');
      }).catch(() => {});
    }
    if (selectedLayerTab === 'shapes' && layers.shapes.data.length === 0) {
      routingApi.getShapes({ recordTypeName: recordType }).then((data) => {
        const shapes = Array.isArray(data) ? data : data.shapes ?? [];
        setLayerData('shapes', shapes);
        if (!layers.shapes.visible) toggleLayer('shapes');
      }).catch(() => {});
    }
  }, [selectedLayerTab]);

  return (
    <div className="flex flex-col h-full bg-surface">
      <div className="flex border-b border-border">
        {TABS.map((tab) => {
          const count = layers[tab].data.length;
          return (
            <button
              key={tab}
              className={`flex-1 py-2 text-center text-[13px] font-medium transition -mb-px border-b-2 ${
                selectedLayerTab === tab
                  ? 'text-primary border-primary'
                  : 'text-txt-secondary border-transparent hover:text-txt'
              }`}
              onClick={() => setSelectedLayerTab(tab)}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
              {count > 0 && <span className="ml-1 text-[11px] text-txt-secondary">({count})</span>}
              <span
                className={`ml-1 cursor-pointer text-sm transition-opacity ${layers[tab].visible ? 'opacity-100' : 'opacity-30'}`}
                onClick={(e) => { e.stopPropagation(); toggleLayer(tab); }}
                title={layers[tab].visible ? 'Hide layer' : 'Show layer'}
              >
                {layers[tab].visible ? '👁' : '👁‍🗨'}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {selectedLayerTab === 'routes' && <RouteList routes={layers.routes.data} />}
        {selectedLayerTab === 'tickets' && <TicketList tickets={layers.tickets.data} />}
        {selectedLayerTab === 'shapes' && <ShapeList shapes={layers.shapes.data} />}
      </div>
    </div>
  );
}
