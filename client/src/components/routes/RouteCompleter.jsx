import { useMemo, useState } from 'react';
import useStore from '../../store';
import * as routingApi from '../../api/routing';
import { OverlaySpinner } from '../ui/Spinner';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';

/** Confirmation modal for completing a route */
export default function RouteCompleter() {
  const isComplete = useStore((st) => st.isComplete);
  const closeModal = useStore((st) => st.closeModal);
  const route = useStore((st) => st.route);
  const refreshRoutes = useStore((st) => st.refreshRoutes);
  const [loading, setLoading] = useState(false);

  const { stops, totalGallons, missingGallons } = useMemo(() => {
    const pts = route?.Routes__r?.records ?? route?.Routes__r ?? [];
    const total = pts.reduce((sum, p) => sum + (parseFloat(p.Gallons_Collected__c) || 0), 0);
    const missing = pts.filter((p) => !p.Gallons_Collected__c || parseFloat(p.Gallons_Collected__c) === 0);
    return { stops: pts, totalGallons: total, missingGallons: missing };
  }, [route]);

  const handleComplete = async () => {
    setLoading(true);
    try {
      await routingApi.completeRoute({ googleRoute: { Id: route.Id } });
      await refreshRoutes();
      closeModal('isComplete');
    } catch (err) { toast.error(getErrorMessage(err)); }
    finally { setLoading(false); }
  };

  if (!isComplete) return null;

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/35" onClick={() => closeModal('isComplete')}>
      <div className="w-[420px] max-w-[92vw] bg-surface rounded-xl shadow-2xl flex flex-col relative" onClick={(e) => e.stopPropagation()}>
        {loading && <OverlaySpinner label="Completing route…" />}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
          <h3 className="text-base font-semibold text-txt">Complete Route</h3>
          <button className="text-xl text-txt-secondary hover:text-error transition" onClick={() => closeModal('isComplete')}>×</button>
        </div>
        <div className="p-5 flex flex-col gap-4">
          <div className="flex flex-col gap-2 p-4 bg-bg rounded-xl">
            {[
              ['Route', route?.Name],
              ['Driver', route?.DriverName__c || 'Unassigned'],
              ['Stops', stops.length],
              ['Total Gallons', totalGallons.toFixed(1)],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between text-sm">
                <span className="text-txt-secondary">{label}</span>
                <span className="font-semibold text-txt">{value}</span>
              </div>
            ))}
          </div>

          {missingGallons.length > 0 && (
            <div className="flex items-start gap-2 p-3 bg-warning-bg border border-warning/30 rounded-lg text-sm text-warning">
              <span>⚠</span>
              <span>{missingGallons.length} stop{missingGallons.length > 1 ? 's' : ''} missing gallon data.</span>
            </div>
          )}

          <p className="text-sm text-txt-secondary">This action will mark the route as completed. This cannot be undone.</p>
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border">
          <button className="h-[34px] px-4 rounded-lg border border-border text-txt text-[13px] font-medium hover:bg-bg transition" onClick={() => closeModal('isComplete')}>Cancel</button>
          <button className="h-[34px] px-4 rounded-lg bg-success text-white text-[13px] font-medium hover:opacity-90 transition disabled:opacity-50" onClick={handleComplete} disabled={loading}>
            {loading ? 'Completing…' : 'Complete'}
          </button>
        </div>
      </div>
    </div>
  );
}
