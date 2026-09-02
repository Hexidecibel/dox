/**
 * /api/notes — list and post notes against any record (migration 0088).
 *
 * Role gating, tenant scoping and audit calls follow
 * /api/supplier-requirements (cfb1b5e). The one shape difference is that a note
 * has a POLYMORPHIC parent, so where that route calls assertInTenant with two
 * concrete tables, this one goes through functions/lib/notes.ts — which is what
 * keeps a tenant from hanging a note off another tenant's record.
 *
 * THERE IS NO PUT. Notes are append-only; see the migration for why. A
 * correction is another note.
 */

import { generateId, logAudit, getClientIp } from '../../lib/db';
import { requireRole, BadRequestError, errorToResponse } from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import { assertNoteParent, isValidNoteEntityType, NOTE_ENTITY_TYPES } from '../../lib/notes';
import type { Env, User } from '../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * A note body is capped so one paste cannot make a record page unloadable.
 * Generous enough for a pasted email thread, which is the realistic worst case.
 */
const MAX_NOTE_LENGTH = 10000;

/**
 * GET /api/notes?entity_type=supplier&entity_id=...
 *
 * Both params are required: this endpoint reads the notes ON a record, and a
 * tenant-wide "every note ever" listing is a different (reporting) question
 * that would need its own pagination story and its own permission argument.
 *
 * ?include_deleted=1  org_admin/super_admin only — retracted notes are kept
 *                     (soft delete) precisely so an admin can still see them.
 * ?tenant_id=         super_admin only.
 *
 * Newest first, matching idx_entity_notes_entity exactly.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);
    const entityType = url.searchParams.get('entity_type');
    const entityId = url.searchParams.get('entity_id');
    const tenantIdParam = url.searchParams.get('tenant_id');
    const includeDeleted = url.searchParams.get('include_deleted') === '1';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    if (!entityType) return json({ error: 'entity_type is required' }, 400);
    if (!entityId) return json({ error: 'entity_id is required' }, 400);
    if (!isValidNoteEntityType(entityType)) {
      return json(
        { error: `entity_type must be one of: ${NOTE_ENTITY_TYPES.join(', ')}` },
        400,
      );
    }

    // Resolve the tenant BEFORE touching entity_notes. A super_admin may name
    // one; everyone else is pinned to their own and cannot widen it.
    let tenantId: string;
    if (user.role === 'super_admin') {
      if (!tenantIdParam) {
        return json({ error: 'tenant_id is required for super_admin' }, 400);
      }
      tenantId = tenantIdParam;
    } else {
      tenantId = user.tenant_id!;
    }

    // Proving the PARENT is in this tenant is what makes the read safe. Without
    // it, a caller could ask for notes on an id belonging to another tenant;
    // the tenant_id filter below would return nothing, but only by accident of
    // the write path having been correct.
    await assertNoteParent(context.env.DB, tenantId, entityType, entityId);

    // Retracted notes are visible to admins only. A reader seeing a retracted
    // note would defeat the point of retracting it; an admin NOT seeing it
    // would defeat the point of keeping it.
    const canSeeDeleted =
      includeDeleted && (user.role === 'super_admin' || user.role === 'org_admin');
    const deletedClause = canSeeDeleted ? '' : ' AND n.deleted_at IS NULL';

    const params = [tenantId, entityType, entityId];

    const countResult = await context.env.DB.prepare(
      `SELECT COUNT(*) as total
         FROM entity_notes n
        WHERE n.tenant_id = ? AND n.entity_type = ? AND n.entity_id = ?${deletedClause}`,
    )
      .bind(...params)
      .first<{ total: number }>();

    // Author name/email joined in so a thread renders without N round trips.
    const results = await context.env.DB.prepare(
      `SELECT n.*,
              u.name  AS author_name,
              u.email AS author_email,
              d.name  AS deleted_by_name
         FROM entity_notes n
         LEFT JOIN users u ON u.id = n.author_id
         LEFT JOIN users d ON d.id = n.deleted_by
        WHERE n.tenant_id = ? AND n.entity_type = ? AND n.entity_id = ?${deletedClause}
        -- rowid, not id, as the tiebreak. created_at is datetime('now') —
        -- one-second granularity — so two notes posted in the same second tie,
        -- and n.id is random hex, which would order them arbitrarily and
        -- differently on each read. rowid is monotonic with INSERT, so this is
        -- insertion order, which is what a thread means. It is also free: D1
        -- appends rowid to every index entry, so idx_entity_notes_entity
        -- already carries this sort and the whole ORDER BY reads off it.
        ORDER BY n.created_at DESC, n.rowid DESC
        LIMIT ? OFFSET ?`,
    )
      .bind(...params, limit, offset)
      .all();

    return json({
      notes: results.results,
      total: countResult?.total || 0,
      limit,
      offset,
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List notes error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

/**
 * POST /api/notes
 * Body: entity_type, entity_id, body, tenant_id? (super_admin only).
 *
 * NOT idempotent, unlike the supplier-requirements attach it otherwise mirrors.
 * Posting the same text twice yields two notes, because two notes is what
 * happened: an applicability row states a fact that is either true or not, a
 * note records an utterance and people do repeat themselves.
 *
 * Gated at canUpload level (super_admin | org_admin | user) rather than
 * admin-only: writing a note is ordinary work for the people who handle
 * documents. `reader` is excluded — the role is read-only by definition, and a
 * note is a durable, attributed, unerasable record.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const body = (await context.request.json()) as {
      entity_type?: string;
      entity_id?: string;
      body?: string;
      tenant_id?: string;
    };

    if (!body.entity_type) return json({ error: 'entity_type is required' }, 400);
    if (!body.entity_id) return json({ error: 'entity_id is required' }, 400);

    const text = typeof body.body === 'string' ? sanitizeString(body.body) : '';
    if (!text) throw new BadRequestError('body is required');
    if (text.length > MAX_NOTE_LENGTH) {
      throw new BadRequestError(`body must be ${MAX_NOTE_LENGTH} characters or fewer`);
    }

    let tenantId: string;
    if (user.role === 'super_admin') {
      if (!body.tenant_id) throw new BadRequestError('tenant_id is required for super_admin');
      tenantId = body.tenant_id;
    } else {
      tenantId = user.tenant_id!;
    }

    const entityType = await assertNoteParent(
      context.env.DB,
      tenantId,
      body.entity_type,
      body.entity_id,
    );

    const id = generateId();
    await context.env.DB.prepare(
      `INSERT INTO entity_notes (id, tenant_id, entity_type, entity_id, body, author_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, tenantId, entityType, body.entity_id, text, user.id)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'note_created',
      'entity_note',
      id,
      JSON.stringify({ entity_type: entityType, entity_id: body.entity_id }),
      getClientIp(context.request),
    );

    const created = await context.env.DB.prepare(
      `SELECT n.*, u.name AS author_name, u.email AS author_email
         FROM entity_notes n
         LEFT JOIN users u ON u.id = n.author_id
        WHERE n.id = ?`,
    )
      .bind(id)
      .first();

    return json({ note: created }, 201);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Create note error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
