/**
 * Friendly labels for a Source's origin × output identity.
 *
 * A Source (formerly "connector") is described by two orthogonal facets:
 *   - origin_kind:  where the documents come from. 'supplier' = an upstream
 *                   vendor delivers them; 'internal' = produced inside the org
 *                   (e.g. the WMS/ERP exporting order or shipment reports).
 *   - output_kind:  what kind of record the producer emits — 'coa' (a
 *                   certificate), 'order' (order + customer records), or
 *                   'shipment' (WMS order→lot bindings).
 *
 * Surfaced wherever a Source is displayed (the Sources list + SourceDetail)
 * as e.g. "Supplier · COA", "Internal · Order Report", "Internal · Shipment".
 */

export type OriginKind = 'supplier' | 'internal' | string | null | undefined;
export type OutputKind = 'coa' | 'order' | 'shipment' | string | null | undefined;

/** Human label for the origin facet. Falls back to a title-cased raw value. */
export function originLabel(origin: OriginKind): string {
  switch (origin) {
    case 'supplier':
      return 'Supplier';
    case 'internal':
      return 'Internal';
    default:
      return titleCase(origin) || 'Source';
  }
}

/** Human label for the output facet. */
export function outputLabel(output: OutputKind): string {
  switch (output) {
    case 'coa':
      return 'COA';
    case 'order':
      return 'Order Report';
    case 'shipment':
      return 'Shipment';
    default:
      return titleCase(output) || 'Document';
  }
}

/**
 * Combined "Origin · Output" label, e.g. "Supplier · COA",
 * "Internal · Order Report", "Internal · Shipment".
 */
export function sourceKindLabel(origin: OriginKind, output: OutputKind): string {
  return `${originLabel(origin)} · ${outputLabel(output)}`;
}

function titleCase(v: string | null | undefined): string {
  if (!v) return '';
  return v.charAt(0).toUpperCase() + v.slice(1);
}
