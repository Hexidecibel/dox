/**
 * Order -> certificate coverage (AJ Conner, Any-Field COA Retrieval, A7).
 *
 * "Medosweet order 1809921 -> fixture COA (via the lot join)." The order lives
 * in the WMS; the certificate knows nothing of it. The join is the lot: an
 * order line carries the lot it shipped, and a certificate's lot rows carry
 * the lots it certifies.
 *
 * What counts as COVERING here is deliberately narrow, because §7 is explicit
 * that the portal "does not assert a lot-to-shipment match as established fact":
 *
 *   covering  a person ACCEPTED a lot-match suggestion linking this line to this
 *             certificate; or a lot row on the certificate is EXACTLY the lot
 *             the line shipped (base + sublot, the composite the WMS stores).
 *   likely    a pending suggestion ("suggested match — confirm"), or a link
 *             written automatically before matches became suggest-only
 *             (14 Sep 2026) that no person has accepted.
 *   near      the certificate certifies a different sublot of the shipped lot.
 *   mismatch  a person rejected this pairing; or nothing links them.
 *
 * Nothing here writes a link. Pure; retrieval is functions/lib/search-coverage.ts.
 */

import type { SearchConstraint, SearchConstraintCheck, SearchOrderEvidence, SearchOrderLine } from './types';
import { normalizeLotNumber, normalizeSubLotCode } from './lotNormalize';
import { checkProductIdentity, makeProductIdentityConstraint, type ProductSubject } from './productIdentity';

export interface OrderSubject extends ProductSubject {
  id: string;
  lots: Array<{ lot_number: string; sub_lot_code: string; lot_key: string; product_name?: string | null }>;
}

/**
 * When the line's product resolves (0107) and the certificate is plainly a
 * different product, the link is not what it looks like. A person's accept or
 * an exact lot row is then UNVERIFIED (flagged, not overruled — AJ: "flag, do
 * not resolve it in code"); a suggestion or an old auto-link is a mismatch.
 */
function productDisagreement(line: SearchOrderLine, s: OrderSubject, cid: string): string | null {
  if (!line.product_resolution) return null;
  const ch = checkProductIdentity(makeProductIdentityConstraint(cid, line.product_resolution, 'query_text'), s);
  return ch.outcome === 'mismatch' ? ch.message : null;
}

const RANK: Record<string, number> = { match: 9, likely: 8, near: 5, unverified: 2, mismatch: 1, missing: 0 };

const lower = (m: string) => m.charAt(0).toLowerCase() + m.slice(1);

function lineName(l: SearchOrderLine): string {
  return [l.product_code, l.product_name].filter(Boolean).join(' ') || 'a line';
}

export function makeOrderConstraint(id: string, order: SearchOrderEvidence, raw: string): SearchConstraint {
  return {
    id,
    kind: 'order',
    label: `order ${order.order_number}${order.customer_name ? ` (${order.customer_name})` : ''}`,
    raw,
    value: order.order_number,
    fields: ['order_items', 'lot_match_suggestions', 'lots'],
    source: 'query_text',
    note: `Followed through the order's lines to the lots they shipped (${order.lines.map((l) => l.lot_number).filter(Boolean).join(', ') || 'no lots recorded'}). A certificate covers the order only where a person accepted the match or a lot row is exactly the shipped lot.`,
    order,
  };
}

export function checkOrder(c: SearchConstraint, s: OrderSubject): SearchConstraintCheck {
  const order = c.order!;
  const base = { constraint_id: c.id, field: 'order', field_label: `order ${order.order_number}` } as const;
  let best: SearchConstraintCheck | null = null;
  const consider = (ch: SearchConstraintCheck) => {
    if (!best || RANK[ch.outcome] > RANK[best.outcome]) best = ch;
  };
  const docLots = s.lots.map((l) => {
    const b = normalizeLotNumber(l.lot_number);
    const sub = normalizeSubLotCode(l.sub_lot_code);
    return { base: b, sub, composite: b + sub, display: sub ? `${b}-${sub}` : b };
  }).filter((l) => l.base);

  for (const line of order.lines) {
    const name = lineName(line);
    if (line.rejected_document_ids.includes(s.id)) {
      consider({ ...base, outcome: 'mismatch', value: line.lot_number, provenance: 'reviewer',
        message: `A person rejected this certificate for order ${order.order_number} (${name}).` });
      continue;
    }
    const disagree = productDisagreement(line, s, c.id);
    if (line.accepted_document_ids.includes(s.id)) {
      const msg = `A person accepted this certificate for order ${order.order_number}, line ${name}${line.lot_number ? `, lot ${line.lot_number}` : ''}.`;
      consider(disagree
        ? { ...base, outcome: 'unverified', value: line.lot_number, provenance: 'reviewer', message: `${msg} But ${lower(disagree)} Check it before using it.` }
        : { ...base, outcome: 'match', value: line.lot_number, provenance: 'reviewer', message: msg });
      continue;
    }
    const shipped = line.lot_number ? normalizeLotNumber(line.lot_number) : '';
    const exact = shipped ? docLots.find((l) => l.composite === shipped || (!l.sub && l.base === shipped)) : undefined;
    if (exact) {
      const msg = `Lot ${exact.display} on this certificate is exactly the lot order ${order.order_number} shipped on line ${name} (${line.lot_number}).`;
      consider(disagree
        ? { ...base, outcome: 'unverified', value: exact.display, provenance: 'linked_record', message: `${msg} But ${lower(disagree)} Check it before using it.` }
        : { ...base, outcome: 'match', value: exact.display, provenance: 'linked_record', message: msg });
      continue;
    }
    const suggestion = line.suggested.find((x) => x.document_id === s.id);
    if (suggestion) {
      const how = [suggestion.basis?.replace(/_/g, ' '), suggestion.confidence != null ? `${Math.round(suggestion.confidence * 100)}%` : null].filter(Boolean).join(', ');
      consider(disagree
        ? { ...base, outcome: 'mismatch', value: line.lot_number, provenance: 'system',
          message: `Suggested for order ${order.order_number}, line ${name}${how ? ` (${how})` : ''}, but it is the wrong product: ${disagree}` }
        : { ...base, outcome: 'likely', value: line.lot_number, provenance: 'system',
          message: `Suggested match for order ${order.order_number}, line ${name}${how ? ` (${how})` : ''} — confirm it on the order before using this certificate.` });
      continue;
    }
    if (line.legacy_document_ids.includes(s.id)) {
      consider(disagree
        ? { ...base, outcome: 'mismatch', value: line.lot_number, provenance: 'system',
          message: `Linked to order ${order.order_number}, line ${name}, automatically before matches became suggestions, but it is the wrong product: ${disagree}` }
        : { ...base, outcome: 'likely', value: line.lot_number, provenance: 'system',
          message: `Linked to order ${order.order_number}, line ${name}, automatically before matches became suggestions — no person has accepted it. Confirm it on the order.` });
      continue;
    }
    const sibling = shipped ? docLots.find((l) => l.sub && shipped.length === l.composite.length && shipped.startsWith(l.base)) : undefined;
    if (sibling) {
      consider({ ...base, outcome: 'near', value: sibling.display, provenance: 'linked_record',
        message: `This certificate is lot ${sibling.display}; order ${order.order_number} shipped ${line.lot_number} on line ${name} — the same lot, a different sublot.` });
    }
  }
  if (best) return best;
  const shippedLots = order.lines.map((l) => l.lot_number).filter(Boolean);
  return {
    ...base, outcome: 'mismatch', value: docLots.map((l) => l.display).join(', ') || null, provenance: null,
    message: `Not linked to order ${order.order_number}${shippedLots.length ? `, and none of its lots is ${shippedLots.join(' / ')}` : ''}.`,
  };
}
