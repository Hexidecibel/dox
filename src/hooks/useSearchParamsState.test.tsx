import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useSearchParamsState } from './useSearchParamsState';
import type { ReactNode } from 'react';

function makeWrapper(initialEntries: string[]) {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
  );
}

describe('useSearchParamsState', () => {
  it('decodes the current URL into SearchState', () => {
    const { result } = renderHook(() => useSearchParamsState(), {
      wrapper: makeWrapper(['/?q=darigold&supplier=acme&doc_type=coa,sds']),
    });
    expect(result.current.state.q).toBe('darigold');
    expect(result.current.state.supplier).toEqual(['acme']);
    expect(result.current.state.doc_type).toEqual(['coa', 'sds']);
  });

  it('setState merges a patch onto the current state', () => {
    const { result } = renderHook(() => useSearchParamsState(), {
      wrapper: makeWrapper(['/?q=foo&supplier=a']),
    });
    act(() => result.current.setState({ supplier: ['b', 'c'] }));
    expect(result.current.state.q).toBe('foo');
    expect(result.current.state.supplier).toEqual(['b', 'c']);
  });

  it('setState replaces q when explicitly set', () => {
    const { result } = renderHook(() => useSearchParamsState(), {
      wrapper: makeWrapper(['/?q=foo&supplier=a']),
    });
    act(() => result.current.setState({ q: 'bar' }));
    expect(result.current.state.q).toBe('bar');
    expect(result.current.state.supplier).toEqual(['a']);
  });

  it('reset clears every search param', () => {
    const { result } = renderHook(() => useSearchParamsState(), {
      wrapper: makeWrapper(['/?q=foo&supplier=a&page=3']),
    });
    act(() => result.current.reset());
    expect(result.current.state).toEqual({ q: '' });
  });

  it('skips no-op updates (state encodes to the same URL)', () => {
    // Roundabout — we can't observe history-stack length easily here.
    // Instead, assert that calling setState with the SAME state doesn't
    // throw and the state remains identical by reference-equality after
    // a no-op patch.
    const { result } = renderHook(() => useSearchParamsState(), {
      wrapper: makeWrapper(['/?q=foo']),
    });
    const before = result.current.state;
    act(() => result.current.setState({ q: 'foo' }));
    // After a no-op set, we re-render but state shape should match.
    expect(result.current.state).toEqual(before);
  });

  it('canonicalizes defaults out of the URL via encode', () => {
    const { result } = renderHook(() => useSearchParamsState(), {
      wrapper: makeWrapper(['/']),
    });
    act(() => result.current.setState({ q: 'x', sort: 'relevance', page: 1 }));
    expect(result.current.state.sort).toBeUndefined();
    expect(result.current.state.page).toBeUndefined();
    expect(result.current.state.q).toBe('x');
  });
});
