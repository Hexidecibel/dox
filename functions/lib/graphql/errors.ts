import { GraphQLError } from 'graphql';

/**
 * WHY THE GRAPHQL SURFACE NEEDED ITS OWN MASK
 *
 * `createYoga` masks every error a resolver throws down to "Unexpected error."
 * unless it is a `GraphQLError`. That is the right default — it is what stops a
 * D1 message, a stack frame or an internal id leaking to a caller — but the
 * resolvers throw the SAME permission errors the REST handlers do
 * (`ForbiddenError`, `NotFoundError`, `UnauthorizedError`, `BadRequestError`,
 * `ConflictError`, from functions/lib/permissions.ts), and REST answers those
 * with `errorToResponse`: the error's own message and its own status code.
 *
 * So the two surfaces disagreed about the same condition. A reader querying a
 * field they may not have, or asking for another tenant's document, got
 * "Unexpected error." over GraphQL and a 403 with "Access denied to this
 * tenant" over REST. That is worse than unhelpful on a permission boundary:
 * "Unexpected error." reads as OUR fault and invites a retry, where the honest
 * answer is that the request will never succeed. It also hid the only signal a
 * client has for telling a missing record from a forbidden one.
 *
 * WHAT THIS CHANGES AND WHAT IT DOES NOT
 *
 * ONLY the five deliberate, caller-facing errors are unmasked, and only their
 * message — which is already written to be read by a caller (the REST body is
 * literally `{ error: err.message }`). Everything else still masks: a thrown
 * `TypeError`, a D1 failure, a bug in a resolver all still come back as
 * "Unexpected error." with nothing of the original attached. The allow-list is
 * the point; the list is short and is the same list `errorToResponse` answers.
 *
 * `code` and `http.status` in the extensions mirror the REST status, so a
 * client can branch on the same fact over either transport, and yoga uses
 * `http.status` for the response status where the request is not partial.
 *
 * NOT `instanceof`. The check is the error's NAME plus a numeric `status`,
 * because these classes cross a module boundary and an `instanceof` that
 * silently starts failing would re-mask a permission error without anyone
 * noticing. The name is a property of the class this repo defines and is
 * asserted by tests/api/graphql-errors.test.ts.
 */

/** Name -> the code and HTTP status REST answers the same condition with. */
const PASS_THROUGH: Record<string, { code: string; status: number }> = {
  UnauthorizedError: { code: 'UNAUTHENTICATED', status: 401 },
  ForbiddenError: { code: 'FORBIDDEN', status: 403 },
  NotFoundError: { code: 'NOT_FOUND', status: 404 },
  BadRequestError: { code: 'BAD_REQUEST', status: 400 },
  ConflictError: { code: 'CONFLICT', status: 409 },
};

function passThroughFor(err: unknown): { code: string; status: number } | null {
  if (!(err instanceof Error)) return null;
  const entry = PASS_THROUGH[err.name];
  if (!entry) return null;
  // Both halves must agree. A class that merely borrowed the name, or one
  // whose status drifted from what REST answers, is not this contract.
  const status = (err as Error & { status?: unknown }).status;
  return typeof status === 'number' && status === entry.status ? entry : null;
}

/**
 * yoga's `maskError`: given whatever graphql-js surfaced, return the error the
 * client is allowed to see.
 *
 * graphql-js wraps a resolver throw in a `GraphQLError` whose `originalError`
 * is what was actually thrown, so the decision is made on `originalError`
 * first and on the error itself second (the same function is also called for
 * errors raised outside execution, where there is no wrapper).
 */
export function maskGraphQLError(error: unknown, message: string): Error {
  const wrapper = error instanceof GraphQLError ? error : null;
  const original = wrapper?.originalError ?? error;

  // A `GraphQLError` thrown deliberately — the module gate does this — already
  // says exactly what its author meant. Pass it through untouched, extensions
  // and all. This is yoga's own default behaviour and must survive the
  // override.
  if (original instanceof GraphQLError) return wrapper ?? (original as Error);

  const passThrough = passThroughFor(original);
  if (passThrough) {
    return new GraphQLError(
      (original as Error).message,
      wrapper
        ? {
            nodes: wrapper.nodes,
            source: wrapper.source,
            positions: wrapper.positions,
            path: wrapper.path,
            extensions: {
              ...wrapper.extensions,
              code: passThrough.code,
              http: { status: passThrough.status },
            },
          }
        : { extensions: { code: passThrough.code, http: { status: passThrough.status } } },
    );
  }

  // Everything else: the default mask. No original message, no stack, no
  // extensions from the thrown error — only the location in the query, which
  // is the client's own document and reveals nothing of ours.
  return new GraphQLError(message, {
    nodes: wrapper?.nodes,
    source: wrapper?.source,
    positions: wrapper?.positions,
    path: wrapper?.path,
    extensions: { code: 'INTERNAL_SERVER_ERROR' },
  });
}
