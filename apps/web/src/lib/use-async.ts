'use client';

import { useEffect, type DependencyList } from 'react';

/**
 * Load data when a screen mounts, or when its filters change. One hook, so no
 * screen grows its own subtly different version.
 *
 * Fetching from an API is synchronising with an external system, which is what
 * effects are for; state is set from the resolved promise rather than in the
 * effect body, so it does not cascade renders.
 *
 * `debounceMs` covers search-as-you-type, where the dependency changes on
 * every keystroke.
 */
export function useAsyncEffect(
  run: () => Promise<unknown>,
  deps: DependencyList,
  options: { debounceMs?: number } = {},
): void {
  const { debounceMs = 0 } = options;

  useEffect(() => {
    let cancelled = false;
    const start = () => {
      if (!cancelled) void run();
    };
    if (debounceMs === 0) {
      start();
      return () => {
        cancelled = true;
      };
    }
    const timer = setTimeout(start, debounceMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
