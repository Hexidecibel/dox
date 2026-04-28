import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Typography,
  CircularProgress,
  Alert,
} from '@mui/material';
import ReactMarkdown from 'react-markdown';

export interface ReleaseSummary {
  version: string;
  date: string;
  title: string;
}

export interface ReleaseIndex {
  current: string;
  versions: ReleaseSummary[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  initialVersion?: string;
}

async function fetchIndex(): Promise<ReleaseIndex> {
  const res = await fetch('/releases/index.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load release index: ${res.status}`);
  return res.json();
}

async function fetchNotes(version: string): Promise<string> {
  const res = await fetch(`/releases/v${version}.md`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load release notes for v${version}: ${res.status}`);
  return res.text();
}

function stripFrontmatter(md: string): string {
  if (!md.startsWith('---')) return md;
  const end = md.indexOf('\n---', 3);
  if (end === -1) return md;
  return md.slice(end + 4).replace(/^\s+/, '');
}

export function ReleaseNotesModal({ open, onClose, initialVersion }: Props) {
  const [index, setIndex] = useState<ReleaseIndex | null>(null);
  const [selected, setSelected] = useState<string | null>(initialVersion ?? null);
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchIndex()
      .then((idx) => {
        if (cancelled) return;
        setIndex(idx);
        setSelected((prev) => prev ?? initialVersion ?? idx.current);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [open, initialVersion]);

  useEffect(() => {
    if (!open || !selected) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchNotes(selected)
      .then((md) => {
        if (!cancelled) setContent(stripFrontmatter(md));
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, selected]);

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" scroll="paper">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 2, justifyContent: 'space-between' }}>
        <Box>Release Notes</Box>
        <FormControl size="small" sx={{ minWidth: 200 }}>
          <InputLabel id="release-version-label">Version</InputLabel>
          <Select
            labelId="release-version-label"
            label="Version"
            value={selected ?? ''}
            onChange={(e) => setSelected(String(e.target.value))}
          >
            {(index?.versions ?? []).map((v) => (
              <MenuItem key={v.version} value={v.version}>
                v{v.version} — {v.date}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </DialogTitle>
      <DialogContent dividers>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {loading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={28} />
          </Box>
        )}
        {!loading && !error && (
          <Box
            sx={{
              '& h1': { typography: 'h5', mt: 2, mb: 1 },
              '& h2': { typography: 'h6', mt: 2, mb: 1 },
              '& h3': { typography: 'subtitle1', fontWeight: 600, mt: 2, mb: 1 },
              '& p': { typography: 'body2', mb: 1 },
              '& ul, & ol': { pl: 3, mb: 1 },
              '& li': { typography: 'body2', mb: 0.5 },
              '& code': {
                fontFamily: 'monospace',
                bgcolor: 'action.hover',
                px: 0.5,
                py: 0.25,
                borderRadius: 0.5,
                fontSize: '0.85em',
              },
              '& pre': {
                bgcolor: 'action.hover',
                p: 1.5,
                borderRadius: 1,
                overflow: 'auto',
                '& code': { bgcolor: 'transparent', p: 0 },
              },
              '& a': { color: 'primary.main' },
            }}
          >
            <ReactMarkdown>{content}</ReactMarkdown>
          </Box>
        )}
        {!loading && !error && !content && (
          <Typography variant="body2" color="text.secondary">No release notes available.</Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
