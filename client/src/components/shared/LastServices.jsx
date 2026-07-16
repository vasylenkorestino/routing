import { useState, useCallback } from 'react';
import useLastServices from '../../hooks/useLastServices';

/** Collapsible drawer showing account service history + account info */
export default function LastServices({ accountId, accountName }) {
  const [open, setOpen] = useState(true);
  const { services, account, loading } = useLastServices(accountId);

  const toggle = useCallback(() => {
    setOpen((v) => !v);
  }, []);

  const statusColor = {
    Active: 'bg-green-100 text-green-700',
    Inactive: 'bg-red-100 text-red-700',
    Pending: 'bg-yellow-100 text-yellow-700',
  };

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-surface">
      <button
        className="flex items-center justify-between w-full px-3 py-2.5 text-[13px] font-medium text-txt hover:bg-bg transition"
        onClick={toggle}
      >
        <span>Last Services for <strong>{accountName ?? 'Account'}</strong></span>
        <span className="text-xs text-txt-secondary transition-transform duration-200" style={{ transform: open ? 'rotate(180deg)' : 'rotate(0)' }}>▲</span>
      </button>

      {open && (
        <div>
          {/* Account summary chips */}
          {account && (
            <div className="flex flex-wrap gap-2 px-3 py-2 border-t border-border">
              {account.Payment_Schedule_Status__c && (
                <span className={`inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded-full ${statusColor[account.Payment_Schedule_Status__c] ?? 'bg-gray-100 text-gray-600'}`}>
                  {account.Payment_Schedule_Status__c}
                </span>
              )}
              {account.Tank_Size__c && (
                <span className="inline-flex items-center gap-1 text-[11px] text-txt-secondary bg-bg px-2 py-0.5 rounded-full">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>
                  {account.Tank_Size__c}
                </span>
              )}
              {account.Second_Container__c && (
                <span className="inline-flex items-center gap-1 text-[11px] text-txt-secondary bg-bg px-2 py-0.5 rounded-full">
                  2nd: {account.Second_Container__c}
                </span>
              )}
            </div>
          )}

          <div className="overflow-x-auto border-t border-border">
            {loading && <div className="p-3 text-xs text-txt-secondary animate-pulse">Loading…</div>}
            {!loading && services && services.length === 0 && (
              <div className="p-4 text-xs text-txt-secondary text-center">No service history</div>
            )}
            {!loading && services && services.length > 0 && (
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="bg-bg/50">
                    <th className="text-left px-2.5 py-2 font-semibold text-txt-secondary">Ref#</th>
                    <th className="text-left px-2.5 py-2 font-semibold text-txt-secondary">Code</th>
                    <th className="text-left px-2.5 py-2 font-semibold text-txt-secondary">Date</th>
                    <th className="text-right px-2.5 py-2 font-semibold text-txt-secondary">Gallons</th>
                    <th className="text-left px-2.5 py-2 font-semibold text-txt-secondary">Notes</th>
                    <th className="text-left px-2.5 py-2 font-semibold text-txt-secondary">Driver Notes</th>
                    <th className="text-left px-2.5 py-2 font-semibold text-txt-secondary">By</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {services.map((s, i) => (
                    <tr key={s.Id ?? i} className="hover:bg-bg/40 transition-colors">
                      <td className="px-2.5 py-1.5 text-txt font-medium">{s.Name ?? '—'}</td>
                      <td className="px-2.5 py-1.5">
                        {s.Code__c
                          ? <span className="inline-block text-[10px] font-semibold bg-primary/10 text-primary px-1.5 py-0.5 rounded">{s.Code__c}</span>
                          : '—'}
                      </td>
                      <td className="px-2.5 py-1.5 text-txt tabular-nums">{s.Service_Date__c ?? '—'}</td>
                      <td className="px-2.5 py-1.5 text-txt tabular-nums text-right font-medium">{s.Qty_Gallons__c != null ? s.Qty_Gallons__c : '—'}</td>
                      <td className="px-2.5 py-1.5 text-txt-secondary max-w-[120px] truncate" title={s.Notes__c}>{s.Notes__c ?? '—'}</td>
                      <td className="px-2.5 py-1.5 text-txt-secondary max-w-[120px] truncate" title={s.DriverNotes__c}>{s.DriverNotes__c ?? '—'}</td>
                      <td className="px-2.5 py-1.5 text-txt">{s.ServicedBy__c ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
