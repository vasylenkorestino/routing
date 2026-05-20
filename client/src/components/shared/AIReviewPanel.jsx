import { useCallback } from 'react';
import useStore from '../../store';
import AIBadge from './AIBadge';

/** Modal for reviewing AI-generated routes */
export default function AIReviewPanel() {
  const { pendingReviewRoutes, isReviewOpen, approveRoutes, declineRoutes } = useStore();

  const handleApproveAll = useCallback(() => {
    approveRoutes(pendingReviewRoutes.map((r) => r.id));
  }, [approveRoutes, pendingReviewRoutes]);

  const handleDismissAll = useCallback(() => {
    declineRoutes(pendingReviewRoutes.map((r) => r.id));
  }, [declineRoutes, pendingReviewRoutes]);

  if (!isReviewOpen || !pendingReviewRoutes.length) return null;

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40">
      <div className="w-[560px] max-w-[94vw] max-h-[80vh] overflow-y-auto bg-surface rounded-xl shadow-2xl p-6">
        <div className="flex items-center gap-2 text-base font-semibold text-txt mb-4">
          <AIBadge approved />
          Review AI Routes
        </div>

        <div className="space-y-3">
          {pendingReviewRoutes.map((route) => (
            <div key={route.id} className="border border-border rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium text-sm text-txt">{route.Name ?? route.name ?? 'Route'}</span>
                <div className="flex gap-1.5">
                  <button className="h-7 px-2.5 rounded bg-success text-white text-xs font-medium hover:opacity-90 transition" onClick={() => approveRoutes([route.id])}>Approve</button>
                  <button className="h-7 px-2.5 rounded bg-error text-white text-xs font-medium hover:opacity-90 transition" onClick={() => declineRoutes([route.id])}>Deny</button>
                </div>
              </div>
              {route.reason && <p className="text-xs text-txt-secondary italic mb-2">{route.reason}</p>}
              {(route.points ?? route.stops ?? []).map((pt, i) => (
                <div key={i} className="text-xs text-txt py-0.5">{i + 1}. {pt.Address ?? pt.Name ?? '—'}</div>
              ))}
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-2 mt-4 pt-3 border-t border-border">
          <button className="h-[34px] px-4 rounded-lg border border-border text-txt text-[13px] font-medium hover:bg-bg transition" onClick={handleDismissAll}>Dismiss All</button>
          <button className="h-[34px] px-4 rounded-lg bg-primary text-white text-[13px] font-medium hover:bg-primary-hover transition" onClick={handleApproveAll}>Approve All</button>
        </div>
      </div>
    </div>
  );
}
