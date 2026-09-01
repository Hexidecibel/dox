/**
 * The document API client's registry-facet passthrough (migration 0080).
 *
 * cfb1b5e taught POST /api/documents/ingest and PUT /api/documents/:id to
 * accept `requirements` and `claims`; nothing in the client sent them, so the
 * junctions filled only for direct API callers. These tests pin the wire shape
 * — the field NAMES and the JSON encoding — because a silent rename here puts
 * the layer straight back to empty with no type error and no failing endpoint
 * test to catch it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { api } from './api';

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api.documents.ingest — facet passthrough', () => {
  it('sends requirements and claims as JSON form fields', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ document: { id: 'doc_1' }, created: true }));

    await api.documents.ingest({
      file: new File(['x'], 'coa.pdf', { type: 'application/pdf' }),
      tenantId: 'tenant_1',
      title: 'COA',
      categories: ['dt_1'],
      requirements: [{ id: 'req_a', status: 'confirmed', source: 'human' }],
      claims: [{ id: 'ct_1', status: 'confirmed', source: 'human' }],
    });

    const [, init] = fetchMock.mock.calls[0];
    const form = init.body as FormData;
    expect(JSON.parse(form.get('requirements') as string)).toEqual([
      { id: 'req_a', status: 'confirmed', source: 'human' },
    ]);
    expect(JSON.parse(form.get('claims') as string)).toEqual([
      { id: 'ct_1', status: 'confirmed', source: 'human' },
    ]);
    // Additive: the retired document_categories write still fires, because
    // 0079's documents_fts_source view reads that table.
    expect(JSON.parse(form.get('categories') as string)).toEqual(['dt_1']);
  });

  it('omits both fields entirely when the caller says nothing', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ document: { id: 'doc_1' }, created: true }));

    await api.documents.ingest({
      file: new File(['x'], 'coa.pdf', { type: 'application/pdf' }),
      tenantId: 'tenant_1',
    });

    const form = fetchMock.mock.calls[0][1].body as FormData;
    // An absent field leaves existing links alone; sending "[]" would clear
    // them. The two must not be conflated.
    expect(form.has('requirements')).toBe(false);
    expect(form.has('claims')).toBe(false);
  });
});

describe('api.documents.update — facet passthrough', () => {
  it('puts the link arrays through in the JSON body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ document: { id: 'doc_1', tags: '[]' } }));

    await api.documents.update('doc_1', {
      requirements: [{ id: 'req_a', status: 'confirmed' }],
      claims: [{ id: 'ct_1', status: 'rejected' }],
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/documents/doc_1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({
      requirements: [{ id: 'req_a', status: 'confirmed' }],
      claims: [{ id: 'ct_1', status: 'rejected' }],
    });
  });

  it('sends an empty array verbatim so clearing every box clears the rows', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ document: { id: 'doc_1', tags: '[]' } }));

    await api.documents.update('doc_1', { requirements: [], claims: [] });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ requirements: [], claims: [] });
  });
});

describe('api.documents.get — facet links on the way back', () => {
  it('surfaces the joined link sets the endpoint returns', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        document: {
          id: 'doc_1',
          tags: '[]',
          requirements: [
            { id: 'dr_1', requirement_id: 'req_a', status: 'suggested', vocab_name: 'Allergen Matrix' },
          ],
          claims: [{ id: 'dc_1', claim_type_id: 'ct_1', status: 'confirmed', vocab_name: 'Organic' }],
        },
      }),
    );

    const doc = await api.documents.get('doc_1');
    expect(doc.requirements).toHaveLength(1);
    expect(doc.requirements?.[0]).toMatchObject({ requirement_id: 'req_a', status: 'suggested' });
    expect(doc.claims?.[0]).toMatchObject({ claim_type_id: 'ct_1', status: 'confirmed' });
  });

  it('falls back to empty arrays for a response that predates the facets', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ document: { id: 'doc_1', tags: '[]' } }));

    const doc = await api.documents.get('doc_1');
    expect(doc.requirements).toEqual([]);
    expect(doc.claims).toEqual([]);
  });
});
