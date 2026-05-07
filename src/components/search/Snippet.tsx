import { Box } from '@mui/material';
import { parseSnippet } from '../../lib/sanitizeSnippet';

/**
 * Render an FTS5 snippet string with `<mark>` highlights as React
 * elements — never `dangerouslySetInnerHTML`.
 *
 * `parseSnippet` does the regex split; this component is the rendering
 * shell. Wrapped fragments get a faint yellow background via MUI sx
 * to match the system's Highlight color.
 */
export interface SnippetProps {
  text?: string | null;
  /** Optional inline-text component override (defaults to `span`). */
  component?: React.ElementType;
}

export function Snippet({ text, component = 'span' }: SnippetProps) {
  const fragments = parseSnippet(text);
  if (fragments.length === 0) return null;
  const Tag = component;
  return (
    <Tag>
      {fragments.map((f, i) =>
        f.kind === 'mark' ? (
          <Box
            key={i}
            component="mark"
            sx={{
              bgcolor: 'rgba(255, 235, 59, 0.45)',
              color: 'inherit',
              px: 0.25,
              borderRadius: 0.25,
            }}
          >
            {f.value}
          </Box>
        ) : (
          <span key={i}>{f.value}</span>
        ),
      )}
    </Tag>
  );
}
