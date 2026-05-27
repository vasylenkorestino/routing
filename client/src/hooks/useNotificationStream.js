import { useEffect } from 'react';
import useStore from '../store';

/**
 * Wires the bell-notification SSE stream to the auth lifecycle.
 * Loads the unread list once and connects EventSource while a token is present.
 */
export default function useNotificationStream() {
  const token = useStore((s) => s.token);
  const loadInitial = useStore((s) => s.loadInitial);
  const connectStream = useStore((s) => s.connectStream);
  const disconnectStream = useStore((s) => s.disconnectStream);

  useEffect(() => {
    if (!token) {
      disconnectStream();
      return undefined;
    }
    loadInitial();
    connectStream();
    return () => disconnectStream();
  }, [token, loadInitial, connectStream, disconnectStream]);
}
