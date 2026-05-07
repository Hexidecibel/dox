import { describe, it, expect } from 'vitest';
import { parseSnippet } from './sanitizeSnippet';

describe('parseSnippet', () => {
  it('returns empty array for null/undefined/empty', () => {
    expect(parseSnippet(null)).toEqual([]);
    expect(parseSnippet(undefined)).toEqual([]);
    expect(parseSnippet('')).toEqual([]);
  });

  it('returns a single text fragment when no marks', () => {
    expect(parseSnippet('plain text')).toEqual([
      { kind: 'text', value: 'plain text' },
    ]);
  });

  it('splits a single mark out of surrounding text', () => {
    expect(parseSnippet('hello <mark>world</mark>!')).toEqual([
      { kind: 'text', value: 'hello ' },
      { kind: 'mark', value: 'world' },
      { kind: 'text', value: '!' },
    ]);
  });

  it('handles multiple marks', () => {
    expect(parseSnippet('<mark>a</mark> and <mark>b</mark>')).toEqual([
      { kind: 'mark', value: 'a' },
      { kind: 'text', value: ' and ' },
      { kind: 'mark', value: 'b' },
    ]);
  });

  it('does not honor stray html tags outside <mark>', () => {
    // The split function preserves them as text; the React renderer never
    // calls `dangerouslySetInnerHTML`, so they will render as literal text.
    const fragments = parseSnippet('a <script>x</script> <mark>b</mark>');
    expect(fragments).toEqual([
      { kind: 'text', value: 'a <script>x</script> ' },
      { kind: 'mark', value: 'b' },
    ]);
  });

  it('does not greedy-match across marks', () => {
    // If the regex were greedy, the inner `</mark>X<mark>` content would
    // collapse into one mark fragment. Verify it stays split.
    const fragments = parseSnippet('<mark>one</mark>X<mark>two</mark>');
    expect(fragments).toEqual([
      { kind: 'mark', value: 'one' },
      { kind: 'text', value: 'X' },
      { kind: 'mark', value: 'two' },
    ]);
  });

  it('is reentrant — module-level regex state does not leak', () => {
    parseSnippet('<mark>a</mark>');
    // A second call with a different shape should still parse correctly.
    expect(parseSnippet('plain')).toEqual([{ kind: 'text', value: 'plain' }]);
  });
});
