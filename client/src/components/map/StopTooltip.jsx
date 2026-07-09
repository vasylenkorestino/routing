import { OverlayView } from '@react-google-maps/api';

/** Centers the tooltip horizontally and places it above the marker circle. */
const pixelOffset = (width, height) => ({ x: -width / 2, y: -height - 26 });

/**
 * Small hover tooltip for a stop marker — number, account, address and the
 * most important service facts. Pointer-events are disabled so it never
 * steals the hover from the marker underneath.
 */
export default function StopTooltip({ stop, index, status }) {
  const lastServiced = stop.Last_Route_Serviced_Date__c || stop.Account__r?.Last_Service_Date__c;
  const gallons = stop.LastGallonsCollected__c;

  return (
    <OverlayView
      position={{ lat: Number(stop.Latitude__c), lng: Number(stop.Longitude__c) }}
      mapPaneName={OverlayView.FLOAT_PANE}
      getPixelPositionOffset={pixelOffset}
    >
      <div className="pointer-events-none w-max max-w-[240px] bg-surface border border-border rounded-lg shadow-lg px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span className="text-[12px] font-semibold text-txt truncate">
            {index + 1}. {stop.Account_Name__c || stop.Name || '—'}
          </span>
          {status && (
            <span
              className="text-[9px] font-bold text-white rounded-full px-1.5 py-px shrink-0"
              style={{ background: status.color }}
            >
              {status.label}
            </span>
          )}
        </div>
        {stop.Container_Address__c && (
          <div className="text-[10px] text-txt-secondary truncate mt-0.5">{stop.Container_Address__c}</div>
        )}
        <div className="flex items-center gap-2 mt-1 text-[10px] text-txt-secondary">
          {lastServiced && <span>Last: {lastServiced}</span>}
          {gallons != null && gallons !== '' && <span className="font-semibold text-primary">{gallons} gal</span>}
          {stop.ServiceType__c && <span className="truncate">{stop.ServiceType__c}</span>}
        </div>
      </div>
    </OverlayView>
  );
}
