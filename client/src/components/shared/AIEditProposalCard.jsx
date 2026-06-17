import { useState } from 'react';
import useStore from '../../store';
import * as routingApi from '../../api/routing';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';

/** Renders a before/after field change row. */
function ChangeRow({ label, from, to }) {
  if (!from && !to) return null;
  return (
    <div className="flex flex-col gap-0.5 py-1.5 border-b border-border/60 last:border-0">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-txt-secondary">{label}</span>
      <div className="flex items-center gap-2 text-[12px]">
        <span className="text-txt-secondary line-through">{from || '—'}</span>
        <span className="text-txt-secondary">→</span>
        <span className="font-medium text-txt">{to || '—'}</span>
      </div>
    </div>
  );
}

/**
 * In-chat approval card for a pending route_edit_proposal.
 * Manager must approve before changes are applied to Salesforce.
 */
export default function AIEditProposalCard({ proposal: initial }) {
  const refreshRoutes = useStore((s) => s.refreshRoutes);
  const selectRoute = useStore((s) => s.selectRoute);
  const [proposal, setProposal] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [localStatus, setLocalStatus] = useState(initial?.status || 'pending');

  if (!proposal?.proposalId) return null;

  const { changes = {}, summary, routeName, reason } = proposal;
  const header = changes.header || {};
  const isPending = localStatus === 'pending';

  const handleApprove = async () => {
    setBusy(true);
    try {
      const res = await routingApi.approveRouteEditProposal(proposal.proposalId);
      setLocalStatus('approved');
      setProposal((p) => ({ ...p, status: 'approved' }));
      await refreshRoutes();
      if (res?.googleRouteId) selectRoute(res.googleRouteId);
      toast.success('Changes approved and applied.');
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDecline = async () => {
    setBusy(true);
    try {
      await routingApi.declineRouteEditProposal(proposal.proposalId);
      setLocalStatus('declined');
      setProposal((p) => ({ ...p, status: 'declined' }));
      toast.info('Changes declined — nothing was modified.');
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 rounded-lg border border-ai/30 bg-surface overflow-hidden">
      <div className="px-3 py-2 bg-ai-bg/50 border-b border-ai/20">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold text-ai">Proposed Route Changes</span>
          {!isPending && (
            <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
              localStatus === 'approved' ? 'bg-success/10 text-success' : 'bg-txt-secondary/10 text-txt-secondary'
            }`}
            >
              {localStatus === 'approved' ? 'Approved' : 'Declined'}
            </span>
          )}
        </div>
        <p className="text-[12px] font-medium text-txt mt-1">{routeName}</p>
        {summary && <p className="text-[11px] text-txt-secondary mt-0.5">{summary}</p>}
        {reason && <p className="text-[11px] text-txt-secondary mt-1 italic">{reason}</p>}
      </div>

      <div className="px-3 py-2 space-y-1">
        {header.serviceDate && (
          <ChangeRow label="Service date" from={header.serviceDate.from} to={header.serviceDate.to} />
        )}
        {header.driver && (
          <ChangeRow label="Driver" from={header.driver.fromName} to={header.driver.toName} />
        )}
        {header.serviceLocationStart && (
          <ChangeRow label="Start yard" from={header.serviceLocationStart.fromName} to={header.serviceLocationStart.toName} />
        )}
        {header.serviceLocationEnd && (
          <ChangeRow label="End yard" from={header.serviceLocationEnd.fromName} to={header.serviceLocationEnd.toName} />
        )}

        {(changes.addStops?.length > 0) && (
          <div className="pt-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-success">Stops to add ({changes.addStops.length})</span>
            <ul className="mt-1 space-y-1">
              {changes.addStops.map((s) => (
                <li key={s.accountId} className="text-[11px] text-txt pl-2 border-l-2 border-success/40">
                  <span className="font-medium">{s.accountName}</span>
                  {s.address && <span className="block text-txt-secondary truncate">{s.address}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {(changes.removeStops?.length > 0) && (
          <div className="pt-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-error">Stops to remove ({changes.removeStops.length})</span>
            <ul className="mt-1 space-y-1">
              {changes.removeStops.map((s) => (
                <li key={s.stopId} className="text-[11px] text-txt pl-2 border-l-2 border-error/40">
                  <span className="font-medium">#{s.priority} {s.accountName}</span>
                  {s.address && <span className="block text-txt-secondary truncate">{s.address}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {isPending && (
        <div className="flex gap-2 px-3 py-2 border-t border-border bg-bg/50">
          <button
            type="button"
            disabled={busy}
            onClick={handleDecline}
            className="flex-1 h-8 rounded-lg border border-border text-txt text-[11px] font-medium hover:bg-surface transition disabled:opacity-50"
          >
            Decline
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={handleApprove}
            className="flex-1 h-8 rounded-lg bg-ai text-white text-[11px] font-medium hover:bg-ai-hover transition disabled:opacity-50"
          >
            {busy ? 'Applying…' : 'Approve changes'}
          </button>
        </div>
      )}
    </div>
  );
}
