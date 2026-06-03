// === Connector Output Types ===
//
// The pure {orders[], customers[], errors[]} output shapes live in
// shared/connectorOutput.ts so the standalone Node extraction worker can import
// the exact same types. Re-exported here so existing importers of this module
// (queue-approve, order producer, tests) are unaffected.
export type {
  ParsedOrder,
  ParsedOrderItem,
  ParsedContact,
  ParsedCustomer,
  ConnectorError,
  ConnectorOutput,
} from '../../../shared/connectorOutput';

// === Intake Door Taxonomy ===

/**
 * Closed taxonomy of intake doors. Stored verbatim on `connector_runs.source`
 * (migration 0049) so the activity feed + audit surfaces can group runs by
 * their entry point. The DB column is plain TEXT (nullable) so future doors
 * don't need a migration; this type is the contract callers code against.
 *
 * (Previously defined on the now-deleted synchronous orchestrator; moved here
 * when the synchronous connector engine was removed in the Connectors → Sources
 * unification. The run-header helper and the retry endpoint still depend on it.)
 */
export type ConnectorRunSource =
  | 'manual'
  | 'api'
  | 'email'
  | 'webhook'
  | 'r2_poll'
  | 's3'
  | 'public_link'
  | 'api_poll';
