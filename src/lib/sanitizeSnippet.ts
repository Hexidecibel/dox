/**
 * Safe `<mark>`-rendered snippet utility for FTS5 highlights.
 *
 * The backend wraps matched terms with literal `<mark>...</mark>` strings
 * (FTS5 `snippet()` argument). We deliberately avoid
 * `dangerouslySetInnerHTML` — instead split the string on the marker
 * tags and emit React-native `<mark>` elements around the matched
 * fragments. Anything outside `<mark>` is rendered as plain text, so
 * stray HTML from extracted_text can't escape into the DOM.
 *
 * `parseSnippet` is the pure function (easy to unit-test). The React
 * renderer lives in `src/components/search/Snippet.tsx`.
 */

export type SnippetFragment =
  | { kind: 'text'; value: string }
  | { kind: 'mark'; value: string };

const MARK_RE = /<mark>([\s\S]*?)<\/mark>/g;

/**
 * Parse a snippet string into alternating text/mark fragments. Returns
 * an empty array for empty/null input.
 */
export function parseSnippet(snippet: string | null | undefined): SnippetFragment[] {
  if (!snippet) return [];

  const out: SnippetFragment[] = [];
  let lastIndex = 0;
  // Reset regex state — module-level `lastIndex` would leak across calls.
  MARK_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = MARK_RE.exec(snippet)) !== null) {
    if (match.index > lastIndex) {
      out.push({ kind: 'text', value: snippet.slice(lastIndex, match.index) });
    }
    out.push({ kind: 'mark', value: match[1] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < snippet.length) {
    out.push({ kind: 'text', value: snippet.slice(lastIndex) });
  }
  return out;
}
