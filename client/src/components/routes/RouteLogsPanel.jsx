import { useState } from 'react';
import AILogsModal from './AILogsModal';

/**
 * AI Logs for a route. Renders inline (embedded) by default and lets the user
 * pop the same view out into a focused modal — the underlying component instance
 * is reused, so popping in/out preserves loaded logs, filters, and selection.
 */
export default function RouteLogsPanel({ googleRouteId, routeName }) {
  const [popped, setPopped] = useState(false);
  return (
    <AILogsModal
      googleRouteId={googleRouteId}
      routeName={routeName}
      variant={popped ? 'modal' : 'embedded'}
      onTogglePop={() => setPopped((p) => !p)}
    />
  );
}
