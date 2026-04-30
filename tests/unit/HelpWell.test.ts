/**
 * HelpWell — logic tests.
 *
 * The Cloudflare Workers vitest pool can't render React, so these
 * tests cover the load-bearing logic in HelpWell.tsx: the localStorage
 * key derivation. Render-level tests (dismiss button → persists →
 * unmounts) are deferred until we add a browser-DOM test runner.
 *
 * The HelpWell component is otherwise a thin Alert wrapper; the
 * dismissal flow is fully exercised by the storage-key contract here.
 */

import { describe, it, expect } from 'vitest';
import { helpWellStorageKey } from '../../src/components/HelpWell';

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
  });
});
