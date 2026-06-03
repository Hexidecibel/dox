/**
 * POST /api/teach/sessions/:id/confirm
 *
 * Write the (optionally SME-edited) proposal to the (supplier, document_type)
 * extraction profile:
 *   - upsert supplier_extraction_instructions.instructions (field_mappings
 *     preserved — same ON CONFLICT path as PUT /api/extraction-instructions)
 *   - insert one extraction_examples row per proposed example
 * Flips the session to 'confirmed', logs audit, returns ok.
 *
 * Body: { instructions?: string, examples?: { field, value, note }[], tenant_id? }
 * Auth: super_admin, org_admin, user.
 */

import { generateId, logAudit, getClientIp } from '../../../../lib/db';
import {
  requireRole,
  BadRequestError,
  NotFoundError,
  errorToResponse,
} from '../../../../lib/permissions';
import type { Env, User } from '../../../../lib/types';
import type { TeachExample } from '../../../../shared/types';
import {
  loadSessionRow,
  resolveTenantId,
  parseProposal,
} from '../../../../lib/teach/session';

const MAX_INSTRUCTIONS_LENGTH = 8000;

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const sessionId = context.params.id as string;
    const body = (await context.request.json().catch(() => ({}))) as {
      instructions?: string;
      examples?: TeachExample[];
      tenant_id?: string;
    };

    const tenantId = resolveTenantId(user, body.tenant_id);
    if (!tenantId) throw new NotFoundError('Session not found');

    const row = await loadSessionRow(context.env.DB, sessionId, tenantId);
    if (!row) throw new NotFoundError('Session not found');
    if (row.status === 'confirmed') {
      throw new BadRequestError('Session already confirmed');
    }

    // Resolve the final instructions + examples: SME edits override the stored
    // proposal.
    const stored = parseProposal(row);
    const instructions = (
      typeof body.instructions === 'string' ? body.instructions : stored?.instructions ?? ''
    ).trim();
    if (!instructions) {
      throw new BadRequestError('No instructions to write — synthesize first or provide instructions');
    }
    if (instructions.length > MAX_INSTRUCTIONS_LENGTH) {
      throw new BadRequestError(`instructions too long (max ${MAX_INSTRUCTIONS_LENGTH} chars)`);
    }
    const examples: TeachExample[] = Array.isArray(body.examples)
      ? body.examples
      : stored?.examples ?? [];

    // 1. Upsert supplier_extraction_instructions — same ON CONFLICT path as
    //    PUT /api/extraction-instructions. field_mappings is preserved via the
    //    self-referencing clause (no mappings supplied here).
    const newId = generateId();
    await context.env.DB.prepare(
      `INSERT INTO supplier_extraction_instructions
         (id, supplier_id, document_type_id, tenant_id, instructions, field_mappings, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, datetime('now'), datetime('now'))
       ON CONFLICT(supplier_id, document_type_id) DO UPDATE SET
         instructions  = excluded.instructions,
         field_mappings = supplier_extraction_instructions.field_mappings,
         updated_by    = excluded.updated_by,
         updated_at    = datetime('now')`,
    )
      .bind(newId, row.supplier_id, row.document_type_id, tenantId, instructions, user.id)
      .run();

    // 2. Insert extraction_examples rows for the supplier/doctype. We store the
    //    distilled field/value/note as the corrected_output (the few-shot loop
    //    reads corrected_output as the target). input_text carries the SME's
    //    natural-language note so the example is self-describing.
    let written = 0;
    for (const ex of examples) {
      if (!ex || !ex.field) continue;
      const exId = generateId();
      const correctedOutput = JSON.stringify({ fields: { [ex.field]: ex.value ?? '' } });
      const inputText = ex.note?.trim()
        ? `Learned via teach session: ${ex.note.trim()}`
        : `Learned via teach session (field ${ex.field})`;
      await context.env.DB.prepare(
        `INSERT INTO extraction_examples
           (id, document_type_id, tenant_id, input_text, ai_output, corrected_output, score, supplier, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          exId,
          row.document_type_id,
          tenantId,
          inputText,
          '{}',
          correctedOutput,
          null,
          row.supplier_id,
          user.id,
        )
        .run();
      written++;
    }

    // 3. Flip the session to confirmed (persist the final edited proposal).
    await context.env.DB.prepare(
      `UPDATE teach_sessions
         SET status = 'confirmed',
             proposed_instructions = ?,
             proposed_examples_json = ?,
             updated_at = datetime('now')
       WHERE id = ?`,
    )
      .bind(instructions, JSON.stringify(examples), sessionId)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'teach_session_confirmed',
      'teach_session',
      sessionId,
      JSON.stringify({
        supplier_id: row.supplier_id,
        document_type_id: row.document_type_id,
        instructions_length: instructions.length,
        examples_written: written,
      }),
      getClientIp(context.request),
    );

    return new Response(
      JSON.stringify({ ok: true, session_id: sessionId, examples_written: written }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Teach confirm error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
