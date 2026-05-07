import { describe, it, expect } from 'vitest';
import {
  decodeSearchState,
  encodeSearchState,
  hasActiveFilters,
  searchStatesEqual,
} from './searchUrl';
import type { SearchState } from '../../shared/types';

describe('searchUrl', () => {
  describe('decode', () => {
    it('extracts q and trims whitespace', () => {
      const s = decodeSearchState('q=%20darigold%20');
      expect(s.q).toBe('darigold');
    });

    it('returns empty q when missing', () => {
      const s = decodeSearchState('');
      expect(s.q).toBe('');
    });

    it('splits multi-value facets on comma and drops empties', () => {
      const s = decodeSearchState('q=foo&doc_type=coa,sds,,&supplier=acme');
      expect(s.doc_type).toEqual(['coa', 'sds']);
      expect(s.supplier).toEqual(['acme']);
    });

    it('omits the multi key entirely when value is blank', () => {
      const s = decodeSearchState('q=foo&doc_type=');
      expect(s.doc_type).toBeUndefined();
    });

    it('rejects unknown sort/date/type values silently', () => {
      const s = decodeSearchState('q=foo&sort=bogus&date=tomorrow&type=elephants');
      expect(s.sort).toBeUndefined();
      expect(s.date).toBeUndefined();
      expect(s.type).toBeUndefined();
    });

    it('drops sort=relevance and date=any (canonical form)', () => {
      const s = decodeSearchState('q=foo&sort=relevance&date=any');
      expect(s.sort).toBeUndefined();
      expect(s.date).toBeUndefined();
    });

    it('keeps page when > 1, drops otherwise', () => {
      expect(decodeSearchState('q=foo&page=2').page).toBe(2);
      expect(decodeSearchState('q=foo&page=1').page).toBeUndefined();
      expect(decodeSearchState('q=foo&page=abc').page).toBeUndefined();
    });

    it('parses universal-search type and customer filter', () => {
      const s = decodeSearchState('q=butter&type=orders&customer=cust_1,cust_2');
      expect(s.type).toBe('orders');
      expect(s.customer).toEqual(['cust_1', 'cust_2']);
    });
  });

  describe('encode', () => {
    it('drops blank q', () => {
      expect(encodeSearchState({ q: '' }).toString()).toBe('');
      expect(encodeSearchState({ q: '   ' }).toString()).toBe('');
    });

    it('joins multi facets with comma', () => {
      const params = encodeSearchState({
        q: 'foo',
        doc_type: ['coa', 'sds'],
        supplier: ['acme'],
      });
      expect(params.get('doc_type')).toBe('coa,sds');
      expect(params.get('supplier')).toBe('acme');
    });

    it('omits defaults (sort=relevance, date=any, page=1, type=documents)', () => {
      const params = encodeSearchState({
        q: 'foo',
        sort: 'relevance',
        date: 'any',
        page: 1,
        type: 'documents',
      });
      expect(params.toString()).toBe('q=foo');
    });

    it('keeps non-default sort/date/page/type', () => {
      const params = encodeSearchState({
        q: 'foo',
        sort: 'newest',
        date: 'last_30d',
        page: 3,
        type: 'orders',
      });
      expect(params.get('sort')).toBe('newest');
      expect(params.get('date')).toBe('last_30d');
      expect(params.get('page')).toBe('3');
      expect(params.get('type')).toBe('orders');
    });

    it('omits empty arrays', () => {
      const params = encodeSearchState({ q: 'foo', doc_type: [] });
      expect(params.has('doc_type')).toBe(false);
    });
  });

  describe('round-trip', () => {
    it('decode(encode(s)) preserves canonical state', () => {
      const cases: SearchState[] = [
        { q: 'darigold' },
        { q: 'foo', doc_type: ['coa', 'sds'], supplier: ['s1'] },
        { q: 'butter', type: 'orders', customer: ['c1'], status: ['pending'] },
        { q: 'x', date: 'last_7d', sort: 'newest', page: 4 },
      ];
      for (const s of cases) {
        const round = decodeSearchState(encodeSearchState(s));
        expect(round).toEqual(s);
      }
    });
  });

  describe('helpers', () => {
    it('searchStatesEqual ignores key order', () => {
      const a: SearchState = { q: 'x', supplier: ['a'], doc_type: ['c'] };
      const b: SearchState = { q: 'x', doc_type: ['c'], supplier: ['a'] };
      expect(searchStatesEqual(a, b)).toBe(true);
    });

    it('hasActiveFilters is false for q-only state', () => {
      expect(hasActiveFilters({ q: 'foo' })).toBe(false);
    });

    it('hasActiveFilters is true when a multi facet is set', () => {
      expect(hasActiveFilters({ q: 'foo', supplier: ['a'] })).toBe(true);
    });

    it('hasActiveFilters is true for non-default sort/date', () => {
      expect(hasActiveFilters({ q: 'foo', date: 'last_30d' })).toBe(true);
      expect(hasActiveFilters({ q: 'foo', sort: 'newest' })).toBe(true);
    });
  });
});
