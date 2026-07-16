import { useState, useEffect, useRef } from 'react';
import useStore from '../store';
import * as routingApi from '../api/routing';

/**
 * Cache-first Last Services loader (latest 10).
 * Uses preloaded Zustand cache when present; otherwise fetches once and caches.
 */
export default function useLastServices(accountId) {
  const cached = useStore((s) => (accountId ? s.lastServicesByAccountId?.[accountId] : null));
  const cacheLastServices = useStore((s) => s.cacheLastServices);
  const [loading, setLoading] = useState(false);
  const fetchingRef = useRef(null);

  useEffect(() => {
    if (!accountId || cached) {
      setLoading(false);
      return undefined;
    }
    if (fetchingRef.current === accountId) return undefined;

    fetchingRef.current = accountId;
    let cancelled = false;
    setLoading(true);

    routingApi.getLastServices(accountId)
      .then((res) => {
        if (cancelled) return;
        cacheLastServices(accountId, {
          services: res.services ?? [],
          account: res.account ?? null,
        });
      })
      .catch(() => {
        if (cancelled) return;
        cacheLastServices(accountId, { services: [], account: null });
      })
      .finally(() => {
        if (fetchingRef.current === accountId) fetchingRef.current = null;
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [accountId, cached, cacheLastServices]);

  return {
    services: cached ? (cached.services ?? []) : null,
    account: cached?.account ?? null,
    loading: !!accountId && !cached && loading,
  };
}
