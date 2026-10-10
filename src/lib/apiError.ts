/**
 * What `fetchApi` (src/lib/api.ts) throws for a non-2xx answer.
 *
 * Still an `Error` whose message is the server's sentence, so every existing
 * `err.message` reader is unchanged; the status, the server's `code` and the
 * parsed body ride along for the callers that have to tell one refusal from
 * another (a 409 `duplicate_concept` carries the row it duplicates).
 *
 * In its own file so a component can import the class without importing the
 * whole API client -- which most component tests replace with a mock.
 */
export class ApiError extends Error {
  status: number;
  code?: string;
  body?: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    const code = (body as { code?: unknown } | undefined)?.code;
    if (typeof code === 'string') this.code = code;
  }
}
