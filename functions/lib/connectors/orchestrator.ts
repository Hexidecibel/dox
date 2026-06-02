import { generateId, logAudit, logIntakeEvent } from '../db';
import type { ConnectorContext, ConnectorOutput, ConnectorInput } from './types';
import { getConnectorExecutor } from './index';
import { normalizeFieldMappings } from '../../../shared/fieldMappings';
import { ingestOrders } from '../kinds/order';

/**
 * Universal-doors orchestrator (Phase B0). The connector row no longer
 * carries a per-type tag — every connector exposes every intake door.
 * Dispatch is keyed off `input.type` (the path-of-entry discriminant on
 * `ConnectorInput`). Once a file/payload is in hand, the parse →
 * orders/customers → audit tail is identical for every door.
 */
interface OrchestratorParams {
  db: D1Database;
  r2?: R2Bucket;
  tenantId: string;
  connectorId: string;
  config: Record<string, unknown>;
  /**
   * Raw field_mappings blob read from the connectors table. Accepted in any
   * legacy shape and normalized to v2 internally — callers don't need to
   * preprocess.
   */
  fieldMappings: unknown;
  credentials?: Record<string, unknown>;
  input: ConnectorInput;
  userId?: string;
  qwenUrl?: string;
  qwenSecret?: string;
  /**
   * R2.b: connector-level reviewer guidance loaded from the connector row's
   * `extraction_instructions` column. Forwarded into the ConnectorContext so
   * the parsing executor can prepend it to the Qwen prompt. Undefined or
   * empty means no guidance — parser uses the static prompt unchanged.
   */
  extractionInstructions?: string;
  /**
   * Intake door this run came in through. Stored on `connector_runs.source`
   * (migration 0049) so the activity feed + audit surfaces can group runs
   * by their entry point. When omitted we fall back to deriving from
   * `input.type` — the discriminator on the input is a coarse but accurate
   * proxy. Callers that want a more specific tag (e.g. 'api' vs 'manual'
   * for two doors that both produce file_watch input) MUST pass `source`
   * explicitly.
   */
  source?: ConnectorRunSource;
}

/**
 * Closed taxonomy of intake doors. The DB column is plain TEXT (nullable)
 * so future doors don't need a migration; this type is the contract callers
 * should code against.
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

function deriveSource(input: ConnectorInput, override?: ConnectorRunSource): ConnectorRunSource {
  if (override) return override;
  switch (input.type) {
    case 'email': return 'email';
    case 'webhook': return 'webhook';
    case 'api_poll': return 'api_poll';
    case 'file_watch': return 'manual';
    default: return 'manual';
  }
}

/**
 * Pull the best-effort file_name + file_size pair out of a ConnectorInput
 * for the audit row. The orchestrator handles every door; what counts as
 * "the file" varies by input type:
 *   - file_watch  : the inline filename + content byteLength (or r2Key
 *                   basename when bytes ride out-of-band)
 *   - email       : "<subject>" + total attachment byte count (sender
 *                   goes in the `extra` blob upstream)
 *   - webhook     : null / null — payload is structured, not a file
 *   - api_poll    : null / null — pull-based, no inbound payload
 */
function describeIntakePayload(
  input: ConnectorInput,
): { fileName: string | null; fileSize: number | null } {
  switch (input.type) {
    case 'file_watch': {
      const fileName =
        input.fileName ||
        (input.r2Key ? input.r2Key.split('/').pop() ?? null : null);
      const fileSize = input.content ? input.content.byteLength : null;
      return { fileName, fileSize };
    }
    case 'email': {
      const totalSize = (input.attachments || []).reduce(
        (acc, att) => acc + (att.size ?? 0),
        0,
      );
      return {
        fileName: input.subject || null,
        fileSize: totalSize > 0 ? totalSize : null,
      };
    }
    case 'webhook':
    case 'api_poll':
    default:
      return { fileName: null, fileSize: null };
  }
}

export interface OrchestratorResult {
  runId: string;
  status: 'success' | 'partial' | 'error';
  ordersCreated: number;
  customersCreated: number;
  errors: string[];
}

export async function executeConnectorRun(params: OrchestratorParams): Promise<OrchestratorResult> {
  const {
    db, r2, tenantId, connectorId,
    config, fieldMappings, credentials, input, userId,
    qwenUrl, qwenSecret, source, extractionInstructions,
  } = params;

  const runId = generateId();
  const runSource = deriveSource(input, source);

  // Create run record. `source` is stored verbatim so a B5-era activity
  // feed can group runs by their door without re-deriving from input
  // metadata. Older D1 instances that haven't applied migration 0049
  // will throw 'no such column: source' here; the catch below downgrades
  // to a sourceless insert so a half-migrated env stays runnable.
  try {
    await db.prepare(
      `INSERT INTO connector_runs (id, connector_id, tenant_id, status, source)
       VALUES (?, ?, ?, 'running', ?)`
    ).bind(runId, connectorId, tenantId, runSource).run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('no such column')) {
      await db.prepare(
        `INSERT INTO connector_runs (id, connector_id, tenant_id, status)
         VALUES (?, ?, ?, 'running')`
      ).bind(runId, connectorId, tenantId).run();
    } else {
      throw err;
    }
  }

  let output: ConnectorOutput;

  try {
    // Dispatch by the runtime intake path. The same connector row can be
    // driven from any door — so the executor lookup uses input.type, not
    // a per-row tag.
    const executor = getConnectorExecutor(input.type);
    // Normalize the stored field_mappings blob into the v2 shape once per
    // run. The email executor, parseCSVAttachment, and parseWithAI all rely
    // on ctx.fieldMappings being v2.
    const normalizedMappings = normalizeFieldMappings(fieldMappings);
    const ctx: ConnectorContext = {
      db, r2, tenantId, connectorId, config,
      fieldMappings: normalizedMappings,
      credentials,
      qwenUrl, qwenSecret,
      extractionInstructions,
    };

    output = await executor(ctx, input);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await db.prepare(
      `UPDATE connector_runs SET status = 'error', error_message = ?, completed_at = datetime('now')
       WHERE id = ?`
    ).bind(errorMsg, runId).run();

    await db.prepare(
      `UPDATE connectors SET last_run_at = datetime('now'), last_error = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).bind(errorMsg, connectorId).run();

    // Phase B5 — emit an intake audit row even on the early-error path so
    // every dispatch (whether the executor blew up or the run completed
    // cleanly) leaves a uniform breadcrumb. Best-effort: helper swallows
    // its own failures.
    {
      const { fileName, fileSize } = describeIntakePayload(input);
      await logIntakeEvent({
        db,
        tenantId,
        connectorId,
        runId,
        source: runSource,
        actorUserId: userId ?? null,
        fileName,
        fileSize,
        runStatus: 'error',
        errorMessage: errorMsg,
      });
    }

    return { runId, status: 'error', ordersCreated: 0, customersCreated: 0, errors: [errorMsg] };
  }

  // Producer dispatch (Phase P2): hand the parsed customers/orders to the
  // `order` doc-kind producer, which owns every canonical-entity write
  // (customers, customer_contacts, orders, order_items + product/lot
  // resolution + COA linkage) and the stage-vs-commit routing. It mutates
  // `output.errors` in place and returns the rollup counts the run record
  // needs.
  const { ordersCreated, ordersStaged, customersCreated } = await ingestOrders(
    db,
    output,
    { tenantId, connectorId, connectorRunId: runId },
  );

  // Determine final status. `info[]` is purely informational (processing
  // summaries, skipped-sheet notices, etc.) and must NOT count toward the
  // error tally or the partial/success decision.
  const totalRecords = output.orders.length + output.customers.length;
  const errorCount = output.errors.length;
  const infoMessages = output.info || [];
  const status = errorCount === 0 ? 'success' : (ordersCreated > 0 || customersCreated > 0) ? 'partial' : 'error';

  // Update run record. `records_staged` is the subset of created orders
  // routed to human review because their LLM confidence fell below the
  // staging threshold; it's a subset of records_created, not in addition
  // to it.
  await db.prepare(
    `UPDATE connector_runs SET
     status = ?, completed_at = datetime('now'),
     records_found = ?, records_created = ?, records_updated = ?, records_errored = ?,
     records_staged = ?,
     error_message = ?, details = ?
     WHERE id = ?`
  ).bind(
    status,
    totalRecords,
    ordersCreated + customersCreated,
    // Clamp to zero: on a failed run totalRecords can be 0 while errorCount
    // is positive, which would otherwise produce a negative updated count.
    Math.max(0, totalRecords - ordersCreated - customersCreated - errorCount),
    errorCount,
    ordersStaged,
    errorCount > 0 ? output.errors.map(e => e.message).join('; ') : null,
    JSON.stringify({ errors: output.errors, info: infoMessages }),
    runId
  ).run();

  // Update connector last_run
  await db.prepare(
    `UPDATE connectors SET last_run_at = datetime('now'), last_error = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).bind(
    status === 'error' ? output.errors.map(e => e.message).join('; ') : null,
    connectorId
  ).run();

  // Audit log — preserve the legacy `connector.run` row on user-initiated
  // runs so downstream consumers that key off that action keep working.
  if (userId) {
    await logAudit(db, userId, tenantId, 'connector.run', 'connector', connectorId,
      JSON.stringify({
        run_id: runId,
        status,
        source: runSource,
        orders_created: ordersCreated,
        customers_created: customersCreated,
      }), null);
  }

  // Phase B5 — uniform intake row for every door. Vendor-driven runs
  // (api / s3 / public_link / email) carry actorUserId=null; the
  // manual door is the only path that has a real admin id.
  {
    const { fileName, fileSize } = describeIntakePayload(input);
    const extra: Record<string, unknown> = {
      orders_created: ordersCreated,
      customers_created: customersCreated,
    };
    if (input.type === 'email') {
      extra.sender = input.sender;
      extra.subject = input.subject;
    }
    await logIntakeEvent({
      db,
      tenantId,
      connectorId,
      runId,
      source: runSource,
      actorUserId: userId ?? null,
      fileName,
      fileSize,
      runStatus: status,
      errorMessage:
        status === 'success'
          ? null
          : output.errors.map((e) => e.message).join('; ') || null,
      extra,
    });
  }

  return {
    runId,
    status,
    ordersCreated,
    customersCreated,
    errors: output.errors.map(e => e.message),
  };
}
