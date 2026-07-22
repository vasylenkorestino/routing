import { useState, useEffect, useRef, useCallback } from 'react';
import useStore from '../../store';
import { DEFAULT_TICKET_TYPE } from '../../store/mapSlice';
import * as routingApi from '../../api/routing';
import RouteList from '../layers/RouteList';
import TicketList from '../layers/TicketList';
import ShapeList from '../layers/ShapeList';
import AccountTicketSearch from '../shared/AccountTicketSearch';
import Spinner from '../ui/Spinner';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';

const TABS = ['routes', 'tickets', 'shapes'];

/** Bounding-box padding around route stops (~20 miles). */
const ROUTE_BBOX_PAD = 0.3;
/** Below this zoom the viewport is too large for progressive ticket fetches. */
const MIN_TICKET_FETCH_ZOOM = 7;
/** Server-side cap per ticket fetch. */
const TICKET_FETCH_LIMIT = 300;

/** Padded bbox around a route's stops, or null when it has no coordinates. */
function routeBBox(route) {
  const stops = route?.Routes__r?.records ?? route?.Routes__r ?? [];
  const lats = stops.map((s) => Number(s.Latitude__c)).filter((n) => Number.isFinite(n) && n !== 0);
  const lngs = stops.map((s) => Number(s.Longitude__c)).filter((n) => Number.isFinite(n) && n !== 0);
  if (!lats.length || !lngs.length) return null;
  return {
    minLat: Math.min(...lats) - ROUTE_BBOX_PAD,
    maxLat: Math.max(...lats) + ROUTE_BBOX_PAD,
    minLng: Math.min(...lngs) - ROUTE_BBOX_PAD,
    maxLng: Math.max(...lngs) + ROUTE_BBOX_PAD,
  };
}

/** True when bbox `a` is fully inside bbox `b`. */
function bboxContains(b, a) {
  return a.minLat >= b.minLat && a.maxLat <= b.maxLat && a.minLng >= b.minLng && a.maxLng <= b.maxLng;
}

/** Polls an async AI job until it completes; returns the job result. */
async function pollAIJob(jobId, { intervalMs = 2000, timeoutMs = 180000 } = {}) {
  const started = Date.now();
  for (;;) {
    const job = await routingApi.getAIJob(jobId);
    if (job.status === 'complete') return job.result;
    if (job.status === 'error') throw new Error(job.error || 'AI job failed');
    if (Date.now() - started > timeoutMs) throw new Error('AI job timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Panel min/max drag width (px). */
const PANEL_MIN_WIDTH = 300;
const PANEL_MAX_WIDTH = 760;

/** Docked, full-height, resizable side panel on the map — routes/tickets/shapes */
export default function MapOverlayPanel() {
  const [open, setOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(380);

  /** Drag the left edge to resize the panel (drag left = wider). */
  const startResize = useCallback((e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelWidth;
    const onMove = (ev) => {
      const delta = startX - ev.clientX;
      setPanelWidth(Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, startW + delta)));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [panelWidth]);
  const [layerLoading, setLayerLoading] = useState(false);
  const [ticketFetching, setTicketFetching] = useState(false);
  const [loadingType, setLoadingType] = useState(null);
  const [suggesting, setSuggesting] = useState(false);
  const layers = useStore((st) => st.layers);
  const selectedLayerTab = useStore((st) => st.selectedLayerTab);
  const setSelectedLayerTab = useStore((st) => st.setSelectedLayerTab);
  const setLayerVisible = useStore((st) => st.setLayerVisible);
  const setLayerData = useStore((st) => st.setLayerData);
  const mergeTicketLayerData = useStore((st) => st.mergeTicketLayerData);
  const recordType = useStore((st) => st.recordType);
  const ticketsIsolated = useStore((st) => st.ticketsIsolated);
  const clearTicketsIsolation = useStore((st) => st.clearTicketsIsolation);
  const route = useStore((st) => st.route);
  const routeId = useStore((st) => st.routeId);
  const mapBounds = useStore((st) => st.mapBounds);
  const visibleTicketTypes = useStore((st) => st.visibleTicketTypes);
  const toggleTicketTypeVisibility = useStore((st) => st.toggleTicketTypeVisibility);
  const resetTicketTypeVisibility = useStore((st) => st.resetTicketTypeVisibility);
  const setTicketCandidates = useStore((st) => st.setTicketCandidates);
  const hasCandidates = useStore((st) => !!(st.routeId && st.ticketCandidates[st.routeId]));

  // BBoxes already fetched this session, per ticket type — skips redundant viewport fetches.
  const fetchedBoxes = useRef([]);

  const fetchTickets = useCallback(async (bbox, { initial = false, ticketType = null, quiet = false } = {}) => {
    const setBusy = quiet ? null : (initial ? setLayerLoading : setTicketFetching);
    setBusy?.(true);
    try {
      const params = {
        recordTypeName: recordType,
        limit: TICKET_FETCH_LIMIT,
        ...(ticketType ? { ticketType } : {}),
        ...(bbox || {}),
      };
      const data = await routingApi.getTickets(params);
      const tickets = Array.isArray(data) ? data : data.tickets ?? [];
      if (initial) {
        clearTicketsIsolation();
        setLayerData('tickets', tickets);
      } else {
        mergeTicketLayerData(tickets);
      }
      if (bbox) fetchedBoxes.current = [...fetchedBoxes.current.slice(-39), { ...bbox, _type: ticketType }];
      if (!useStore.getState().layers.tickets.visible) setLayerVisible('tickets', true);
    } catch {
      /* non-fatal — user can pan again */
    } finally {
      setBusy?.(false);
    }
  }, [recordType, clearTicketsIsolation, setLayerData, mergeTicketLayerData, setLayerVisible]);

  /** True when this bbox was already fetched for the given ticket type. */
  const alreadyFetched = (bbox, type) =>
    fetchedBoxes.current.some((b) => b._type === type && bboxContains(b, bbox));

  /** Current viewport as a bbox, or null when bounds are unknown. */
  const viewportBBox = () => mapBounds && {
    minLat: mapBounds.minLat, maxLat: mapBounds.maxLat,
    minLng: mapBounds.minLng, maxLng: mapBounds.maxLng,
  };

  /** Lazily loads one ticket type for the route area / current viewport (first time shown). */
  const ensureTypeLoaded = useCallback(async (type) => {
    const bbox = routeBBox(route) || viewportBBox();
    if (!bbox || alreadyFetched(bbox, type)) return;
    setLoadingType(type);
    try {
      await fetchTickets(bbox, { ticketType: type });
    } finally {
      setLoadingType(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, mapBounds, fetchTickets]);

  /** Eye toggle on a type row — flips map visibility and loads the type on first show. */
  const handleToggleType = useCallback((type) => {
    const willShow = !visibleTicketTypes[type];
    toggleTicketTypeVisibility(type);
    if (willShow) ensureTypeLoaded(type);
  }, [visibleTicketTypes, toggleTicketTypeVisibility, ensureTypeLoaded]);

  /** Loads tickets for the route/viewport area (default UCO type). */
  const ensureTicketsLoaded = useCallback(async ({ quiet = false } = {}) => {
    const st = useStore.getState();
    if (st.layers.tickets.data.length > 0 && !st.ticketsIsolated) return;
    const bbox = routeBBox(route) || viewportBBox();
    fetchedBoxes.current = [];
    resetTicketTypeVisibility();
    await fetchTickets(bbox, { initial: true, ticketType: DEFAULT_TICKET_TYPE, quiet });
  }, [route, mapBounds, resetTicketTypeVisibility, fetchTickets]);

  /** Loads shapes for the current record type when the layer is empty. */
  const ensureShapesLoaded = useCallback(async ({ quiet = false } = {}) => {
    if (useStore.getState().layers.shapes.data.length > 0) return;
    if (!quiet) setLayerLoading(true);
    try {
      const data = await routingApi.getShapes({ recordTypeName: recordType });
      const shapes = Array.isArray(data) ? data : data.shapes ?? [];
      setLayerData('shapes', shapes);
    } catch {
      /* non-fatal */
    } finally {
      if (!quiet) setLayerLoading(false);
    }
  }, [recordType, setLayerData]);

  /**
   * Eye icon: show/hide the layer on the map without switching tabs.
   * Turning a layer on also lazy-loads its data when empty.
   */
  const handleEyeClick = useCallback(async (tab, e) => {
    e.stopPropagation();
    const currentlyVisible = useStore.getState().layers[tab]?.visible;
    if (currentlyVisible) {
      setLayerVisible(tab, false);
      return;
    }
    if (tab === 'tickets') await ensureTicketsLoaded({ quiet: true });
    if (tab === 'shapes') await ensureShapesLoaded({ quiet: true });
    setLayerVisible(tab, true);
  }, [ensureTicketsLoaded, ensureShapesLoaded, setLayerVisible]);

  /* Initial loads when a tab is opened */
  useEffect(() => {
    if (!open) return;
    if (selectedLayerTab === 'tickets' && (layers.tickets.data.length === 0 || ticketsIsolated)) {
      ensureTicketsLoaded().then(() => {
        if (!useStore.getState().layers.tickets.visible) setLayerVisible('tickets', true);
      });
    } else if (selectedLayerTab === 'tickets' && routeId) {
      // Route switched — merge the new route's area for every currently-visible type.
      const bbox = routeBBox(route);
      if (bbox) {
        Object.keys(visibleTicketTypes)
          .filter((type) => visibleTicketTypes[type] && !alreadyFetched(bbox, type))
          .forEach((type) => fetchTickets(bbox, { ticketType: type }));
      }
    }
    if (selectedLayerTab === 'shapes' && layers.shapes.data.length === 0) {
      ensureShapesLoaded().then(() => {
        if (!useStore.getState().layers.shapes.visible) setLayerVisible('shapes', true);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLayerTab, open, routeId]);

  /* Progressive loading — pan/zoom pulls the currently-visible ticket types for the visible area */
  useEffect(() => {
    if (!mapBounds || !layers.tickets.visible || ticketsIsolated) return;
    if ((mapBounds.zoom ?? 0) < MIN_TICKET_FETCH_ZOOM) return;
    const viewport = {
      minLat: mapBounds.minLat, maxLat: mapBounds.maxLat,
      minLng: mapBounds.minLng, maxLng: mapBounds.maxLng,
    };
    Object.keys(visibleTicketTypes)
      .filter((type) => visibleTicketTypes[type] && !alreadyFetched(viewport, type))
      .forEach((type) => fetchTickets(viewport, { ticketType: type }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapBounds]);

  /* AI ticket suggestions for the selected route */
  const handleSuggest = useCallback(async () => {
    if (!routeId || suggesting) return;
    setSuggesting(true);
    try {
      const { jobId } = await routingApi.suggestTicketCandidates({ googleRouteId: routeId, recordTypeName: recordType });
      const result = await pollAIJob(jobId);
      const candidates = result?.candidates || [];
      setTicketCandidates(routeId, candidates);
      if (candidates.length) {
        toast.success(`${candidates.length} candidate ticket${candidates.length === 1 ? '' : 's'} highlighted for this route`);
      } else {
        toast.info(result?.summary || 'No good ticket candidates found for this route');
      }
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSuggesting(false);
    }
  }, [routeId, recordType, suggesting, setTicketCandidates]);

  const zoomedOut = (mapBounds?.zoom ?? 99) < MIN_TICKET_FETCH_ZOOM;
  const shownTicketCount = layers.tickets.data.filter((t) => visibleTicketTypes[t.Description]).length;

  return (
    <>
      {/* Collapsed — floating button, map stays full width */}
      {!open && (
        <button
          className="absolute top-2 right-2 z-20 flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg shadow-md bg-surface text-txt border border-border hover:bg-bg transition"
          onClick={() => setOpen(true)}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
          </svg>
          Layers
        </button>
      )}

      {/* Expanded — docked, full-height, resizable panel (map shrinks to fit) */}
      {open && (
        <div className="relative h-full flex shrink-0" style={{ width: panelWidth }}>
          {/* Drag handle */}
          <div
            className="w-1.5 h-full cursor-ew-resize bg-border/30 hover:bg-primary/40 transition shrink-0"
            onMouseDown={startResize}
            title="Drag to resize"
          />

          <div className="flex-1 min-w-0 h-full bg-surface border-l border-border flex flex-col overflow-hidden shadow-xl">
            {/* Header */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
              <svg className="w-4 h-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
              </svg>
              <span className="flex-1 font-semibold text-[13px] text-txt">Layers</span>
              <button
                className="w-6 h-6 flex items-center justify-center rounded-md text-txt-secondary hover:bg-bg hover:text-txt transition"
                onClick={() => setOpen(false)}
                title="Collapse panel"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                </svg>
              </button>
            </div>

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
                    onClick={(e) => handleEyeClick(tab, e)}
                    title={layers[tab].visible ? 'Hide on map' : 'Show on map (without switching tab)'}
                  >
                    {layers[tab].visible ? '👁' : '👁‍🗨'}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Tickets toolbar — area label, AI suggest, progressive-load state */}
          {selectedLayerTab === 'tickets' && !layerLoading && (
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-bg/40 shrink-0">
              <span className="flex-1 text-[11px] text-txt-secondary truncate">
                {shownTicketCount} ticket{shownTicketCount !== 1 ? 's' : ''} shown on map
                {ticketFetching && <span className="ml-1 animate-pulse">· loading…</span>}
              </span>
              {zoomedOut && layers.tickets.data.length > 0 && (
                <span className="text-[10px] text-txt-secondary italic shrink-0" title="Progressive loading pauses when zoomed out">
                  Zoom in to load more
                </span>
              )}
              <button
                type="button"
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold transition shrink-0 ${
                  routeId
                    ? 'bg-ai/10 text-ai border border-ai/30 hover:bg-ai/20'
                    : 'bg-bg text-txt-secondary border border-border cursor-not-allowed opacity-60'
                }`}
                onClick={handleSuggest}
                disabled={!routeId || suggesting}
                title={routeId ? 'AI: highlight tickets that fit the selected route' : 'Select a route first'}
              >
                <span>✦</span>
                {suggesting ? 'Analyzing…' : hasCandidates ? 'Re-suggest' : 'Suggest tickets'}
              </button>
            </div>
          )}

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
                {selectedLayerTab === 'tickets' && (
                  <div className="space-y-2">
                    {/* Search accounts & tickets to add directly to the route */}
                    <AccountTicketSearch />
                    <TicketList
                      tickets={layers.tickets.data}
                      onToggleType={handleToggleType}
                      loadingType={loadingType}
                    />
                  </div>
                )}
                {selectedLayerTab === 'shapes' && <ShapeList shapes={layers.shapes.data} />}
              </>
            )}
          </div>
          </div>
        </div>
      )}
    </>
  );
}
