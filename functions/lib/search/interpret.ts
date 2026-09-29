/**
 * Reading identifying clauses out of typed text now lives in
 * shared/searchInterpret.ts (search redesign Phase 2): the browser runs the
 * same pure detector for its optimistic chips that the server runs to confirm
 * them, so the two cannot drift. This module keeps the old import path.
 */
export * from '../../../shared/searchInterpret';
