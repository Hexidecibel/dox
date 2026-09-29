import { useEffect, useRef, useState } from 'react';
import { Box, ButtonBase, Stack, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import type { UniversalSearchResponse } from '../../../shared/types';

/**
 * "Jump to" (search redesign Phase 2): the suppliers, products, document
 * types, orders, customers and bundles the words name, as one thin row above
 * the results — never as tabs competing with the answer.
 *
 * It is a SEPARATE, lazy call (`GET /api/search`, debounced and abortable), so
 * the main query never pays for seven entity lookups per keystroke. A
 * supplier, product or type is offered as a FILTER (a scope chip), because
 * that is what a person searching documents wants from it; an order, customer
 * or bundle opens its page.
 */
export interface JumpRowProps {
  words: string;
  tenantId?: string;
  onFilter: (field: 'supplier' | 'product' | 'document_type', id: string, name: string) => void;
  /** Ids already filtered on, so they are not offered again. */
  active?: Set<string>;
}

type Item = { key: string; kind: string; label: string; sub?: string | null; run: () => void };

export function JumpRow({ words, tenantId, onFilter, active }: JumpRowProps) {
  const navigate = useNavigate();
  const [data, setData] = useState<UniversalSearchResponse | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => {
    const q = words.trim();
    ctrl.current?.abort();
    if (q.length < 2) {
      setData(null);
      return;
    }
    const c = new AbortController();
    ctrl.current = c;
    const t = setTimeout(() => {
      api.search
        .universal({ q, tenant_id: tenantId, limit: 1, limit_per_type: 3 }, c.signal)
        .then((r) => {
          if (!c.signal.aborted) setData(r);
        })
        .catch(() => {
          if (!c.signal.aborted) setData(null);
        });
    }, 400);
    return () => {
      clearTimeout(t);
      c.abort();
    };
  }, [words, tenantId]);

  if (!data) return null;
  const items: Item[] = [
    ...data.suppliers.results.filter((s) => !active?.has(s.id)).map((s) => ({ key: `s-${s.id}`, kind: 'supplier', label: s.name, run: () => onFilter('supplier', s.id, s.name) })),
    ...data.products.results.filter((p) => !active?.has(p.id)).map((p) => ({ key: `p-${p.id}`, kind: 'product', label: p.name, run: () => onFilter('product', p.id, p.name) })),
    ...data.doc_types.results.filter((d) => !active?.has(d.id)).map((d) => ({ key: `t-${d.id}`, kind: 'type', label: d.name, run: () => onFilter('document_type', d.id, d.name) })),
    ...data.orders.results.map((o) => ({ key: `o-${o.id}`, kind: 'order', label: o.order_number ?? o.id, sub: o.customer_name, run: () => navigate(`/orders/${o.id}`) })),
    ...data.customers.results.map((c) => ({ key: `c-${c.id}`, kind: 'customer', label: c.name, run: () => navigate(`/customers/${c.id}`) })),
    ...data.bundles.results.map((b) => ({ key: `b-${b.id}`, kind: 'bundle', label: b.name, run: () => navigate(`/bundles/${b.id}`) })),
  ].slice(0, 8);
  if (items.length === 0) return null;

  return (
    <Stack direction="row" spacing={0.75} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap', mb: 2 }} data-testid="jump-row">
      <Typography variant="overline" sx={{ fontSize: '0.65rem', letterSpacing: '0.1em', color: 'text.secondary', mr: 0.5 }}>
        Jump to
      </Typography>
      {items.map((it) => (
        <ButtonBase
          key={it.key}
          onClick={it.run}
          title={['supplier', 'product', 'type'].includes(it.kind) ? `Filter to ${it.kind} ${it.label}` : `Open ${it.kind} ${it.label}`}
          sx={{
            gap: 0.75,
            px: 1.25,
            py: 0.4,
            borderRadius: 999,
            border: '1px solid',
            borderColor: 'divider',
            bgcolor: 'background.paper',
            fontSize: '0.8rem',
            '&:hover': { borderColor: 'primary.light', bgcolor: 'action.hover' },
          }}
        >
          <Box component="span" sx={{ fontSize: '0.65rem', color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {['supplier', 'product', 'type'].includes(it.kind) ? `+ ${it.kind}` : it.kind}
          </Box>
          <Box component="span" sx={{ fontWeight: 600 }}>{it.label}</Box>
          {it.sub && <Box component="span" sx={{ color: 'text.secondary' }}>{it.sub}</Box>}
        </ButtonBase>
      ))}
    </Stack>
  );
}
