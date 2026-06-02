import { useState, useEffect } from 'react';
import { Box, Paper, CircularProgress, Alert, Typography } from '@mui/material';
// The browser build ships no bundled types, but its runtime API matches 'mammoth'.
// @ts-expect-error -- no type declarations for the browser subpath
import mammoth from 'mammoth/mammoth.browser';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** True for Word .docx files (by mime or extension — some arrive as octet-stream/zip). */
export function isDocxFile(mimeType?: string | null, fileName?: string | null): boolean {
  if (mimeType === DOCX_MIME) return true;
  if (fileName && fileName.toLowerCase().endsWith('.docx')) return true;
  return false;
}

/**
 * Light sanitiser for mammoth's HTML output. Mammoth only emits a small set of
 * formatting elements, but docx hyperlinks can carry a `javascript:` target —
 * neutralise those plus any stray script/style/event handlers before we render.
 */
function sanitizeDocxHtml(html: string): string {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  tpl.content.querySelectorAll('script, style, iframe, object, embed').forEach((el) => el.remove());
  tpl.content.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const val = attr.value.trim().toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name);
      if ((name === 'href' || name === 'src') && val.startsWith('javascript:')) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return tpl.innerHTML;
}

interface DocxPreviewProps {
  /** URL (incl. blob: object URLs) to fetch the .docx bytes from. */
  url?: string;
  /** Or pass the file/blob bytes directly (e.g. a locally-selected File). */
  file?: Blob;
  fileName?: string;
}

export default function DocxPreview({ url, file, fileName }: DocxPreviewProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setHtml(null);

    const getBytes = async (): Promise<ArrayBuffer> => {
      if (file) return await file.arrayBuffer();
      if (url) {
        const res = await fetch(url);
        if (!res.ok) throw new Error('Failed to fetch document');
        return await res.arrayBuffer();
      }
      throw new Error('No document source');
    };

    getBytes()
      .then((arrayBuffer) => mammoth.convertToHtml({ arrayBuffer }))
      .then((result: { value: string }) => {
        if (cancelled) return;
        const clean = sanitizeDocxHtml(result.value || '');
        setHtml(clean || '<p><em>This document appears to be empty.</em></p>');
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to render document');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [url, file]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 300 }}>
        <CircularProgress size={24} />
      </Box>
    );
  }

  if (error) {
    return (
      <Alert severity="warning" sx={{ m: 2 }}>
        Could not render {fileName ? <strong>{fileName}</strong> : 'this Word document'} inline ({error}).
        Download it to view the contents.
      </Alert>
    );
  }

  return (
    <Paper
      variant="outlined"
      sx={{
        m: 2,
        p: { xs: 2, sm: 4 },
        maxHeight: 600,
        overflow: 'auto',
        bgcolor: '#fff',
        // Word-ish document typography
        '& p': { my: 0.75, lineHeight: 1.6 },
        '& h1, & h2, & h3, & h4': { mt: 2, mb: 1, fontWeight: 700 },
        '& table': { borderCollapse: 'collapse', width: '100%', my: 1.5 },
        '& td, & th': { border: '1px solid', borderColor: 'divider', p: 0.75, fontSize: '0.85rem', verticalAlign: 'top' },
        '& ul, & ol': { pl: 3, my: 0.75 },
        '& img': { maxWidth: '100%', height: 'auto' },
        '& a': { color: 'primary.main' },
      }}
    >
      <Typography component="div" variant="body2" dangerouslySetInnerHTML={{ __html: html || '' }} />
    </Paper>
  );
}
