import { useState, useEffect, useRef, useCallback } from 'react';
import * as routingApi from '../../api/routing';
import useStore from '../../store';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';

/**
 * Unified search — shows accounts with expandable ticket sections.
 * Clicking an account row expands it to show open tickets for that account.
 * "Add" on the account adds it as-is; "Add" on a ticket adds it with that ticket type.
 */
export default function AccountTicketSearch({ mode = 'add', onAdd }) {
  const storeRouteId = useStore((s) => s.routeId);
  const routes = useStore((s) => s.routes);
  const refreshRoutes = useStore((s) => s.refreshRoutes);
  const [selectedRouteId, setSelectedRouteId] = useState('');
  const routeId = storeRouteId || selectedRouteId;

  const [term, setTerm] = useState('');
  const [accounts, setAccounts] = useState([]);
  const [ticketMap, setTicketMap] = useState({});
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const debounceRef = useRef(null);

  const search = useCallback(async (query) => {
    setSearching(true);
    const [acctRes, ticketRes] = await Promise.allSettled([
      routingApi.searchAccounts({ searchText: query }),
      routingApi.getTickets({ searchText: query }),
    ]);

    const accts = acctRes.status === 'fulfilled'
      ? (Array.isArray(acctRes.value) ? acctRes.value : acctRes.value.accounts || [])
      : [];

    const tix = ticketRes.status === 'fulfilled'
      ? (Array.isArray(ticketRes.value) ? ticketRes.value : [])
      : [];

    // Group tickets by account Id
    const tMap = {};
    tix.forEach((t) => {
      if (!tMap[t.Id]) tMap[t.Id] = { account: t, tickets: [] };
      tMap[t.Id].tickets.push(t.Description || 'Other');
    });

    // Merge: accounts that also have tickets get their ticket list attached
    const merged = accts.map((a) => ({
      ...a,
      _tickets: tMap[a.Id]?.tickets || [],
    }));

    // Add ticket-only accounts (not in account search results)
    const acctIds = new Set(accts.map((a) => a.Id));
    Object.values(tMap).forEach(({ account, tickets }) => {
      if (!acctIds.has(account.Id)) {
        merged.push({ ...account, _tickets: tickets });
      }
    });

    setAccounts(merged);
    setTicketMap(tMap);
    setSearching(false);
    setExpandedId(null);
  }, []);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (term.length < 2) { setAccounts([]); setTicketMap({}); setExpandedId(null); return; }
    debounceRef.current = setTimeout(() => search(term), 400);
    return () => clearTimeout(debounceRef.current);
  }, [term, search]);

  const doAdd = async (account, ticketType = '') => {
    const key = account.Id + ticketType;
    if (mode === 'edit') {
      setAdding(key);
      try {
        await onAdd?.({ ...account, _source: ticketType ? 'ticket' : 'account', Description: ticketType });
      } finally {
        setAdding(null);
      }
      return;
    }
    if (!routeId) { toast.info('Please select a route first'); return; }
    setAdding(key);
    try {
      await routingApi.addPoint({ accountId: account.Id, routeId, ticketType });
      await refreshRoutes();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
    setAdding(null);
  };

  const wrapperRef = useRef(null);
  const [open, setOpen] = useState(false);

  const buildAddr = (item) =>
    [item.ShippingStreet, item.ShippingCity, item.ShippingState].filter(Boolean).join(', ');

  const noResults = term.length >= 2 && !searching && accounts.length === 0;

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  // Open dropdown when results arrive
  useEffect(() => {
    if (accounts.length > 0) setOpen(true);
  }, [accounts]);

  return (
    <div className="flex flex-col gap-1.5 relative" ref={wrapperRef}>
      {mode === 'add' && !storeRouteId && routes.length > 0 && (
        <select
          className="input-field w-full text-[12px]"
          value={selectedRouteId}
          onChange={(e) => setSelectedRouteId(e.target.value)}
        >
          <option value="">Select route to add to…</option>
          {routes.map((r) => <option key={r.Id} value={r.Id}>{r.Name}</option>)}
        </select>
      )}
      <div className="relative">
        <input
          className="input-field w-full pr-8"
          placeholder="Search accounts & tickets…"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onFocus={() => { if (accounts.length > 0) setOpen(true); }}
        />
        {searching && <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-txt-secondary animate-pulse">…</span>}
      </div>

      {open && accounts.length > 0 && (
        <div className="max-h-64 overflow-auto border border-border rounded-lg bg-surface shadow-sm divide-y divide-border">
          {accounts.map((acct, i) => {
            const key = acct.Id ?? i;
            const isExpanded = expandedId === key;
            const hasTickets = acct._tickets.length > 0;
            const isAddingAcct = adding === acct.Id;

            return (
              <div key={key}>
                {/* Account row */}
                <div className="flex items-center gap-2 px-3 py-2 hover:bg-primary-light/20 transition">
                  {/* Expand toggle */}
                  <button
                    className={`shrink-0 w-4 h-4 flex items-center justify-center text-[10px] rounded transition ${
                      hasTickets ? 'text-txt-secondary hover:text-txt' : 'text-transparent cursor-default'
                    }`}
                    onClick={() => hasTickets && setExpandedId(isExpanded ? null : key)}
                    disabled={!hasTickets}
                  >
                    <span style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0)', display: 'inline-block', transition: 'transform 0.15s' }}>
                      {hasTickets ? '▶' : ''}
                    </span>
                  </button>

                  <div className="flex-1 min-w-0 cursor-pointer" onClick={() => hasTickets && setExpandedId(isExpanded ? null : key)}>
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-[13px] text-txt truncate">{acct.Name}</span>
                      {hasTickets && (
                        <span className="shrink-0 text-[10px] font-semibold bg-warning/10 text-warning px-1.5 py-0.5 rounded">
                          {acct._tickets.length} ticket{acct._tickets.length !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-txt-secondary truncate">{buildAddr(acct) || '—'}</div>
                  </div>

                  <button
                    className="shrink-0 px-2.5 py-1 text-[11px] font-semibold rounded bg-primary text-white hover:bg-primary/90 disabled:opacity-40 transition"
                    onClick={() => doAdd(acct)}
                    disabled={isAddingAcct}
                  >
                    {isAddingAcct ? '…' : 'Add'}
                  </button>
                </div>

                {/* Expanded tickets */}
                {isExpanded && hasTickets && (
                  <div className="bg-bg/50 border-t border-border">
                    {acct._tickets.map((type, ti) => {
                      const isAddingTicket = adding === acct.Id + type;
                      return (
                        <div key={ti} className="flex items-center gap-2 pl-9 pr-3 py-1.5 hover:bg-primary-light/20 transition">
                          <span className="flex-1 text-[12px] text-txt">
                            <span className="inline-block text-[10px] font-semibold bg-warning/10 text-warning px-1.5 py-0.5 rounded mr-1.5">
                              {type}
                            </span>
                          </span>
                          <button
                            className="shrink-0 px-2 py-0.5 text-[10px] font-semibold rounded bg-warning/80 text-white hover:bg-warning disabled:opacity-40 transition"
                            onClick={() => doAdd(acct, type)}
                            disabled={isAddingTicket}
                          >
                            {isAddingTicket ? '…' : 'Add as ticket'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {open && noResults && <div className="text-xs text-txt-secondary px-1">No results found</div>}
    </div>
  );
}
