'use client';

import { useEffect, useRef } from 'react';

/**
 * Listens to a branch's live queue feed and calls back when something moves
 * (ENC-F-19).
 *
 * The events are invalidation signals, not data (ENC-R-08): they say that
 * something changed, and the caller refetches. That is what makes a missed
 * event harmless — the next refetch is the truth either way — and it is why
 * nothing sensitive travels down this connection.
 *
 * `EventSource` reconnects by itself with a backoff, which covers
 * ENC-N-03. The refetch on open is the other half: a client that was
 * disconnected for a minute has to catch up, and it does so by asking
 * rather than by replaying anything.
 */
export function useQueueStream(url: string | null, onChange: () => void): void {
  // Held in a ref so a new callback on every render does not reopen the
  // connection. A waiting-room screen keeps this open for twelve hours, and
  // reconnecting on each render would make it useless.
  //
  // Updated in an effect rather than during render: a ref written while
  // rendering is a side effect, and React is entitled to render twice.
  const handler = useRef(onChange);
  useEffect(() => {
    handler.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!url) return;
    const source = new EventSource(url, { withCredentials: true });

    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as { heartbeat?: string; kind?: string };
        // A heartbeat only proves the connection is alive. Refetching on it
        // would turn a keep-alive into a poll.
        if (payload.heartbeat) return;
      } catch {
        // Unreadable payload: refetch anyway. The server is the authority.
      }
      handler.current();
    };

    source.onopen = () => {
      // Catch up on anything missed while it was closed.
      handler.current();
    };

    return () => source.close();
  }, [url]);
}
