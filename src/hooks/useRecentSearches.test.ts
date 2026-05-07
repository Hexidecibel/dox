import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRecentSearches } from './useRecentSearches';

describe('useRecentSearches', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('starts empty when localStorage is empty', () => {
    const { result } = renderHook(() => useRecentSearches());
    expect(result.current.recent).toEqual([]);
  });

  it('hydrates from localStorage on mount', () => {
    window.localStorage.setItem(
      'dox.search.recent',
      JSON.stringify(['darigold', 'cheese']),
    );
    const { result } = renderHook(() => useRecentSearches());
    expect(result.current.recent).toEqual(['darigold', 'cheese']);
  });

  it('push adds to the front', () => {
    const { result } = renderHook(() => useRecentSearches());
    act(() => result.current.push('darigold'));
    act(() => result.current.push('butter'));
    expect(result.current.recent).toEqual(['butter', 'darigold']);
  });

  it('push dedupes — re-pushing an existing query moves it to the front', () => {
    const { result } = renderHook(() => useRecentSearches());
    act(() => result.current.push('a'));
    act(() => result.current.push('b'));
    act(() => result.current.push('c'));
    act(() => result.current.push('a'));
    expect(result.current.recent).toEqual(['a', 'c', 'b']);
  });

  it('push trims whitespace and ignores blank queries', () => {
    const { result } = renderHook(() => useRecentSearches());
    act(() => result.current.push('  darigold  '));
    act(() => result.current.push('   '));
    act(() => result.current.push(''));
    expect(result.current.recent).toEqual(['darigold']);
  });

  it('caps the list at 20 entries', () => {
    const { result } = renderHook(() => useRecentSearches());
    act(() => {
      for (let i = 0; i < 25; i++) result.current.push(`q${i}`);
    });
    expect(result.current.recent).toHaveLength(20);
    // Newest first — q24 was the last push.
    expect(result.current.recent[0]).toBe('q24');
    expect(result.current.recent[19]).toBe('q5');
  });

  it('persists across hook re-mount', () => {
    const { result, unmount } = renderHook(() => useRecentSearches());
    act(() => result.current.push('persist'));
    unmount();
    const { result: result2 } = renderHook(() => useRecentSearches());
    expect(result2.current.recent).toContain('persist');
  });

  it('remove drops a single entry', () => {
    const { result } = renderHook(() => useRecentSearches());
    act(() => result.current.push('a'));
    act(() => result.current.push('b'));
    act(() => result.current.remove('a'));
    expect(result.current.recent).toEqual(['b']);
  });

  it('clear empties the list', () => {
    const { result } = renderHook(() => useRecentSearches());
    act(() => result.current.push('a'));
    act(() => result.current.clear());
    expect(result.current.recent).toEqual([]);
    expect(window.localStorage.getItem('dox.search.recent')).toBe('[]');
  });

  it('survives malformed localStorage value', () => {
    window.localStorage.setItem('dox.search.recent', '{not json');
    const { result } = renderHook(() => useRecentSearches());
    expect(result.current.recent).toEqual([]);
  });

  it('survives non-array localStorage value', () => {
    window.localStorage.setItem('dox.search.recent', '{"foo":1}');
    const { result } = renderHook(() => useRecentSearches());
    expect(result.current.recent).toEqual([]);
  });
});
