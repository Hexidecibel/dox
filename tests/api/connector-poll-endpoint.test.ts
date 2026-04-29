/**
 * Tests for `POST /api/connectors/poll` — the bearer-auth endpoint
 * driven by the companion `dox-connector-poller` Worker.
 *
 * Coverage:
 *  - Missing CONNECTOR_POLL_TOKEN env var -> 401 (fail-closed).
 *  - Missing Authorization header -> 401.
 *  - Wrong bearer value -> 401.
 *  - Correct bearer value -> 200 with poll summary.
 *  - GET method -> 405.
 */

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  onRequestPost as pollPost,
  onRequestGet as pollGet,
} from '../../functions/api/connectors/poll';

function makeContext(request: Request, overrideEnv?: Record<string, unknown>) {
  return {
    request,
    env: { ...env, ...(overrideEnv ?? {}) },
    data: {},
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/connectors/poll',
  } as any;
}

describe('POST /api/connectors/poll — bearer auth', () => {
  it('returns 401 when CONNECTOR_POLL_TOKEN is unset on the env', async () => {
    const req = new Request('http://localhost/api/connectors/poll', {
      method: 'POST',
      headers: { authorization: 'Bearer anything' },
    });
    const resp = await pollPost(makeContext(req, { CONNECTOR_POLL_TOKEN: undefined }));
    expect(resp.status).toBe(401);
  });

  it('returns 401 when the Authorization header is missing', async () => {
    const req = new Request('http://localhost/api/connectors/poll', {
      method: 'POST',
    });
    const resp = await pollPost(makeContext(req, { CONNECTOR_POLL_TOKEN: 'secret-poll-token' }));
    expect(resp.status).toBe(401);
  });

  it('returns 401 when the bearer value does not match', async () => {
    const req = new Request('http://localhost/api/connectors/poll', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-value' },
    });
    const resp = await pollPost(makeContext(req, { CONNECTOR_POLL_TOKEN: 'secret-poll-token' }));
    expect(resp.status).toBe(401);
  });

  it('returns 200 with a summary when the bearer matches', async () => {
    const req = new Request('http://localhost/api/connectors/poll', {
      method: 'POST',
      headers: { authorization: 'Bearer secret-poll-token' },
    });
    const resp = await pollPost(makeContext(req, { CONNECTOR_POLL_TOKEN: 'secret-poll-token' }));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('connectors_checked');
    expect(body).toHaveProperty('total_dispatched');
    expect(body).toHaveProperty('per_connector');
  });

  it('returns 405 for GET', async () => {
    const req = new Request('http://localhost/api/connectors/poll', {
      method: 'GET',
    });
    const resp = await pollGet(makeContext(req, { CONNECTOR_POLL_TOKEN: 'secret-poll-token' }));
    expect(resp.status).toBe(405);
  });
});
