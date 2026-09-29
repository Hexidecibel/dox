import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, ButtonBase, Dialog, InputBase, Stack, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { useRecentSearches } from '../../hooks/useRecentSearches';
import { encodeQuery, EMPTY_QUERY, type Clause } from '../../../shared/searchQuery';
import type { UniversalSearchResponse } from '../../../shared/types';
import { chipParts, chipSentence } from '../../lib/searchChips';
import { AI_VIOLET } from './ClauseChip';
import { Kbd } from './AnswerCard';

/**
 * ⌘K / Ctrl-K, from anywhere (search redesign Phase 2): the omnibox as an
 * overlay. Enter searches on /search; ⌘/Ctrl+Enter hands the words to the AI.
 * As you type it shows how the words will READ (POST /api/search/interpret —
 * the same reading the search will judge) and what they name (suppliers,
 * products, orders, customers, bundles, documents), each one keystroke away.
 * Both lookups are debounced and abortable; nothing is judged here.
 */
export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  tenantId?: string;
  modKey: string;
}

interface Item {
  group: string;
  icon: string;
  label: string;
  detail?: string;
  ai?: boolean;
  run: () => void;
}

const GO_TO: Array<{ label: string; path: string }> = [
  { label: 'Documents', path: '/documents' },
  { label: 'Search', path: '/search' },
  { label: 'Review Queue', path: '/review' },
  { label: 'Renewals', path: '/expirations' },
  { label: 'Requests', path: '/requests' },
  { label: 'Orders', path: '/orders' },
];

export function CommandPalette({ open, onClose, tenantId, modKey }: CommandPaletteProps) {
  const navigate = useNavigate();
  const recent = useRecentSearches();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const [reading, setReading] = useState<Clause[]>([]);
  const [hits, setHits] = useState<UniversalSearchResponse | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setIdx(0);
      setReading([]);
      setHits(null);
    }
  }, [open]);

  useEffect(() => {
    const text = q.trim();
    if (!open || text.length < 2) {
      setReading([]);
      setHits(null);
      return;
    }
    const c = new AbortController();
    const t = setTimeout(() => {
      api.search.interpret({ text, tenant_id: tenantId }, c.signal).then((r) => !c.signal.aborted && setReading(r.clauses)).catch(() => undefined);
      api.search
        .universal({ q: text, tenant_id: tenantId, limit: 3, limit_per_type: 3 }, c.signal)
        .then((r) => !c.signal.aborted && setHits(r))
        .catch(() => undefined);
    }, 180);
    return () => {
      clearTimeout(t);
      c.abort();
    };
  }, [q, open, tenantId]);

  const go = (path: string) => {
    onClose();
    navigate(path);
  };
  const searchFor = (text: string, ai = false) => {
    const p = encodeQuery({ ...EMPTY_QUERY, text });
    if (ai) p.set('ai', '1');
    go(`/search?${p.toString()}`);
  };

  const items = useMemo<Item[]>(() => {
    const text = q.trim();
    const lower = text.toLowerCase();
    const out: Item[] = [];
    if (text) {
      out.push({
        group: 'Search',
        icon: '↵',
        label: `Search for “${text}”`,
        detail: reading.length ? `reads as ${reading.map((c) => chipSentence(chipParts(c))).join(' · ')}` : 'Enter',
        run: () => searchFor(text),
      });
      out.push({ group: 'Search', icon: '✦', ai: true, label: `Ask AI: “${text}”`, detail: `${modKey}↵`, run: () => searchFor(text, true) });
    }
    for (const r of recent.recent.filter((r) => !lower || r.toLowerCase().includes(lower)).slice(0, text ? 3 : 5)) {
      out.push({ group: 'Recent searches', icon: '◷', label: r, run: () => searchFor(r) });
    }
    if (hits) {
      for (const s of hits.suppliers.results) {
        out.push({ group: 'Jump to', icon: 'S', label: s.name, detail: 'documents from this supplier', run: () => go(`/search?${encodeQuery({ ...EMPTY_QUERY, clauses: [{ id: 'c1', field: 'supplier', op: 'in', values: [s.id], source: 'builder' }] })}`) });
      }
      for (const p of hits.products.results) {
        out.push({ group: 'Jump to', icon: 'P', label: p.name, detail: 'documents for this product', run: () => go(`/search?${encodeQuery({ ...EMPTY_QUERY, clauses: [{ id: 'c1', field: 'product', op: 'in', values: [p.id], source: 'builder' }] })}`) });
      }
      for (const o of hits.orders.results) {
        out.push({ group: 'Jump to', icon: '#', label: `Order ${o.order_number ?? ''}${o.customer_name ? ` · ${o.customer_name}` : ''}`, detail: o.po_number ? `PO ${o.po_number}` : 'order', run: () => go(`/orders/${o.id}`) });
      }
      for (const c of hits.customers.results) out.push({ group: 'Jump to', icon: 'C', label: c.name, detail: 'customer', run: () => go(`/customers/${c.id}`) });
      for (const b of hits.bundles.results) out.push({ group: 'Jump to', icon: 'B', label: b.name, detail: 'bundle', run: () => go(`/bundles/${b.id}`) });
      for (const d of hits.documents.results.slice(0, 3)) {
        out.push({ group: 'Documents', icon: '▤', label: d.title ?? 'Document', detail: d.supplier_name ?? undefined, run: () => go(`/documents/${d.id}`) });
      }
    }
    for (const g of GO_TO.filter((g) => !lower || g.label.toLowerCase().includes(lower))) {
      out.push({ group: 'Go to', icon: '→', label: g.label, run: () => go(g.path) });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, reading, hits, recent.recent, modKey]);

  useEffect(() => {
    if (idx >= items.length) setIdx(0);
  }, [items.length, idx]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-pi="${idx}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [idx]);

  let lastGroup = '';
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      PaperProps={{
        'data-command-palette': '1',
        sx: { borderRadius: 4, mt: { xs: 2, sm: '12vh' }, alignSelf: 'flex-start', overflow: 'hidden', boxShadow: '0 1px 3px rgba(15,26,46,.05), 0 40px 80px -24px rgba(15,26,46,.45)' },
      } as object}
      slotProps={{ backdrop: { sx: { bgcolor: 'rgba(12,18,32,.38)', backdropFilter: 'blur(2px)' } } }}
      aria-label="Command palette"
    >
      <Box data-testid="command-palette">
        <Stack direction="row" alignItems="center" spacing={1.25} sx={{ px: 2, py: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}>
          <SearchRoundedIcon sx={{ color: 'text.secondary' }} />
          <InputBase
            autoFocus
            fullWidth
            value={q}
            placeholder="Search documents, jump to a supplier, product or order…"
            onChange={(e) => {
              setQ(e.target.value);
              setIdx(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIdx((i) => (items.length ? (i + 1) % items.length : 0));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIdx((i) => (items.length ? (i - 1 + items.length) % items.length : 0));
              } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (q.trim()) searchFor(q.trim(), true);
              } else if (e.key === 'Enter') {
                e.preventDefault();
                items[idx]?.run();
              }
            }}
            inputProps={{ 'aria-label': 'Command', 'data-testid': 'palette-input', autoComplete: 'off' }}
            sx={{ fontSize: '1.05rem' }}
          />
          <Kbd>esc</Kbd>
        </Stack>
        <Box ref={listRef} sx={{ maxHeight: '52vh', overflowY: 'auto', py: 0.75 }} role="listbox">
          {items.map((it, i) => {
            const head = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <Box key={`${it.group}-${i}-${it.label}`}>
                {head && (
                  <Typography variant="overline" sx={{ display: 'block', px: 2, pt: 1, fontSize: '0.62rem', letterSpacing: '0.1em', color: 'text.secondary' }}>
                    {head}
                  </Typography>
                )}
                <ButtonBase
                  data-pi={i}
                  role="option"
                  aria-selected={i === idx}
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => it.run()}
                  sx={(t) => ({
                    width: '100%',
                    justifyContent: 'flex-start',
                    gap: 1.25,
                    px: 2,
                    py: 0.9,
                    textAlign: 'left',
                    bgcolor: i === idx ? alpha(t.palette.primary.main, 0.07) : 'transparent',
                  })}
                >
                  <Box
                    component="span"
                    sx={(t) => ({
                      width: 24,
                      height: 24,
                      flexShrink: 0,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 1,
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      color: it.ai ? AI_VIOLET : 'text.secondary',
                      bgcolor: it.ai ? alpha(AI_VIOLET, 0.1) : t.palette.action.hover,
                    })}
                  >
                    {it.icon}
                  </Box>
                  <Typography variant="body2" sx={{ fontWeight: 500, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1 }}>
                    {it.label}
                  </Typography>
                  <Box sx={{ flex: 1 }} />
                  {it.detail && (
                    <Typography variant="caption" color="text.secondary" sx={{ minWidth: 0, maxWidth: '55%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {it.detail}
                    </Typography>
                  )}
                </ButtonBase>
              </Box>
            );
          })}
          {items.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 2 }}>
              Type a lot, a date, a PO, a supplier or a question.
            </Typography>
          )}
        </Box>
        <Stack direction="row" spacing={2} sx={{ px: 2, py: 1, borderTop: '1px solid', borderColor: 'divider', bgcolor: 'action.hover' }}>
          <Typography variant="caption" color="text.secondary"><Kbd>↑</Kbd><Kbd>↓</Kbd> move</Typography>
          <Typography variant="caption" color="text.secondary"><Kbd>↵</Kbd> open</Typography>
          <Typography variant="caption" color="text.secondary"><Kbd>{modKey}↵</Kbd> Ask AI</Typography>
          <Typography variant="caption" color="text.secondary"><Kbd>esc</Kbd> close</Typography>
        </Stack>
      </Box>
    </Dialog>
  );
}
