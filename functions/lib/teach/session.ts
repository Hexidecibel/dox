/**
 * Shared loaders/serializers for teach sessions. Keeps the route handlers thin
 * and consistent (tenant scoping, message ordering, JSON parsing).
 */

import type {
  TeachSession,
  TeachMessage,
  TeachProposal,
} from '../../../shared/types';

export interface TeachSessionRow {
  id: string;
  tenant_id: string;
  supplier_id: string;
  document_type_id: string;
  status: string;
  issues_json: string | null;
  proposed_instructions: string | null;
  proposed_examples_json: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TeachMessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  grounding_json: string | null;
  created_at: string;
}

/** Fetch a session row scoped to the tenant. Returns null when not found. */
export async function loadSessionRow(
  db: D1Database,
  sessionId: string,
  tenantId: string,
): Promise<TeachSessionRow | null> {
  return db
    .prepare(
      `SELECT id, tenant_id, supplier_id, document_type_id, status, issues_json,
              proposed_instructions, proposed_examples_json, created_by,
              created_at, updated_at
       FROM teach_sessions WHERE id = ? AND tenant_id = ?`,
    )
    .bind(sessionId, tenantId)
    .first<TeachSessionRow>();
}

/** Fetch the full transcript for a session, oldest first. */
export async function loadMessages(
  db: D1Database,
  sessionId: string,
): Promise<TeachMessageRow[]> {
  const res = await db
    .prepare(
      `SELECT id, session_id, role, content, grounding_json, created_at
       FROM teach_messages WHERE session_id = ? ORDER BY created_at ASC, id ASC`,
    )
    .bind(sessionId)
    .all<TeachMessageRow>();
  return res.results ?? [];
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function serializeSession(row: TeachSessionRow): TeachSession {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    supplier_id: row.supplier_id,
    document_type_id: row.document_type_id,
    status: row.status as TeachSession['status'],
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function serializeMessage(row: TeachMessageRow): TeachMessage {
  return {
    id: row.id,
    session_id: row.session_id,
    role: row.role as TeachMessage['role'],
    content: row.content,
    grounding: parseJson(row.grounding_json),
    created_at: row.created_at,
  };
}

export function parseIssues(row: TeachSessionRow): unknown[] {
  const issues = parseJson<unknown[]>(row.issues_json);
  return Array.isArray(issues) ? issues : [];
}

export function parseProposal(row: TeachSessionRow): TeachProposal | null {
  if (row.proposed_instructions == null && row.proposed_examples_json == null) {
    return null;
  }
  const examples = parseJson<TeachProposal['examples']>(row.proposed_examples_json);
  return {
    instructions: row.proposed_instructions ?? '',
    examples: Array.isArray(examples) ? examples : [],
    summary: '',
  };
}

/** Insert a transcript message, returning its id. */
export async function insertMessage(
  db: D1Database,
  id: string,
  sessionId: string,
  role: 'ai' | 'sme' | 'system',
  content: string,
  grounding?: unknown,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO teach_messages (id, session_id, role, content, grounding_json, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    )
    .bind(id, sessionId, role, content, grounding == null ? null : JSON.stringify(grounding))
    .run();
}

/** Resolve the tenant for a teach request, mirroring extraction-instructions. */
export function resolveTenantId(
  user: { role: string; tenant_id: string | null },
  explicit?: string | null,
): string | null {
  if (user.role === 'super_admin') return explicit ?? null;
  return user.tenant_id;
}
