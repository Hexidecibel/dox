import { useEffect, useState } from 'react';

/**
 * Returns `value` debounced by `delayMs` (default 300ms).
 *
 * Used to throttle the FTS5 query while the user is still typing — we
 * don't want to fire a search on every keystroke. The implementation
 * is intentionally minimal; we don't expose `flush()` or `cancel()`
 * because every consumer just wants the latest value after a pause.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}
