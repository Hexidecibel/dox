/**
 * COMPAT SHIM — POST/GET /api/connectors/:id/drop
 *
 * The connector subsystem was rebranded "Sources" and its API moved to
 * `/api/sources/*`. This single endpoint is the one with an external
 * contract: vendor automations POST files here with a per-source bearer
 * token. To avoid breaking those integrations we keep the legacy path
 * alive as a thin re-export of the canonical handler at
 * `functions/api/sources/[id]/drop.ts`.
 *
 * NOTE: only `drop` is shimmed. Every other former `/api/connectors/*`
 * endpoint is internal-only (driven by our own frontend) and was moved
 * outright to `/api/sources/*` with no compat path.
 *
 * The legacy path stays allowlisted in `functions/api/_middleware.ts`
 * (PUBLIC_ROUTE_PATTERNS) so it bypasses the JWT gate just like the new
 * one — the bearer-token check inside the handler is the real gate.
 */
export { onRequestPost, onRequestGet } from '../../sources/[id]/drop';
