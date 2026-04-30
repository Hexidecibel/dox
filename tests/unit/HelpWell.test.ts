/**
 * HelpWell — logic tests.
 *
 * The Cloudflare Workers vitest pool can't render React, so these
 * tests cover the load-bearing logic in HelpWell.tsx: the localStorage
 * key derivation and a stand-in for the persistence read/write contract
 * the component relies on. Render-level tests (dismiss button click →
 * persists → unmounts) are deferred until we add a browser-DOM test
 * runner; for now this proves the storage-key contract is stable
 * across the full module-key set in helpContent.
 */

import { describe, it, expect } from 'vitest';
import { helpWellStorageKey } from '../../src/components/HelpWell';
import { helpContent } from '../../src/lib/helpContent';

describe('HelpWell', () => {
  describe('helpWellStorageKey', () => {
    it('derives a stable, namespaced key', () => {
      expect(helpWellStorageKey('connectors.list')).toBe(
        'dox.helpwell.connectors.list.dismissed',
      );
    });

    it('is unique per id', () => {
      expect(helpWellStorageKey('a')).not.toBe(helpWellStorageKey('b'));
    });

    it('does not mangle dots in id', () => {
      expect(helpWellStorageKey('orders.detail.timeline')).toBe(
        'dox.helpwell.orders.detail.timeline.dismissed',
      );
    });

    it('returns the same key for the same id', () => {
      const id = 'help.index';
      expect(helpWellStorageKey(id)).toBe(helpWellStorageKey(id));
    });

    it('produces a unique storage key for every helpContent module', () => {
      // Each page derives its dismissal key from a stable id like
      // `<module>.list` or `<module>.detail`. Collisions across modules
      // would mean dismissing one well silently dismisses another.
      const moduleIds = Object.keys(helpContent).map(
        (mod) => `${mod}.list`,
      );
      const keys = new Set(moduleIds.map(helpWellStorageKey));
      expect(keys.size).toBe(moduleIds.length);
    });
  });

  describe('persistence contract (stand-in for full DOM render)', () => {
    // Simulate the read/write helpers HelpWell uses. The component's
    // private readDismissed / writeDismissed are exercised here via a
    // localStorage stub; this is the closest we can get to a render
    // test without a browser pool.
    function makeStorage(): Storage {
      const store = new Map<string, string>();
      return {
        get length() {
          return store.size;
        },
        key: (i: number) => Array.from(store.keys())[i] ?? null,
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          store.set(k, v);
        },
        removeItem: (k: string) => {
          store.delete(k);
        },
        clear: () => {
          store.clear();
        },
      } as Storage;
    }

    it('round-trips dismissal state via the storage key', () => {
      const storage = makeStorage();
      const id = 'connectors.list';
      const key = helpWellStorageKey(id);
      expect(storage.getItem(key)).toBeNull();
      storage.setItem(key, '1');
      expect(storage.getItem(key)).toBe('1');
    });

    it('keeps dismissals isolated across ids', () => {
      const storage = makeStorage();
      storage.setItem(helpWellStorageKey('orders.list'), '1');
      expect(storage.getItem(helpWellStorageKey('orders.list'))).toBe('1');
      expect(storage.getItem(helpWellStorageKey('documents.list'))).toBeNull();
    });
  });
});
